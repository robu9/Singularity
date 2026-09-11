import type { GraphNode, Neighbor } from "./graph/index.js";
import type {
  MemoryGraph,
  MemoryNode,
  MemoryNodeType,
  MemoryRelation,
  MemorySourceType,
} from "./types.js";

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Project a graph node onto the public MemoryNode shape used by the API. */
export function graphNodeToMemoryNode(node: GraphNode): MemoryNode {
  const props = node.props;
  const type = (asString(props.type) ??
    (node.label === "Fact"
      ? "fact"
      : node.label === "Session"
        ? "session"
        : node.label === "App"
          ? "app"
          : "memory")) as MemoryNodeType;
  const content = asString(props.content) ?? asString(props.text) ?? "";
  const created =
    asString(props.created_at) ??
    asString(props.valid_from) ??
    asString(props.started_at) ??
    node.created_at;

  return {
    id: node.key,
    type,
    title: asString(props.title) ?? (content.slice(0, 60) || null),
    content,
    metadata: { ...props, label: node.label },
    source_type: (asString(props.source_type) as MemorySourceType | null) ?? null,
    source_id: asNumber(props.source_id),
    app_name: asString(props.app_name),
    window_name: asString(props.window_name),
    salience: asNumber(props.salience) ?? 0.5,
    created_at: created,
    updated_at: asString(props.updated_at) ?? node.updated_at,
  };
}

const RELATION_MAP: Record<string, MemoryRelation> = {
  SUPERSEDES: "supersedes",
  FOLLOWS: "follows",
  MENTIONS: "mentions",
  ABOUT: "mentions",
  RECORDED_AS: "contains",
  IN_SESSION: "contains",
  CAPTURED_IN: "captured_in",
  SPOKEN_IN: "spoken_in",
  SUMMARIZES: "summarizes",
  DERIVED_FROM: "derived_from",
};

export function toMemoryRelation(relation: string): MemoryRelation {
  return RELATION_MAP[relation] ?? "related_to";
}

export function buildGraphFromNeighbors(
  node: MemoryNode,
  neighbors: Neighbor[]
): MemoryGraph {
  const edges: MemoryGraph["edges"] = [];
  const seen = new Set<string>();

  for (const item of neighbors) {
    if (item.node.key === node.id) continue;
    const dedupe = [node.id, item.node.key, item.edge.relation].join("|");
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    edges.push({
      id: `edge-${item.edge.id}`,
      from_id: item.direction === "out" ? node.id : item.node.key,
      to_id: item.direction === "out" ? item.node.key : node.id,
      relation: toMemoryRelation(item.edge.relation),
      weight: item.edge.weight,
      created_at: item.edge.created_at,
      neighbor: graphNodeToMemoryNode(item.node),
    });
  }

  return { node, edges };
}
