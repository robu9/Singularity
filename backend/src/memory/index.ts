import { getDb } from "../db/index.js";
import { buildGraphFromNeighbors, graphNodeToMemoryNode } from "./adapter.js";
import { getGraph, type GraphNode } from "./graph/index.js";
import {
  EVALUATION_PREFIX,
  ingestAudioChunk,
  ingestChatSession,
  ingestMeetingSummary,
  ingestScreenCapture,
  ingestUserMemory,
  linkFollows,
} from "./ingest.js";
import type { MemoryGraph, MemoryNode, MemoryStats } from "./types.js";

let initialized = false;

export function initMemory(): void {
  if (initialized) return;
  getGraph();
  initialized = true;
}

export function isMemoryInitialized(): boolean {
  return initialized;
}

function isEvaluationNode(node: GraphNode): boolean {
  return node.props.evaluation === true || node.key.includes(EVALUATION_PREFIX);
}

function textOf(node: GraphNode): string {
  return typeof node.props.text === "string"
    ? node.props.text
    : typeof node.props.content === "string"
      ? node.props.content
      : "";
}

/**
 * Assemble the memory portion of a chat prompt.
 *
 * Order matters: current facts first, then superseded facts (tagged so the
 * model must not treat them as live), then the episodes that best match the
 * question. When nothing matches, an explicit abstention instruction is
 * returned instead of an empty list so the model does not invent history.
 */
export async function retrieveContextForChat(
  query: string,
  charBudget = 24_000,
  includeEvaluation = false
): Promise<{ snippets: string[]; nodeIds: string[] }> {
  initMemory();

  const trimmed = query.trim();
  if (trimmed.length < 2) {
    return { snippets: [], nodeIds: [] };
  }

  try {
    const graph = getGraph();
    const snippets: string[] = [];
    const nodeIds: string[] = [];
    let budget = 0;

    const push = (snippet: string, id?: string) => {
      if (budget + snippet.length > charBudget) return false;
      snippets.push(snippet);
      if (id) nodeIds.push(id);
      budget += snippet.length;
      return true;
    };

    const visible = (node: GraphNode) => includeEvaluation || !isEvaluationNode(node);

    const currentFacts = graph
      .search(trimmed, { label: "Fact", where: { current: true }, limit: 40 })
      .map((hit) => hit.node)
      .filter(visible)
      .slice(0, 12);

    const superseded = graph
      .search(trimmed, { label: "Fact", where: { current: false }, limit: 40 })
      .map((hit) => hit.node)
      .filter(visible)
      .slice(0, 8);

    for (const node of currentFacts) {
      const text = textOf(node);
      if (!text) continue;
      const when =
        typeof node.props.valid_from === "string" ? node.props.valid_from.slice(0, 10) : "";
      if (!push(`[current${when ? ` ${when}` : ""}] ${text}`, node.key)) break;
    }

    for (const node of superseded) {
      const text = textOf(node);
      if (!text) continue;
      const from =
        typeof node.props.valid_from === "string" ? node.props.valid_from.slice(0, 10) : "";
      const to =
        typeof node.props.valid_to === "string" ? node.props.valid_to.slice(0, 10) : "";
      if (
        !push(
          `[superseded${from ? ` ${from}` : ""}${to ? ` → ${to}` : ""}] ${text} (later replaced; do not treat as current)`,
          node.key
        )
      ) {
        break;
      }
    }

    const episodes = graph
      .search(trimmed, { label: "Episode", limit: 40 })
      .map((hit) => hit.node)
      .filter(visible)
      .slice(0, 8);

    for (const node of episodes) {
      const memory = graphNodeToMemoryNode(node);
      if (!memory.content) continue;
      if (!push(formatNodeSnippet(memory), memory.id)) break;
    }

    if (snippets.length === 0) {
      push(
        "[abstain] No matching current fact or episode was found in memory. If the question depends on stored personal history, say you do not know. Do not invent an answer."
      );
    }

    return { snippets, nodeIds };
  } catch (err) {
    console.warn("[memory] retrieveContextForChat failed:", err);
    return { snippets: [], nodeIds: [] };
  }
}

/**
 * Index capture rows that predate the graph (or were written while ingest was
 * failing). Runs at startup; already-present episodes are skipped cheaply.
 */
