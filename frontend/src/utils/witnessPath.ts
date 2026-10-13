import type { EdgeWitnessPath } from '../types';

/** A witness path kept in the SOLVER'S OWN ORDER — that is, the true data
 *  direction: `vertices[h] -[edgeLabels[h]]-> vertices[h+1]` is a real edge of
 *  the graph — plus the one flag a renderer needs to place it against the query
 *  edge that asked for it.
 *
 *  The distinction matters because the engine query parser normalises `(a)<-[L]-(b)`
 *  to v1=b, v2=a while the canvas keeps the edge as drawn (source=a). Re-
 *  ordering hops to run canvas-source → canvas-target would make every arrow
 *  assert the opposite of what the data says (e.g. "Post -REPLY_OF-> Comment"),
 *  so the hops are never flipped; `reversed` says which end is the query edge's
 *  source instead. */
export interface OrientedWitness {
  /** Data direction: vertices[h] -[edgeLabels[h]]-> vertices[h+1]. */
  vertices: number[];
  edgeLabels: string[];
  vertexLabels: string[];
  /** Number of real graph hops (vertices.length - 1) */
  hops: number;
  /** true when `vertices[0]` is the query edge's TARGET — i.e. the data runs
   *  target → source of the edge as it is drawn on the canvas. */
  reversed: boolean;
}

function orient(
  ep: EdgeWitnessPath, srcVid: number, tgtVid: number,
): OrientedWitness | null {
  const vs = ep.vertices;
  // A zero-hop witness (src === dst under a `*` automaton with min_length 0)
  // has nothing to draw; the solver no longer emits one, and if an older
  // backend does it falls back to the query edge's own single arrow.
  if (!vs || vs.length < 2) return null;
  const last = vs.length - 1;
  let reversed: boolean;
  if (vs[0] === srcVid && vs[last] === tgtVid) reversed = false;
  else if (vs[0] === tgtVid && vs[last] === srcVid) reversed = true;
  else return null;

  const els = ep.edge_labels ?? [];
  // A path with n vertices must carry n-1 hop labels. Anything else is
  // malformed; drop it rather than render a path with mislabelled hops.
  if (els.length !== vs.length - 1) return null;
  const vls = ep.vertex_labels ?? [];
  const paddedVls = vls.length === vs.length ? vls : vs.map(() => '');

  return {
    vertices: vs, edgeLabels: els, vertexLabels: paddedVls,
    hops: vs.length - 1, reversed,
  };
}

/** One hop of a witness, laid out left-to-right in the query edge's own
 *  source → target orientation but carrying the direction the data really
 *  flows. Lets a linear (text) renderer keep the bound endpoints where the
 *  reader expects them — leftmost is the query edge's source — while still
 *  drawing a truthful arrow for every hop. */
export interface WitnessHop {
  label: string;
  /** Vertex drawn on the LEFT of this hop. */
  fromVid: number;
  fromLabel: string;
  /** Vertex drawn on the RIGHT of this hop. */
  toVid: number;
  toLabel: string;
  /** false when the data runs right → left, i.e. the arrow must be "←". */
  forward: boolean;
  /** 1-based position of this hop along the regex, counted in data order. */
  regexHop: number;
}

/** Walk a witness in the query edge's canvas orientation (source first) without
 *  changing what any arrow asserts. */
export function witnessHopsSourceFirst(w: OrientedWitness): WitnessHop[] {
  const out: WitnessHop[] = [];
  for (let i = 0; i < w.hops; i++) {
    // Layout index i maps to data hop (hops-1-i) when the witness is reversed.
    const h = w.reversed ? w.hops - 1 - i : i;
    const l = w.reversed ? h + 1 : h;      // data-order index drawn on the left
    const r = w.reversed ? h : h + 1;      // ... and on the right
    out.push({
      label: w.edgeLabels[h] ?? '',
      fromVid: w.vertices[l], fromLabel: w.vertexLabels[l] ?? '',
      toVid: w.vertices[r], toLabel: w.vertexLabels[r] ?? '',
      forward: !w.reversed,
      regexHop: h + 1,
    });
  }
  return out;
}

/** Find the witness path the solver reconstructed for query edge `queryEdgeIdx`.
 *
 *  `edge_index` is authoritative for *which* query edge a witness belongs to
 *  (backend and canvas both key off the `query_edges` array order), but its
 *  orientation is not: the engine query parser swaps the endpoints of the "<-[L]-"
 *  form. Endpoints are therefore always verified against the sample's bindings,
 *  the mismatch recorded as `reversed`, and the witness rejected outright when
 *  neither orientation lines up — a rejected witness falls back to the plain
 *  single-arrow rendering rather than drawing a wrong path.
 *
 *  Returns null when there is no usable witness. */
export function witnessForQueryEdge(
  witnesses: EdgeWitnessPath[] | undefined,
  queryEdgeIdx: number,
  srcVid: number | undefined,
  tgtVid: number | undefined,
): OrientedWitness | null {
  if (!witnesses || witnesses.length === 0) return null;
  if (srcVid == null || tgtVid == null) return null;

  const byIndex = witnesses.find((w) => w.edge_index === queryEdgeIdx);
  if (byIndex) {
    const o = orient(byIndex, srcVid, tgtVid);
    if (o) return o;
  }
  // Defensive fallback: if the index did not line up (a backend that reorders
  // query edges, or a canvas edit that reordered them locally), accept any
  // witness whose endpoints match this edge's bindings.
  for (const w of witnesses) {
    const o = orient(w, srcVid, tgtVid);
    if (o) return o;
  }
  return null;
}
