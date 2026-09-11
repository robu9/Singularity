import { getDb } from "../../db/index.js";
import { GraphMemory } from "./engine.js";

let graph: GraphMemory | null = null;

/** Process-wide graph instance, bound to the capture database. */
export function getGraph(): GraphMemory {
  if (!graph) graph = new GraphMemory(getDb());
  return graph;
}

export function resetGraph(): void {
  graph = null;
}

export { GraphMemory, tokenize } from "./engine.js";
export type {
  GraphEdge,
  GraphNode,
  GraphStats,
  MatchOptions,
  Neighbor,
  NeighborOptions,
  PropValue,
  Props,
  SearchHit,
  SearchOptions,
} from "./engine.js";
