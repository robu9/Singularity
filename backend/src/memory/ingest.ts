import { getGraph } from "./graph/index.js";
import { extractDurableFacts, sameFactText } from "./fact-extraction.js";

/**
 * Writing memory into the embedded graph.
 *
 * Labels and relations used by the memory layer:
 *
 *   (:Episode)  a screen chunk, audio segment, meeting, pinned note, or chat turn
 *   (:Fact)     a durable claim with `current`, `valid_from`, `valid_to`
 *   (:Session)  a multi-turn conversation
 *   (:App)      an application that episodes were captured in
 *
 *   (e:Episode)-[:FOLLOWS]->(previous:Episode)    chronological spine
 *   (e:Episode)-[:RECORDED_AS]->(f:Fact)          provenance of a fact
 *   (e:Episode)-[:IN_SESSION]->(s:Session)        turn belongs to a session
 *   (e:Episode)-[:CAPTURED_IN]->(a:App)           where a snapshot was taken
 *   (e:Episode)-[:SPOKEN_IN]->(m:Episode)         audio segment within a meeting
 *   (new:Fact)-[:SUPERSEDES]->(old:Fact)          later value replacing earlier
 */

export const EVALUATION_PREFIX = "__singularity_eval__";

/** Longest text stored on a node. The full text stays in the capture tables. */
const MAX_CONTENT_CHARS = 4_000;
const MAX_TITLE_CHARS = 160;

let consecutiveFailures = 0;

function reportIngestFailure(err: unknown): void {
  consecutiveFailures += 1;
  if (consecutiveFailures <= 3 || consecutiveFailures % 100 === 0) {
    console.warn(
      `[memory] ingest failed (${consecutiveFailures}x):`,
      err instanceof Error ? err.message : err
    );
  }
}

function noteIngestSuccess(): void {
  consecutiveFailures = 0;
}

function titleFromContent(content: string, max = 60): string {
  const line = content.split("\n").find((part) => part.trim().length > 0) ?? content;
  return line.trim().slice(0, max);
}

function nowIso(): string {
  return new Date().toISOString();
}

