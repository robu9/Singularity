import type { DatabaseSync } from "node:sqlite";

/**
 * Singularity's embedded property-graph engine.
 *
 * Nodes are addressed by a stable string key ("frame_12", "fact_meeting_3"),
 * carry a label ("Episode", "Fact", "Session", "App") and an arbitrary bag of
 * scalar properties. Edges are typed, directed, and weighted. Everything is
 * persisted in SQLite through `node:sqlite` — no external server, no network,
 * no query-length limits — and full-text search comes from an FTS5 shadow
 * table that is kept in sync on every write.
 *
 * The API is deliberately small: upsert, match by equality, walk neighbours,
 * search text. Higher-level memory semantics (temporal facts, superseding,
 * chronological chains) are expressed on top of it in `../ingest.ts`.
 */

/**
 * Storage layout for the embedded property graph.
 *
 * The graph lives inside the same SQLite file as capture data, so a single
 * `~/.singularity/db.sqlite` holds both the raw recordings and the memory
 * built from them. Nodes carry a JSON property bag plus a denormalised `text`
 * column that feeds the FTS5 index; edges are typed, weighted, and unique per
 * (from, to, relation) so re-ingesting the same episode is idempotent.
 */
export const GRAPH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS graph_nodes (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  props TEXT NOT NULL DEFAULT '{}',
  text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_graph_nodes_label ON graph_nodes(label, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_type
  ON graph_nodes(json_extract(props, '$.type'));
CREATE INDEX IF NOT EXISTS idx_graph_nodes_fact_key
  ON graph_nodes(json_extract(props, '$.fact_key'));
CREATE INDEX IF NOT EXISTS idx_graph_nodes_current
  ON graph_nodes(json_extract(props, '$.current'));

CREATE TABLE IF NOT EXISTS graph_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_key TEXT NOT NULL REFERENCES graph_nodes(key) ON DELETE CASCADE,
  to_key TEXT NOT NULL REFERENCES graph_nodes(key) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  props TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(from_key, to_key, relation)
);

CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_key, relation);
CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_key, relation);

