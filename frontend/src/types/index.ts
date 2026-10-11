/** Schema from backend describing available labels */
export interface Schema {
  vertex_labels: string[];
  edge_labels: string[];
  undirected_edge_labels?: string[];
  edge_endpoints?: Record<string, Array<{ source: string; target: string }>>;
}

/** A vertex in the query canvas */
export interface QueryVertex {
  id: string;
  label: string; // "Person", "Any", etc.
  position: { x: number; y: number };
}

/** NFA definition matching the engine automaton JSON format */
export interface NFADefinition {
  regular_expression: string;
  states: string[];
  alphabets: string[];
  transitions: [string, string, string][];
  initial_states: string[];
  final_states: string[];
  min_length?: number;
  max_length?: number;
}

/** An edge in the query canvas */
export interface QueryEdge {
  id: string;
  source: string; // vertex id
  target: string; // vertex id
  label: string; // "KNOWS", "LIKES", etc.
  quantifier: '1' | '*' | '+' | '?'; // once, 0+, 1+, 0-1
  minLength?: number;
  maxLength?: number;
  direction: 'forward' | 'reverse' | 'both';
  alternateLabels?: string[]; // for alternation (A|B)
  automataName: string; // "P1", "P2", etc.
  originalNFA?: NFADefinition; // preserved from preset for complex regex patterns
}

/** Word Equality constraint between two edges */
export interface WEConstraint {
  edge1Id: string;
  edge2Id: string;
  /** undefined = word equality, 'prefix' = prefix equality */
  type?: 'prefix';
  /** 'same' (default) or 'different' source vertices */
  sourceConstraint?: 'same' | 'different';
  /** For different-source WE: the linking edge label (e.g. "KNOWS") */
  linkingLabel?: string;
}

/** Vertex inequality constraint (e.g. person1 <> person2) */
export interface VertexInequality {
  v1Id: string;
  v2Id: string;
}

/** Full query graph state from the canvas */
export interface QueryGraph {
  vertices: QueryVertex[];
  edges: QueryEdge[];
  weConstraints: WEConstraint[];
  /** Pairwise vertex inequality constraints from presets */
  inequalities?: VertexInequality[];
}

/** One query edge's reconstructed hop-by-hop witness path.
 *
 *  CRPQ samples bind a single vertex per query variable; a query edge backed by
 *  a regex is satisfied by a whole path whose intermediate vertices the kernel
 *  never records. The solver reconstructs one accepted path per bound edge
 *  host-side and attaches it as `edge_paths` (see CRPQ_solver::exec_query).
 *
 *  `edge_index` indexes the query's `query_edges` array, which is the same
 *  order as `QueryGraph.edges`. Orientation is NOT guaranteed to match
 *  `QueryEdge.source`/`target`: the engine query parser normalises "(a)<-[L]-(b)" to
 *  v1=b, v2=a while the canvas keeps source=a — so always re-check the
 *  endpoints (see utils/witnessPath.ts).
 *
 *  It is A witness, not THE witness: the kernel counts distinct (src,dst)
 *  pairs, so the counted path need not be the reconstructed one. Never derive
 *  a count from these paths.
 */
export interface EdgeWitnessPath {
  edge_index: number;
  vertices: number[];
  edge_labels?: string[];
  vertex_labels?: string[];
}

/** A single sampled path from query results */
export interface SamplePath {
  vertices: number[]; // vertex IDs
  edge_labels?: string[]; // labels per hop (optional; backend may omit)
  vertex_types?: string[]; // type per vertex (optional; backend may omit)
  vertex_labels?: string[]; // raw per-vertex labels from the kernel (crpq)
  /** RPQ / WE only: per-hop "the grid stores this edge the other way round".
   *
   *  `vertices` is emitted in TRAVERSAL order, and a PREPEND automaton
   *  (regex written right-to-left, e.g. "HAS_MODERATOR/KNOWS*") walks the graph
   *  backwards. For hop i with `edge_reversed[i] === true` the real edge is
   *  `vertices[i+1] -> vertices[i]`, so the arrow must be drawn that way.
   *
   *  One entry per hop (`vertices.length - 1`). Omitted entirely when every hop
   *  runs with the data, which is every APPEND query — so treat a missing array
   *  as all-false and never reorder `vertices` because of it (WE pairing and the
   *  UI both rely on `vertices[0]` staying the traversal source). */
  edge_reversed?: boolean[];
  /** CRPQ only: one witness path per query edge (optional; older backends omit) */
  edge_paths?: EdgeWitnessPath[];
}

/** A pair of word-equal sampled paths */
export interface WESamplePair {
  path1: SamplePath;
  path2: SamplePath;
  src_vid: number;
  linking_edge?: { vertices: number[]; label: string };
}

/** Type guard for WESamplePair vs SamplePath */
export function isWESamplePair(s: SamplePath | WESamplePair): s is WESamplePair {
  return 'path1' in s && 'path2' in s;
}

/** Query result from backend */
export interface QueryResult {
  query_type: 'rpq' | 'crpq' | 'word_equality';
  total_count: number;
  elapsed_ms: number;
  /** Replayed from a stored result rather than computed by this run. */
  from_cache?: boolean;
  /** Set by the frontend when it pairs two standalone RPQ results for display.
   *  Such a result carries path1/path2 like a word equality but NO equality was
   *  ever evaluated, so nothing may claim the two words match. */
  synthesized_pairs?: boolean;
  samples: SamplePath[] | WESamplePair[];
  /** Correctness caveats from the engine. A warned count may be wrong or a
   *  lower bound, so these are shown next to the count rather than hidden. */
  warnings?: string[];
  /** Structured pair-frontier overflow report (prefix-WE lock-step). */
  we_pair_frontier_warnings?: {
    sources_affected?: number;
    widest_frontier?: number;
    frontier_drops?: number;
    multi_word_class?: number;
    [k: string]: unknown;
  };
  /** How many CRPQ witness paths were reconstructed vs skipped. */
  witness_stats?: Record<string, unknown>;
  /** Engine's live footprint while answering (process host RSS + GPU), GB. */
  engine_mem_gb?: number;
  mem_host_gb?: number;
  mem_gpu_gb?: number;
}

/** A dataset available on the backend */
export interface Dataset {
  id: string;
  name: string;
  schema: string;
  loaded: boolean;
}

/** Catalog metadata for a single scenario */
export interface CatalogScenario {
  id: string;
  group: string;
  title: string;
  title_ko?: string;
  question?: string;
  question_ko?: string;
  tag?: string;
}

/** Catalog group metadata */
export interface CatalogGroup {
  id: string;
  label: string;
  label_ko?: string;
  description?: string;
  color?: string;
  tagline?: string;
}

/** A preset query that can be loaded onto the canvas */
export interface PresetQuery {
  name: string;
  filename: string;
  content: Record<string, unknown>; // raw query JSON
  catalog?: CatalogScenario | null;
}

/** Response from /api/presets */
export interface PresetsResponse {
  groups: CatalogGroup[];
  presets: PresetQuery[];
}

/** Path colors used for result visualization — 6 well-separated muted tones */
export const PATH_COLORS = [
  '#64b5f6', // muted blue
  '#ef9a9a', // muted rose
  '#81c784', // muted green
  '#ce93d8', // muted violet
  '#ffb74d', // muted amber
  '#4dd0e1', // muted teal
] as const;