function clip(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

function upsertEpisode(params: {
  id: string;
  type: string;
  title: string;
  content: string;
  sourceType: string;
  sourceId: number | null;
  appName: string | null;
  windowName: string | null;
  salience: number;
  createdAt: string;
  evaluation?: boolean;
}): string | null {
  try {
    getGraph().upsertNode(
      "Episode",
      params.id,
      {
        key: params.id,
        type: params.type,
        title: clip(params.title, MAX_TITLE_CHARS),
        content: clip(params.content, MAX_CONTENT_CHARS),
        source_type: params.sourceType,
        source_id: params.sourceId,
        app_name: params.appName ? clip(params.appName, 80) : null,
        window_name: params.windowName ? clip(params.windowName, 120) : null,
        salience: params.salience,
        created_at: params.createdAt,
        updated_at: nowIso(),
        evaluation: params.evaluation ?? false,
      },
      { createdAt: params.createdAt }
    );
    noteIngestSuccess();
    return params.id;
  } catch (err) {
    reportIngestFailure(err);
    return null;
  }
}

/** Chain an episode after its predecessor, for chronological traversal. */
export function linkFollows(previousKey: string, nextKey: string): void {
  if (previousKey === nextKey) return;
  try {
    getGraph().link(nextKey, "FOLLOWS", previousKey, { weight: 0.7 });
  } catch (err) {
    reportIngestFailure(err);
  }
}

/**
 * Chain a freshly captured episode after the most recent one of the same
 * type, so live captures join the same FOLLOWS spine the backfill builds.
 */
function linkToPredecessor(key: string, type: string): void {
  const previous = getGraph()
    .match({ label: "Episode", where: { type }, limit: 3 })
    .find((node) => node.key !== key);
  if (previous) linkFollows(previous.key, key);
}

function linkApp(episodeKey: string, appName: string | null, createdAt: string): void {
  const name = appName?.trim();
  if (!name) return;
  const key = `app_${slug(name) || "unknown"}`;
  const graph = getGraph();
  const existing = graph.getNode(key);
  graph.upsertNode(
    "App",
    key,
    {
      key,
      type: "app",
      title: name,
      content: name,
      source_type: "frame",
      salience: 0.3,
      created_at: existing?.created_at ?? createdAt,
      updated_at: nowIso(),
      capture_count: (typeof existing?.props.capture_count === "number"
        ? existing.props.capture_count
        : 0) + 1,
    },
    { createdAt }
  );
  graph.link(episodeKey, "CAPTURED_IN", key, { weight: 0.5 });
}

function upsertFact(params: {
  id: string;
  text: string;
  factKey?: string;
  episodeId: string;
  createdAt: string;
  evaluation?: boolean;
}): boolean {
  const key = clip(params.factKey ?? params.text, 80).toLowerCase();
  try {
    const graph = getGraph();
    graph.upsertNode(
      "Fact",
      params.id,
      {
        key: params.id,
        type: "fact",
        text: clip(params.text, MAX_CONTENT_CHARS),
        fact_key: key,
        current: true,
        valid_from: params.createdAt,
        created_at: params.createdAt,
        evaluation: params.evaluation ?? false,
      },
      { createdAt: params.createdAt }
    );
    graph.link(params.episodeId, "RECORDED_AS", params.id, { weight: 0.9 });
    noteIngestSuccess();
    return true;
  } catch (err) {
    reportIngestFailure(err);
    return false;
  }
}

interface StoredFact {
  key: string;
  text: string;
  current: boolean;
  validFrom: string;
}

function getFactById(key: string): StoredFact | null {
  const node = getGraph().getNode(key);
  if (!node || node.label !== "Fact") return null;
  return {
    key: node.key,
    text: typeof node.props.text === "string" ? node.props.text : "",
    current: node.props.current === true,
    validFrom: typeof node.props.valid_from === "string" ? node.props.valid_from : "",
  };
}

function getCurrentFactForSlot(factKey: string): StoredFact | null {
  const [node] = getGraph().match({
    label: "Fact",
    where: { fact_key: clip(factKey, 80).toLowerCase(), current: true },
    orderBy: "valid_from",
    limit: 1,
  });
  if (!node) return null;
  return {
    key: node.key,
    text: typeof node.props.text === "string" ? node.props.text : "",
    current: true,
    validFrom: typeof node.props.valid_from === "string" ? node.props.valid_from : "",
  };
}

function ingestTemporalFact(params: {
  id: string;
  slot: string;
  text: string;
  episodeId: string;
  createdAt: string;
  evaluation?: boolean;
}): void {
  // Replayed session payloads are common as a conversation grows. Once this
  // exact fact exists, do not let an older turn replace a newer current fact.
  if (getFactById(params.id)) return;

  const current = getCurrentFactForSlot(params.slot);
  if (current && sameFactText(current.text, params.text)) {
    getGraph().link(params.episodeId, "RECORDED_AS", current.key, { weight: 0.9 });
    return;
  }

  const stored = upsertFact({
    id: params.id,
    text: params.text,
    factKey: params.slot,
    episodeId: params.episodeId,
    createdAt: params.createdAt,
    evaluation: params.evaluation,
  });

  if (!stored || !current) return;

  const incomingTime = Date.parse(params.createdAt);
  const currentTime = Date.parse(current.validFrom);
  const incomingIsNewer =
    !Number.isFinite(currentTime) ||
    !Number.isFinite(incomingTime) ||
    incomingTime >= currentTime;

  if (incomingIsNewer) {
    supersedeFact(current.key, params.id, params.createdAt);
  } else {
    supersedeFact(params.id, current.key, current.validFrom || params.createdAt);
  }
}

/**
 * Mark an earlier fact as replaced by a newer one.
 *
 * Superseding is what the graph exists for, so it is expressed explicitly
 * rather than inferred: the caller supplies the pair.
 */
export function supersedeFact(oldKey: string, newKey: string, at: string): void {
  if (oldKey === newKey) return;
  try {
    const graph = getGraph();
    graph.link(newKey, "SUPERSEDES", oldKey, { weight: 1 });
    graph.setProps(oldKey, { current: false, valid_to: at });
  } catch (err) {
    reportIngestFailure(err);
  }
}

export function ingestScreenCapture(params: {
  frameId: number;
  text: string;
  appName: string | null;
  windowName: string | null;
  timestamp: string;
}): string | null {
  const text = params.text.trim();
  if (!text) return null;
  const title = params.windowName ?? params.appName ?? titleFromContent(text);
  const contextLine = [
    params.appName ? `App: ${params.appName}` : null,
    params.windowName ? `Window: ${params.windowName}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const key = `frame_${params.frameId}`;
  const isNew = !getGraph().hasNode(key);
  const id = upsertEpisode({
    id: key,
    type: "screen_chunk",
    title,
    content: contextLine ? `${contextLine}\n\n${text}` : text,
    sourceType: "frame",
    sourceId: params.frameId,
    appName: params.appName,
    windowName: params.windowName,
    salience: 0.55,
    createdAt: params.timestamp,
  });
  if (id) {
    try {
      if (isNew) linkToPredecessor(id, "screen_chunk");
      linkApp(id, params.appName, params.timestamp);
    } catch (err) {
      reportIngestFailure(err);
    }
  }
  return id;
}

export function ingestAudioChunk(params: {
  audioId: number;
  transcription: string;
  meetingId?: number | null;
  timestamp: string;
}): string | null {
  const text = params.transcription.trim();
  if (!text) return null;
  const key = `audio_${params.audioId}`;
  const isNew = !getGraph().hasNode(key);
  const id = upsertEpisode({
    id: key,
    type: "audio_chunk",
    title: titleFromContent(text),
    content: text,
    sourceType: "audio",
    sourceId: params.audioId,
    appName: null,
    windowName: null,
    salience: 0.65,
    createdAt: params.timestamp,
  });

  if (id && isNew) {
    try {
      linkToPredecessor(id, "audio_chunk");
    } catch (err) {
      reportIngestFailure(err);
    }
  }

  if (id && params.meetingId) {
    const meetingKey = `meeting_${params.meetingId}`;
    const graph = getGraph();
    if (!graph.hasNode(meetingKey)) {
      upsertEpisode({
        id: meetingKey,
        type: "meeting",
        title: `Recording #${params.meetingId}`,
        content: `Recording #${params.meetingId}`,
        sourceType: "meeting",
        sourceId: params.meetingId,
        appName: null,
        windowName: null,
        salience: 0.9,
        createdAt: params.timestamp,
      });
    }
    graph.link(id, "SPOKEN_IN", meetingKey, { weight: 0.8 });
  }

  return id;
}