CREATE VIRTUAL TABLE IF NOT EXISTS graph_nodes_fts USING fts5(
  key UNINDEXED,
  label UNINDEXED,
  text,
  tokenize='porter unicode61'
);
`;

export type PropValue = string | number | boolean | null;
export type Props = Record<string, PropValue | undefined>;

export interface GraphNode {
  key: string;
  label: string;
  props: Record<string, PropValue>;
  created_at: string;
  updated_at: string;
}

export interface GraphEdge {
  id: number;
  from: string;
  to: string;
  relation: string;
  weight: number;
  props: Record<string, PropValue>;
  created_at: string;
}

export interface Neighbor {
  edge: GraphEdge;
  node: GraphNode;
  /** Whether the edge points away from ("out") or into ("in") the origin. */
  direction: "out" | "in";
}

export interface MatchOptions {
  label?: string;
  /** Equality filters on properties, e.g. `{ current: true, type: "fact" }`. */
  where?: Props;
  /** Property to order by (falls back to `created_at`). */
  orderBy?: string;
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface SearchOptions extends Omit<MatchOptions, "orderBy" | "order"> {
  /**
   * Fraction of query tokens a node must contain to count as a hit. A single
   * shared word is too weak for personal-history questions, so the default
   * requires half of the tokens.
   */
  minCoverage?: number;
}

export interface SearchHit {
  node: GraphNode;
  /** Higher is better. Combines BM25 rank with token coverage. */
  score: number;
  coverage: number;
}

export interface NeighborOptions {
  relation?: string | string[];
  direction?: "out" | "in" | "both";
  label?: string;
  limit?: number;
}

export interface GraphStats {
  nodes: number;
  edges: number;
  byLabel: Record<string, number>;
  byType: Record<string, number>;
  byRelation: Record<string, number>;
}

const SEARCHABLE_PROPS = ["title", "content", "text"];

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "was", "you", "how", "why", "can", "not", "but",
  "what", "when", "where", "which", "who", "whose", "would", "could", "should",
  "tell", "show", "about", "from", "that", "this", "with", "have", "were",
  "does", "did", "been", "being", "into", "your", "yours", "mine", "them",
  "they", "there", "their", "then", "than", "some", "just", "like", "also",
  "any", "all", "our", "his", "her", "its", "had", "has", "will", "did",
]);

function nowIso(): string {
  return new Date().toISOString();
}

function normaliseProps(input: Props): Record<string, PropValue> {
  const out: Record<string, PropValue> = {};
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue;
    out[name] = value;
  }
  return out;
}

function searchableText(props: Record<string, PropValue>): string {
  return SEARCHABLE_PROPS.map((name) => props[name])
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}

/** Convert a JS value into something node:sqlite accepts as a bound parameter. */
function bind(value: PropValue): string | number | null {
  if (value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

export function tokenize(query: string): string[] {
  const seen = new Set<string>();
  for (const raw of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || STOP_WORDS.has(raw)) continue;
    seen.add(raw);
    if (seen.size >= 8) break;
  }
  return [...seen];
}

interface NodeRow {
  key: string;
  label: string;
  props: string;
  created_at: string;
  updated_at: string;
}

interface EdgeRow {
  id: number;
  from_key: string;
  to_key: string;
  relation: string;
  weight: number;
  props: string;
  created_at: string;
}

function parseProps(raw: string): Record<string, PropValue> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, PropValue>)
      : {};
  } catch {
    return {};
  }
}

function rowToNode(row: NodeRow): GraphNode {
  return {
    key: row.key,
    label: row.label,
    props: parseProps(row.props),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToEdge(row: EdgeRow): GraphEdge {
  return {
    id: row.id,
    from: row.from_key,
    to: row.to_key,
    relation: row.relation,
    weight: row.weight,
    props: parseProps(row.props),
    created_at: row.created_at,
  };
}

export class GraphMemory {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(GRAPH_SCHEMA_SQL);
  }

  // ---------------------------------------------------------------- nodes

  /**
   * Create a node or merge properties into an existing one. Existing
   * properties that are not mentioned are kept; `null` removes a property.
   */
  upsertNode(
    label: string,
    key: string,
    props: Props = {},
    options: { createdAt?: string } = {}
  ): GraphNode {
    const existing = this.getNode(key);
    const merged = { ...(existing?.props ?? {}), ...normaliseProps(props) };
    for (const [name, value] of Object.entries(merged)) {
      if (value === null) delete merged[name];
    }
    const now = nowIso();
    const createdAt = existing?.created_at ?? options.createdAt ?? now;
    const text = searchableText(merged);

    this.db
      .prepare(
        `INSERT INTO graph_nodes (key, label, props, text, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           label = excluded.label,
           props = excluded.props,
           text = excluded.text,
           updated_at = excluded.updated_at`
      )
      .run(key, label, JSON.stringify(merged), text, createdAt, now);

    this.db.prepare(`DELETE FROM graph_nodes_fts WHERE key = ?`).run(key);
    if (text) {
      this.db
        .prepare(`INSERT INTO graph_nodes_fts (key, label, text) VALUES (?, ?, ?)`)
        .run(key, label, text);
    }

    return { key, label, props: merged, created_at: createdAt, updated_at: now };
  }

  setProps(key: string, props: Props): GraphNode | null {
    const existing = this.getNode(key);
    if (!existing) return null;
    return this.upsertNode(existing.label, key, props);
  }

  getNode(key: string): GraphNode | null {
    const row = this.db
      .prepare(`SELECT * FROM graph_nodes WHERE key = ?`)
      .get(key) as NodeRow | undefined;
    return row ? rowToNode(row) : null;
  }

  hasNode(key: string): boolean {
    return Boolean(
      this.db.prepare(`SELECT 1 FROM graph_nodes WHERE key = ? LIMIT 1`).get(key)
    );
  }

  deleteNode(key: string): void {
    this.db.prepare(`DELETE FROM graph_edges WHERE from_key = ? OR to_key = ?`).run(key, key);
    this.db.prepare(`DELETE FROM graph_nodes_fts WHERE key = ?`).run(key);
    this.db.prepare(`DELETE FROM graph_nodes WHERE key = ?`).run(key);
  }

  private whereClause(options: { label?: string; where?: Props }, alias = "n") {
    const clauses: string[] = [];
    const params: Array<string | number | null> = [];
    if (options.label) {
      clauses.push(`${alias}.label = ?`);
      params.push(options.label);
    }
    for (const [name, value] of Object.entries(options.where ?? {})) {
      if (value === undefined) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`invalid property name "${name}"`);
      }
      if (value === null) {
        clauses.push(`json_extract(${alias}.props, '$.${name}') IS NULL`);
      } else {
        clauses.push(`json_extract(${alias}.props, '$.${name}') = ?`);
        params.push(bind(value));
      }
    }
    return {
      sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
      params,
    };
  }

  private orderClause(orderBy: string | undefined, order: "asc" | "desc", alias = "n") {
    const direction = order === "asc" ? "ASC" : "DESC";
    if (!orderBy || orderBy === "created_at" || orderBy === "updated_at") {
      return `ORDER BY ${alias}.${orderBy ?? "created_at"} ${direction}`;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(orderBy)) {
      throw new Error(`invalid order property "${orderBy}"`);
    }
    return `ORDER BY json_extract(${alias}.props, '$.${orderBy}') ${direction}, ${alias}.created_at ${direction}`;
  }

  /** Nodes matching a label and equality filters. */
  match(options: MatchOptions = {}): GraphNode[] {
    const where = this.whereClause(options);
    const limit = Math.max(1, Math.min(options.limit ?? 100, 5_000));
    const offset = Math.max(0, options.offset ?? 0);
    const rows = this.db
      .prepare(
        `SELECT n.* FROM graph_nodes n ${where.sql}
         ${this.orderClause(options.orderBy, options.order ?? "desc")}
         LIMIT ? OFFSET ?`
      )
      .all(...where.params, limit, offset) as NodeRow[];
    return rows.map(rowToNode);
  }

  count(options: { label?: string; where?: Props } = {}): number {
    const where = this.whereClause(options);
    const row = this.db
      .prepare(`SELECT count(*) AS total FROM graph_nodes n ${where.sql}`)
      .get(...where.params) as { total: number } | undefined;
    return row?.total ?? 0;
  }

  // ---------------------------------------------------------------- edges

  /** Create or refresh a directed edge. Both endpoints must already exist. */
  link(
    from: string,
    relation: string,
    to: string,
    options: { weight?: number; props?: Props } = {}
  ): GraphEdge | null {
    if (from === to) return null;
    if (!this.hasNode(from) || !this.hasNode(to)) return null;
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO graph_edges (from_key, to_key, relation, weight, props, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(from_key, to_key, relation) DO UPDATE SET
           weight = excluded.weight,
           props = excluded.props`
      )
      .run(
        from,
        to,
        relation,
        options.weight ?? 1,
        JSON.stringify(normaliseProps(options.props ?? {})),
        now
      );
    const row = this.db
      .prepare(
        `SELECT * FROM graph_edges WHERE from_key = ? AND to_key = ? AND relation = ?`
      )
      .get(from, to, relation) as EdgeRow | undefined;
    return row ? rowToEdge(row) : null;
  }

  unlink(from: string, relation: string, to: string): void {
    this.db
      .prepare(`DELETE FROM graph_edges WHERE from_key = ? AND to_key = ? AND relation = ?`)
      .run(from, to, relation);
  }

  hasEdge(from: string, relation: string, to: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM graph_edges WHERE from_key = ? AND to_key = ? AND relation = ? LIMIT 1`
        )
        .get(from, to, relation)
    );
  }

  neighbors(key: string, options: NeighborOptions = {}): Neighbor[] {
    const direction = options.direction ?? "both";
    const relations = options.relation
      ? Array.isArray(options.relation)
        ? options.relation
        : [options.relation]
      : [];
    const limit = Math.max(1, Math.min(options.limit ?? 50, 1_000));

    const relationSql =
      relations.length > 0
        ? `AND e.relation IN (${relations.map(() => "?").join(", ")})`
        : "";
    const labelSql = options.label ? `AND n.label = ?` : "";
    const labelParams = options.label ? [options.label] : [];

    const out: Neighbor[] = [];

    if (direction === "out" || direction === "both") {
      const rows = this.db
        .prepare(
          `SELECT e.id, e.from_key, e.to_key, e.relation, e.weight, e.props AS edge_props,
                  e.created_at AS edge_created,
                  n.key, n.label, n.props, n.created_at, n.updated_at
           FROM graph_edges e JOIN graph_nodes n ON n.key = e.to_key
           WHERE e.from_key = ? ${relationSql} ${labelSql}
           ORDER BY e.weight DESC, n.created_at DESC
           LIMIT ?`
        )
        .all(key, ...relations, ...labelParams, limit) as Array<
        EdgeRow & NodeRow & { edge_props: string; edge_created: string }
      >;
      for (const row of rows) out.push(this.joinRow(row, "out"));
    }

    if (direction === "in" || direction === "both") {
      const rows = this.db
        .prepare(
          `SELECT e.id, e.from_key, e.to_key, e.relation, e.weight, e.props AS edge_props,
                  e.created_at AS edge_created,
                  n.key, n.label, n.props, n.created_at, n.updated_at
           FROM graph_edges e JOIN graph_nodes n ON n.key = e.from_key
           WHERE e.to_key = ? ${relationSql} ${labelSql}
           ORDER BY e.weight DESC, n.created_at DESC
           LIMIT ?`
        )
        .all(key, ...relations, ...labelParams, limit) as Array<
        EdgeRow & NodeRow & { edge_props: string; edge_created: string }
      >;
      for (const row of rows) out.push(this.joinRow(row, "in"));
    }

    return out.slice(0, limit);
  }

  private joinRow(
    row: EdgeRow & NodeRow & { edge_props: string; edge_created: string },
    direction: "out" | "in"
  ): Neighbor {
    return {
      direction,
      edge: {
        id: row.id,
        from: row.from_key,
        to: row.to_key,
        relation: row.relation,
        weight: row.weight,
        props: parseProps(row.edge_props),
        created_at: row.edge_created,
      },
      node: rowToNode(row),
    };
  }

  /** Breadth-first walk up to `hops` away, returning the induced subgraph. */
  traverse(
    key: string,
    options: { hops?: number; relation?: string | string[]; limit?: number } = {}
  ): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const origin = this.getNode(key);
    if (!origin) return { nodes: [], edges: [] };

    const hops = Math.max(1, Math.min(options.hops ?? 2, 4));
    const limit = Math.max(1, Math.min(options.limit ?? 200, 2_000));
    const nodes = new Map<string, GraphNode>([[key, origin]]);
    const edges = new Map<number, GraphEdge>();
    let frontier = [key];

    for (let depth = 0; depth < hops && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const current of frontier) {
        for (const item of this.neighbors(current, { relation: options.relation })) {
          edges.set(item.edge.id, item.edge);
          if (!nodes.has(item.node.key)) {
            nodes.set(item.node.key, item.node);
            next.push(item.node.key);
          }
          if (nodes.size >= limit) break;
        }
        if (nodes.size >= limit) break;
      }
      frontier = next;
    }

    return { nodes: [...nodes.values()], edges: [...edges.values()] };
  }

  // --------------------------------------------------------------- search

  /**
   * Full-text search over node text. FTS5 supplies candidates ranked by BM25;
   * results are then re-scored by how many distinct query tokens they cover so
   * that a single incidental word cannot surface an unrelated memory.
   */
  search(query: string, options: SearchOptions = {}): SearchHit[] {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const tokens = tokenize(trimmed);
    const limit = Math.max(1, Math.min(options.limit ?? 20, 500));
    const where = this.whereClause({ label: options.label, where: options.where });
    const extra = where.sql ? where.sql.replace(/^WHERE/, "AND") : "";

    // No usable tokens (very short query): fall back to a substring scan.
    if (tokens.length === 0) {
      const rows = this.db
        .prepare(
          `SELECT n.* FROM graph_nodes n
           WHERE instr(lower(n.text), lower(?)) > 0 ${extra}
           ORDER BY n.created_at DESC LIMIT ?`
        )
        .all(trimmed, ...where.params, limit) as NodeRow[];
      return rows.map((row) => ({ node: rowToNode(row), score: 1, coverage: 1 }));
    }

    const ftsQuery = tokens.map((token) => `"${token.replace(/"/g, "")}"*`).join(" OR ");
    const candidateLimit = Math.min(limit * 8, 1_000);

    let rows: Array<NodeRow & { rank: number }> = [];
    try {
      rows = this.db
        .prepare(
          `SELECT n.*, bm25(graph_nodes_fts) AS rank
           FROM graph_nodes_fts f JOIN graph_nodes n ON n.key = f.key
           WHERE graph_nodes_fts MATCH ? ${extra}
           ORDER BY rank LIMIT ?`
        )
        .all(ftsQuery, ...where.params, candidateLimit) as Array<NodeRow & { rank: number }>;
    } catch {
      rows = [];
    }

    const minCoverage =
      options.minCoverage ?? (tokens.length === 1 ? 1 : Math.ceil(tokens.length / 2) / tokens.length);

    const hits: SearchHit[] = [];
    for (const row of rows) {
      const node = rowToNode(row);
      const haystack = `${row.props} ${node.key}`.toLowerCase();
      const matched = tokens.filter((token) => haystack.includes(token)).length;
      const coverage = matched / tokens.length;
      if (coverage + 1e-9 < minCoverage) continue;
      // bm25() returns negative numbers where lower is better.
      const score = coverage * 10 + Math.max(0, -row.rank);
      hits.push({ node, score, coverage });
    }

    hits.sort((a, b) => b.score - a.score || (a.node.created_at < b.node.created_at ? 1 : -1));
    return hits.slice(0, limit);
  }

  // ---------------------------------------------------------------- stats

  stats(): GraphStats {
    const nodes = (this.db.prepare(`SELECT count(*) AS total FROM graph_nodes`).get() as {
      total: number;
    }).total;
    const edges = (this.db.prepare(`SELECT count(*) AS total FROM graph_edges`).get() as {
      total: number;
    }).total;

    const byLabel: Record<string, number> = {};
    for (const row of this.db
      .prepare(`SELECT label, count(*) AS total FROM graph_nodes GROUP BY label`)
      .all() as Array<{ label: string; total: number }>) {
      byLabel[row.label] = row.total;
    }

    const byType: Record<string, number> = {};
    for (const row of this.db
      .prepare(
        `SELECT json_extract(props, '$.type') AS type, count(*) AS total
         FROM graph_nodes WHERE type IS NOT NULL GROUP BY type`
      )
      .all() as Array<{ type: string; total: number }>) {
      byType[row.type] = row.total;
    }

    const byRelation: Record<string, number> = {};
    for (const row of this.db
      .prepare(`SELECT relation, count(*) AS total FROM graph_edges GROUP BY relation`)
      .all() as Array<{ relation: string; total: number }>) {
      byRelation[row.relation] = row.total;
    }

    return { nodes, edges, byLabel, byType, byRelation };
  }

  /** Rebuild the FTS index from the node table (after a schema migration). */
  reindex(): void {
    this.db.exec(`DELETE FROM graph_nodes_fts`);
    this.db.exec(
      `INSERT INTO graph_nodes_fts (key, label, text)
       SELECT key, label, text FROM graph_nodes WHERE length(text) > 0`
    );
  }
}