export async function backfillMemory(): Promise<{ ingested: number }> {
  initMemory();
  const graph = getGraph();
  let ingested = 0;

  const ocrRows = getDb()
    .prepare(
      `SELECT o.frame_id, o.text, f.app_name, f.window_name, f.timestamp
       FROM ocr_text o
       JOIN frames f ON f.id = o.frame_id
       ORDER BY f.timestamp ASC
       LIMIT 2000`
    )
    .all() as Array<{
    frame_id: number;
    text: string;
    app_name: string | null;
    window_name: string | null;
    timestamp: string;
  }>;

  // Rows arrive in timestamp order, so chaining each to its predecessor builds
  // the FOLLOWS spine the graph is traversed by.
  let previousKey: string | null = null;

  for (const row of ocrRows) {
    const key = `frame_${row.frame_id}`;
    if (graph.hasNode(key)) {
      previousKey = key;
      continue;
    }
    const stored = ingestScreenCapture({
      frameId: row.frame_id,
      text: row.text,
      appName: row.app_name,
      windowName: row.window_name,
      timestamp: row.timestamp,
    });
    if (stored) {
      if (previousKey) linkFollows(previousKey, stored);
      previousKey = stored;
      ingested++;
    }
  }

  const audioRows = getDb()
    .prepare(
      `SELECT id, transcription, meeting_id, timestamp
       FROM audio_transcriptions
       WHERE length(trim(transcription)) > 0
       ORDER BY timestamp ASC
       LIMIT 2000`
    )
    .all() as Array<{
    id: number;
    transcription: string;
    meeting_id: number | null;
    timestamp: string;
  }>;

  let previousAudioKey: string | null = null;

  for (const row of audioRows) {
    const key = `audio_${row.id}`;
    if (graph.hasNode(key)) {
      previousAudioKey = key;
      continue;
    }
    const stored = ingestAudioChunk({
      audioId: row.id,
      transcription: row.transcription,
      meetingId: row.meeting_id,
      timestamp: row.timestamp,
    });
    if (stored) {
      if (previousAudioKey) linkFollows(previousAudioKey, stored);
      previousAudioKey = stored;
      ingested++;
    }
  }

  if (ingested > 0) console.log(`[memory] backfilled ${ingested} episodes into the graph`);
  return { ingested };
}

export async function getUserProfile(): Promise<{
  persona: string[];
  aims: string[];
}> {
  initMemory();
  try {
    const persona = getGraph()
      .match({ label: "Fact", where: { current: true }, orderBy: "valid_from", limit: 24 })
      .filter((node) => !isEvaluationNode(node))
      .map((node) => textOf(node).trim())
      .filter(Boolean);
    return { persona, aims: [] };
  } catch (err) {
    console.warn("[memory] getUserProfile failed:", err);
    return { persona: [], aims: [] };
  }
}

export async function listNodes(params: {
  q?: string;
  type?: string;
  limit?: number;
  offset?: number;
}): Promise<{ data: MemoryNode[]; total: number }> {
  initMemory();
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;
  const query = params.q?.trim();

  try {
    const graph = getGraph();
    const where = params.type ? { type: params.type } : undefined;

    if (query) {
      const hits = graph
        .search(query, { where, limit: 400 })
        .map((hit) => hit.node)
        .filter((node) => !isEvaluationNode(node));
      return {
        data: hits.slice(offset, offset + limit).map(graphNodeToMemoryNode),
        total: hits.length,
      };
    }

    const nodes = graph
      .match({ where, limit: limit + offset + 200 })
      .filter((node) => !isEvaluationNode(node));
    const total = graph.count({ where });
    return {
      data: nodes.slice(offset, offset + limit).map(graphNodeToMemoryNode),
      total,
    };
  } catch (err) {
    console.warn("[memory] listNodes failed:", err);
    return { data: [], total: 0 };
  }
}

export async function getNode(id: string): Promise<MemoryNode | null> {
  initMemory();
  try {
    const node = getGraph().getNode(id);
    return node ? graphNodeToMemoryNode(node) : null;
  } catch {
    return null;
  }
}

export async function getNodeGraph(id: string, hops = 2): Promise<MemoryGraph | null> {
  initMemory();
  try {
    const graph = getGraph();
    const origin = graph.getNode(id);
    if (!origin) return null;
    const node = graphNodeToMemoryNode(origin);

    const neighbors = graph.neighbors(id, { limit: 24 });

    // Second hop: when the node is a fact, also surface what its neighbours
    // supersede / are superseded by so the timeline of a value is visible.
    if (hops >= 2 && origin.label === "Fact") {
      for (const item of [...neighbors]) {
        if (item.node.label !== "Fact") continue;
        for (const second of graph.neighbors(item.node.key, {
          relation: "SUPERSEDES",
          limit: 4,
        })) {
          if (second.node.key !== id) neighbors.push(second);
        }
      }
    }

    return buildGraphFromNeighbors(node, neighbors);
  } catch {
    const node = await getNode(id);
    return node ? { node, edges: [] } : null;
  }
}

export async function getMemoryStats(): Promise<MemoryStats> {
  initMemory();
  try {
    const stats = getGraph().stats();
    return { nodes: stats.nodes, edges: stats.edges, by_type: stats.byType };
  } catch {
    return { nodes: 0, edges: 0, by_type: {} };
  }
}

export function formatNodeSnippet(node: MemoryNode): string {
  const label =
    node.type === "screen_chunk"
      ? "[screen]"
      : node.type === "audio_chunk"
        ? "[audio]"
        : node.type === "meeting"
          ? "[meeting]"
          : node.type === "session_turn"
            ? "[session]"
            : node.type === "memory"
              ? "[memory]"
              : `[${node.type}]`;

  const parts = [
    label,
    node.app_name ? `[${node.app_name}]` : null,
    node.window_name ? `"${node.window_name}"` : null,
    node.content.slice(0, 1500),
  ].filter(Boolean);

  return parts.join(" ");
}

export {
  ingestScreenCapture,
  ingestAudioChunk,
  ingestMeetingSummary,
  ingestUserMemory,
  ingestChatSession,
};

export type {
  MemoryNode,
  MemoryEdge,
  MemoryGraph,
  MemoryNodeType,
  MemoryRelation,
  MemorySearchResult,
  MemoryStats,
} from "./types.js";