export function ingestMeetingSummary(params: {
  meetingId: number;
  title: string;
  summary: string;
  actionItems: string[];
}): string | null {
  const content = [
    params.title,
    params.summary,
    params.actionItems.length > 0
      ? `action items:\n${params.actionItems.map((item) => `- ${item}`).join("\n")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const id = upsertEpisode({
    id: `meeting_${params.meetingId}`,
    type: "meeting",
    title: params.title,
    content,
    sourceType: "meeting",
    sourceId: params.meetingId,
    appName: null,
    windowName: null,
    salience: 0.9,
    createdAt: nowIso(),
  });

  if (id) {
    upsertFact({
      id: `fact_meeting_${params.meetingId}`,
      text: params.summary,
      episodeId: id,
      createdAt: nowIso(),
    });
  }

  return id;
}

export function ingestUserMemory(params: {
  title: string;
  content: string;
}): string | null {
  const createdAt = nowIso();
  const id = `user_${Date.now()}`;
  const episodeId = upsertEpisode({
    id,
    type: "memory",
    title: params.title,
    content: `${params.title}\n${params.content}`,
    sourceType: "user",
    sourceId: null,
    appName: null,
    windowName: null,
    salience: 0.95,
    createdAt,
  });
  if (episodeId) {
    upsertFact({
      id: `fact_${id}`,
      text: `${params.title}: ${params.content}`,
      episodeId,
      createdAt,
    });
  }
  return episodeId;
}

export function ingestChatSession(params: {
  sessionId: string;
  turns: Array<{
    role: "user" | "assistant";
    content: string;
    timestamp?: string;
  }>;
  startedAt?: string;
}): string | null {
  const requestedStart = params.startedAt ?? nowIso();
  const startMillis = Date.parse(requestedStart);
  const startedAt = Number.isFinite(startMillis)
    ? new Date(startMillis).toISOString()
    : nowIso();
  const evaluation = params.sessionId.startsWith(EVALUATION_PREFIX);

  try {
    const graph = getGraph();
    graph.upsertNode(
      "Session",
      params.sessionId,
      {
        key: params.sessionId,
        type: "session",
        title: `Conversation · ${startedAt.slice(0, 16).replace("T", " ")}`,
        started_at: startedAt,
        created_at: startedAt,
        turn_count: params.turns.length,
        evaluation,
      },
      { createdAt: startedAt }
    );

    let previousKey: string | null = null;

    for (const [index, turn] of params.turns.entries()) {
      const text = turn.content.trim();
      if (!text) continue;

      const parsedTurnTime = turn.timestamp ? Date.parse(turn.timestamp) : Number.NaN;
      const createdAt = Number.isFinite(parsedTurnTime)
        ? new Date(parsedTurnTime).toISOString()
        : new Date(Date.parse(startedAt) + index).toISOString();

      const episodeKey = `${params.sessionId}_t${index}`;
      const stored = upsertEpisode({
        id: episodeKey,
        type: "session_turn",
        title: `${turn.role} · ${params.sessionId}`,
        content: text,
        sourceType: "user",
        sourceId: index,
        appName: null,
        windowName: null,
        salience: turn.role === "user" ? 0.85 : 0.4,
        createdAt,
        evaluation,
      });
      if (!stored) continue;

      graph.link(episodeKey, "IN_SESSION", params.sessionId, { weight: 0.6 });

      if (previousKey) linkFollows(previousKey, episodeKey);
      previousKey = episodeKey;

      if (turn.role === "user") {
        const facts = extractDurableFacts(text);
        for (const [factIndex, fact] of facts.entries()) {
          ingestTemporalFact({
            id: `fact_${episodeKey}_${factIndex}`,
            slot: fact.slot,
            text: fact.text,
            episodeId: episodeKey,
            createdAt,
            evaluation,
          });
        }
      }
    }

    noteIngestSuccess();
    return params.sessionId;
  } catch (err) {
    reportIngestFailure(err);
    return null;
  }
}
