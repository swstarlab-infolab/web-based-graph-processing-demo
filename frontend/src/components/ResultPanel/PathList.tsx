import { useRef, useEffect, useMemo, useState, type FC, type ReactNode } from 'react';
import type { SamplePath, WESamplePair, QueryResult, QueryGraph, Schema } from '../../types';
import { isWESamplePair, PATH_COLORS } from '../../types';
import type { PathAnnotation } from '../../utils/pathDiff';
import { getAnnotationAt, sampleStatus, summaryReason } from '../../utils/pathDiff';
import { witnessForQueryEdge, witnessHopsSourceFirst } from '../../utils/witnessPath';

interface PathListProps {
  result: QueryResult;
  hoveredPath: number | null;
  soloPath: number | null;
  onHoverPath: (index: number | null) => void;
  onClickPath: (index: number) => void;
  queryContext: QueryGraph | null;
  schema?: Schema | null;
  isDark?: boolean;
  /** Per-sample annotations for diff highlighting */
  annotations?: PathAnnotation[][];
  /** Show full "TypeName (id)" vertex labels instead of single-letter abbreviations */
  showFullLabels?: boolean;
  /** Numeric vid caption under each circle. Defaults to showFullLabels; the
   *  compare tab turns it off on its own, because there the ids are read from
   *  two side-by-side lists at once and become noise rather than reference. */
  showVertexIds?: boolean;
  /** Query-edge id -> "P1"/"P2", for labelling a plain result with the roles
   *  its word-equality counterpart uses. */
  weRoleByEdgeId?: Map<string, string> | null;
  /** Override sample index dot color (use a neutral color to reduce visual noise) */
  dotColor?: string;
}


// perHopLabel: resolve a single hop's display label from a concatenation regex.
// Leading fixed (non-quantified) parts anchor to the FIRST N hops;
// trailing fixed parts anchor to the LAST M hops;
// the quantified part in the middle fills all remaining hops.
// Also strips trailing quantifier chars from the returned part.
// e.g. "KNOWS*/HAS_INTEREST" with 3 hops → ["KNOWS","KNOWS","HAS_INTEREST"]
// e.g. "LIKES/REPLY_OF*" with 3 hops → ["LIKES","REPLY_OF","REPLY_OF"]

/** Extract the last simple edge label from a regex (used for schema inference on tgt vertex) */
function lastSimpleLabel(label: string): string {
  const s = label.replace(/([*+?]|\[\d*\.\.\d*\])$/, '');
  const inner = s.startsWith('(') && s.endsWith(')') ? s.slice(1, -1) : s;
  const parts = inner.split('/');
  const last = parts[parts.length - 1].replace(/([*+?]|\[\d*\.\.\d*\])$/, '');
  return last.includes('|') ? (last.split('|').pop() ?? last) : last;
}

/** Extract the first simple edge label from a regex (used for schema inference on src vertex) */
function firstSimpleLabel(label: string): string {
  const s = label.replace(/([*+?]|\[\d*\.\.\d*\])$/, '');
  const inner = s.startsWith('(') && s.endsWith(')') ? s.slice(1, -1) : s;
  const parts = inner.split('/');
  const first = parts[0].replace(/([*+?]|\[\d*\.\.\d*\])$/, '');
  return first.includes('|') ? first.split('|')[0] : first;
}
function perHopLabel(nfaLabel: string, hopIdx: number, totalHops?: number): string {
  const strip = (s: string) => (s ?? '').replace(/([*+?]|\[\d*\.\.\d*\])$/, '') || s || '';

  if (!nfaLabel) return '';
  if (!nfaLabel.includes('/')) return strip(nfaLabel);

  const parts = nfaLabel.split('/');
  const n = totalHops ?? parts.length;
  const isQuant = (p: string) => /([*+?]|\[\d*\.\.\d*\])$/.test(p);

  // Count leading fixed parts → anchor to beginning hops
  let fixedStart = 0;
  for (let i = 0; i < parts.length; i++) {
    if (isQuant(parts[i])) break;
    fixedStart++;
  }
  if (hopIdx < fixedStart) return strip(parts[hopIdx]);

  // Count trailing fixed parts (after the leading fixed section) → anchor to end hops
  let fixedEnd = 0;
  for (let i = parts.length - 1; i >= fixedStart; i--) {
    if (isQuant(parts[i])) break;
    fixedEnd++;
  }
  const startFixed = n - fixedEnd;
  if (hopIdx >= startFixed) {
    const partIdx = (parts.length - fixedEnd) + (hopIdx - startFixed);
    return strip(parts[Math.min(partIdx, parts.length - 1)]);
  }

  // Middle hops belong to the first quantified part. Clamp: when the path is
  // longer than an all-fixed label (e.g. stale samples vs "KNOWS/KNOWS"),
  // fixedStart == parts.length and indexing would return undefined.
  return strip(parts[Math.min(fixedStart, parts.length - 1)]);
}

function getEdgeLabel(
  idx: number,
  queryContext: QueryGraph | null,
  queryType: string,
  totalHops?: number,
): string {
  if (!queryContext) return '';
  if (queryType === 'rpq' || queryType === 'word_equality') {
    return perHopLabel(queryContext.edges[0]?.label ?? '', idx, totalHops);
  }
  const srcId = queryContext.vertices[idx]?.id;
  const tgtId = queryContext.vertices[idx + 1]?.id;
  const qEdge = queryContext.edges.find(
    (e) => (e.source === srcId && e.target === tgtId) ||
           (e.source === tgtId && e.target === srcId),
  );
  return qEdge?.label ?? '';
}

/** Infer vertex type using the intersection of
 *  incoming edge's target types ∩ outgoing edge's source types.
 *  Either argument may be undefined (source/target of the full path).
 */
function inferVertexTypeAtPos(
  inEdgeLabel: string | undefined,
  outEdgeLabel: string | undefined,
  schema: Schema | null | undefined,
): string | null {
  if (!schema?.edge_endpoints) return null;
  const getTypes = (lbl: string, role: 'source' | 'target'): Set<string> => {
    const pairs = schema.edge_endpoints![lbl] ?? [];
    return new Set(pairs.map((p) => p[role]));
  };
  const fromIn  = inEdgeLabel  ? getTypes(inEdgeLabel,  'target') : null;
  const fromOut = outEdgeLabel ? getTypes(outEdgeLabel, 'source') : null;
  let candidates: Set<string>;
  if (fromIn && fromOut) {
    const inter = new Set([...fromOut].filter((t) => fromIn!.has(t)));
    candidates = inter.size > 0 ? inter : (fromOut.size > 0 ? fromOut : fromIn);
  } else {
    candidates = fromOut ?? fromIn ?? new Set();
  }
  if (candidates.size === 0) return null;
  return [...candidates][0]; // pick first (or only) candidate
}

function deriveVertexLabel(
  vid: number,
  posInPath: number,
  pathLen: number,
  queryContext: QueryGraph | null,
  queryType: string,
  schema?: Schema | null,
  edgeLabels?: string[],
  backendType?: string,
): string {
  if (backendType && backendType.toLowerCase() !== 'any') return `${backendType} (${vid})`;
  if (!queryContext) return `v${vid}`;

  let label: string | undefined;
  if (queryType === 'crpq') {
    label = queryContext.vertices[posInPath]?.label;
  } else if (posInPath === 0) {
    label = queryContext.vertices[0]?.label;
  } else if (posInPath === pathLen) {
    const lastIdx = queryContext.vertices.length - 1;
    label = queryContext.vertices[lastIdx >= 0 ? lastIdx : 0]?.label;
  }

  if (label && label.toLowerCase() !== 'any') return `${label} (${vid})`;

  if (schema?.edge_endpoints && edgeLabels) {
    const inEdge  = posInPath > 0       ? edgeLabels[posInPath - 1] : undefined;
    const outEdge = posInPath < pathLen  ? edgeLabels[posInPath]     : undefined;
    const inferred = inferVertexTypeAtPos(inEdge, outEdge, schema);
    if (inferred) return `${inferred} (${vid})`;
  }

  return `v${vid}`;
}

/** Render a witness waypoint as "TypeName (vid)" so parseVertexInfo can split it. */
function witnessVertexText(vid: number, label: string | undefined): string {
  return label && label.toLowerCase() !== 'any' ? `${label} (${vid})` : `v${vid}`;
}

type PathElement = {
  type: 'vertex' | 'edge';
  text: string;
  secondary?: boolean;
  /** Edge only: the data runs right → left, so draw "←label←". Set on witness
   *  hops of a query edge written in the "(a)<-[L]-(b)" form. */
  reversed?: boolean;
  /** Vertex only: prefix-WE freeze point — P1 legally ends here while P2
   *  continues. Rendered as a double ring. */
  terminal?: boolean;
  /** Edge only: connective structure rather than one of the compared paths --
   *  the linking edge of a different-source word equality. Drawn dashed. */
  linking?: boolean;
  /** Vertex only (CRPQ): this query vertex was already drawn earlier in the
   *  flow. 'cycle' = the chain closes back onto its own start (gets a '⟲');
   *  'shared' = re-mention of an earlier vertex in a different chain. */
  closure?: 'shared' | 'cycle';
};

/** One hop of a path laid out per hop: the arrow that enters a vertex plus the
 *  vertex it lands on. Column k of the WE pair grid renders exactly hops[k]. */
type HopCell = { edge: PathElement; vertex: PathElement };
type HopStructuredPath = { source: PathElement; hops: HopCell[] };

/** Hop-structured form of the per-hop rendering: { source, [{edge, vertex}] }.
 *  Reuses perHopLabel / deriveVertexLabel unchanged; formatPathElements
 *  flattens this for the linear renderers. */
function formatPathHops(
  path: SamplePath,
  queryContext: QueryGraph | null,
  effectiveQueryType: string,
  overrideEdgeLabel?: string,
  schema?: Schema | null,
): HopStructuredPath {
  const pathLen = path.vertices.length - 1;
  const edgeLabelsArr: string[] = [];
  for (let i = 0; i < pathLen; i++) {
    const fallback = overrideEdgeLabel != null
      ? perHopLabel(overrideEdgeLabel, i, pathLen)
      : getEdgeLabel(i, queryContext, effectiveQueryType, pathLen);
    const rawLabel = path.edge_labels?.[i] ?? fallback;
    edgeLabelsArr.push(perHopLabel(rawLabel, i, pathLen));
  }
  const vertexAt = (i: number): PathElement => ({
    type: 'vertex',
    text: deriveVertexLabel(path.vertices[i], i, pathLen, queryContext, effectiveQueryType, schema, edgeLabelsArr, path.vertex_types?.[i]),
  });
  const hops: HopCell[] = [];
  for (let i = 0; i < pathLen; i++) {
    hops.push({
      // Vertices are in traversal order; a PREPEND automaton traverses the
      // graph backwards, so a hop the solver flagged runs right → left in the
      // data and has to be drawn "←label←". Missing array = every hop runs
      // with the data.
      edge: { type: 'edge', text: edgeLabelsArr[i], reversed: path.edge_reversed?.[i] ?? false },
      vertex: vertexAt(i + 1),
    });
  }
  return { source: vertexAt(0), hops };
}

function formatPathElements(
  path: SamplePath,
  queryContext: QueryGraph | null,
  queryType: string,
  overrideEdgeLabel?: string,
  schema?: Schema | null,
  /** Query-edge id -> "P1"/"P2".  The compare tab's plain side renders the same
   *  query without its word-equality constraint, so nothing in the result says
   *  which chain the extended side will call P1; this carries that over. */
  weRoleByEdgeId?: Map<string, string> | null,
): PathElement[] {
  const elements: PathElement[] = [];
  const pathLen = path.vertices.length - 1;

  // Detect fully-expanded paths: kernel provided per-hop edge labels + all intermediate vertices.
  // In this case path.vertices has one entry per hop (not one per query variable), so we render
  // per-hop regardless of queryType (e.g. CRPQ P-LIKES/REPLY_OF*->C becomes P→LIKES→M→REPLY_OF→M).
  const isExpandedCrpq =
    queryType === 'crpq' &&
    path.edge_labels != null &&
    path.edge_labels.length > 0 &&
    path.vertices.length === path.edge_labels.length + 1;

  if (queryType === 'crpq' && queryContext && !isExpandedCrpq) {
    const nv = queryContext.vertices.length;
    // Chain consecutive query edges into connected flows instead of one
    // '|'-separated segment per edge: an edge whose SOURCE is the previous
    // chain end continues the flow (junction vertex drawn once); an edge whose
    // TARGET is the chain end is drawn flipped — target first — with every
    // arrow inverted so it still asserts the data direction. Only edges that
    // connect to nothing start a new '|'-separated chain, so triangle cycles
    // read as one loop that closes with '⟲' instead of three disjoint lines.
    type ChainLink = { qEdge: (typeof queryContext.edges)[number]; ei: number; flipped: boolean };
    const remaining = queryContext.edges
      .map((qEdge, ei) => ({ qEdge, ei }))
      .filter(({ qEdge }) => {
        const srcIdx = queryContext.vertices.findIndex((v) => v.id === qEdge.source);
        const tgtIdx = queryContext.vertices.findIndex((v) => v.id === qEdge.target);
        return srcIdx >= 0 && tgtIdx >= 0 && srcIdx < path.vertices.length && tgtIdx < path.vertices.length;
      });
    const chains: ChainLink[][] = [];
    while (remaining.length > 0) {
      const chain: ChainLink[] = [{ ...remaining.shift()!, flipped: false }];
      let endQid = chain[0].qEdge.target;
      for (;;) {
        // Prefer continuing forward (source === chain end) so regex display
        // labels keep their natural reading order; flip only when that is the
        // sole way to stay connected.
        let idx = remaining.findIndex((r) => r.qEdge.source === endQid);
        let flipped = false;
        if (idx < 0) { idx = remaining.findIndex((r) => r.qEdge.target === endQid); flipped = true; }
        if (idx < 0) break;
        const nxt = remaining.splice(idx, 1)[0];
        chain.push({ ...nxt, flipped });
        endQid = flipped ? nxt.qEdge.source : nxt.qEdge.target;
      }
      chains.push(chain);
    }
    const pushedQids = new Set<string>();
    const pushVertex = (qid: string, text: string, closesOwnChain: boolean) => {
      const el: PathElement = { type: 'vertex', text };
      if (pushedQids.has(qid)) el.closure = closesOwnChain ? 'cycle' : 'shared';
      else pushedQids.add(qid);
      elements.push(el);
    };
    for (let ci = 0; ci < chains.length; ci++) {
      const chain = chains[ci];
      if (ci > 0) elements.push({ type: 'edge', text: ',' });
      const chainStartQid = chain[0].qEdge.source;
      for (let li = 0; li < chain.length; li++) {
        const { qEdge, ei, flipped } = chain[li];
        const srcIdx = queryContext.vertices.findIndex((v) => v.id === qEdge.source);
        const tgtIdx = queryContext.vertices.findIndex((v) => v.id === qEdge.target);
        // Build edge-label arrays sized to nv so schema inference gets correct in/out edges
        // for vertices whose queryContext label is 'Any'. Ignore backendType (often computed wrong
        // for CRPQ since the backend applies the regex as if vertices are a linear path).
        const firstLbl = firstSimpleLabel(qEdge.label);
        const lastLbl  = lastSimpleLabel(qEdge.label);
        const srcEL = new Array<string>(nv).fill('');
        srcEL[srcIdx] = firstLbl;                          // outgoing edge for srcIdx
        const tgtEL = new Array<string>(nv).fill('');
        if (tgtIdx > 0) tgtEL[tgtIdx - 1] = lastLbl;      // incoming edge before tgtIdx
        const srcLabel = deriveVertexLabel(path.vertices[srcIdx], srcIdx, nv - 1, queryContext, queryType, schema, srcEL, undefined);
        const tgtLabel = deriveVertexLabel(path.vertices[tgtIdx], tgtIdx, nv - 1, queryContext, queryType, schema, tgtEL, undefined);
        const leftQid  = flipped ? qEdge.target : qEdge.source;
        const rightQid = flipped ? qEdge.source : qEdge.target;
        // The first link opens the chain with its left vertex; every later link
        // starts at the junction vertex the previous link already drew.
        if (li === 0) pushVertex(leftQid, flipped ? tgtLabel : srcLabel, false);
        // Display label: show the human-readable regex pattern (e.g. "KNOWS*", "KNOWS*→HAS_INTEREST→HAS_TYPE")
        // instead of the automata name (e.g. "P1", "P2") so the plain CRPQ side is readable.
        const quantSuffix = qEdge.quantifier === '1' ? '' : qEdge.quantifier;
        const rawEdgeLabel = qEdge.alternateLabels?.length
          ? `(${qEdge.label}|${qEdge.alternateLabels.join('|')})${quantSuffix}`
          : (qEdge.originalNFA
            ? qEdge.label.replace(/\//g, '→')
            : `${qEdge.label}${quantSuffix}`);
        const weRole = weRoleByEdgeId?.get(qEdge.id) ?? null;
        // With the roles known, anything that is neither P1 nor P2 is the edge
        // that links their two sources -- draw it as structure, not as a path.
        const isLinkingEdge = weRoleByEdgeId != null && weRole == null;
        const displayEdgeLabel = weRole ? `${weRole} ${rawEdgeLabel}` : rawEdgeLabel;
        // A regex query edge is one arrow here but a multi-hop path in the graph.
        // When the solver handed us the real path, spell out its hops so the two
        // views agree on how long the match actually is. One-hop witnesses are
        // left as the regex ("KNOWS*") — the arrow count is already right and the
        // pattern is the more useful thing to show.
        // The hops are laid out source-first (target-first for flipped links)
        // but each arrow still points the way the DATA goes: a query edge
        // written "(a)<-[L]-(b)" is stored by the parser as v1=b, v2=a, so its
        // witness runs right → left here and is drawn "←L←".
        const w = witnessForQueryEdge(path.edge_paths, ei, path.vertices[srcIdx], path.vertices[tgtIdx]);
        if (w && w.hops > 1) {
          let hops = witnessHopsSourceFirst(w);
          if (flipped) {
            // Lay the same hops out target-first; swapping the drawn endpoints
            // and inverting `forward` keeps every arrow asserting the same
            // real edge, just read right-to-left.
            hops = hops.slice().reverse().map((h) => ({
              ...h, fromVid: h.toVid, fromLabel: h.toLabel,
              toVid: h.fromVid, toLabel: h.fromLabel, forward: !h.forward,
            }));
          }
          for (let h = 0; h < hops.length; h++) {
            const hopText = h === 0 && weRole ? `${weRole} ${hops[h].label}` : hops[h].label;
            elements.push({ type: 'edge', text: hopText, reversed: !hops[h].forward, linking: isLinkingEdge });
            if (h < hops.length - 1) {
              elements.push({
                type: 'vertex', secondary: true,
                text: witnessVertexText(hops[h].toVid, hops[h].toLabel),
              });
            }
          }
        } else {
          // Single-hop (or no) witness: keep the regex as the label. When a
          // witness did verify the endpoints we know which way the one hop runs,
          // so the arrow follows it; with no witness at all the arrow keeps the
          // query edge's canvas orientation, exactly as before. A flipped link
          // shows the same hop from the other end, so its arrow inverts too.
          const dataReversed = w?.reversed ?? false;
          elements.push({ type: 'edge', text: displayEdgeLabel, reversed: flipped ? !dataReversed : dataReversed, linking: isLinkingEdge });
        }
        pushVertex(rightQid, flipped ? srcLabel : tgtLabel, rightQid === chainStartQid && li > 0);
      }
    }
  } else {
    // RPQ / WE / expanded-CRPQ: render per hop.
    // For expanded CRPQ use 'rpq' semantics in deriveVertexLabel so the first/last vertices
    // get their type from queryContext.vertices[0/last] and intermediates use schema inference.
    const effectiveQueryType = isExpandedCrpq ? 'rpq' : queryType;
    const hp = formatPathHops(path, queryContext, effectiveQueryType, overrideEdgeLabel, schema);
    elements.push(hp.source);
    for (const h of hp.hops) {
      elements.push(h.edge);
      elements.push(h.vertex);
    }
  }
  return elements;
}

/** Parse "TypeName (vid)" or "vXXX" into { typeName, vid } */
function parseVertexInfo(text: string): { typeName: string; vid: string } {
  const m = text.match(/^(\w+)\s+\((\d+)\)$/);
  if (m) return { typeName: m[1], vid: m[2] };
  const m2 = text.match(/^v?(\d+)$/);
  return { typeName: '', vid: m2 ? m2[1] : text };
}

/** Build a hover title like "Person(12) - KNOWS - Person(287)" from elements */
function buildPathTitle(elements: PathElement[]): string {
  const parts: string[] = [];
  for (const el of elements) {
    if (el.text === ',') { parts.push('|'); continue; }
    if (el.type === 'vertex') {
      const { typeName, vid } = parseVertexInfo(el.text);
      parts.push(typeName ? `${typeName}(${vid})` : `v${vid}`);
    } else {
      parts.push(el.reversed ? `<- ${el.text} <-` : `- ${el.text} -`);
    }
  }
  return parts.join(' ').replace(/ - (.*?) - /g, (_, lbl) => ` - ${lbl} - `).trim();
}

import { weRoleColor, edgeLabelColor } from '../../utils/graphColors';
import {
  PATH_TOKENS, VertexCircle, EdgeChip, EdgeLegend,
  vertexAccent, mutedInk, dimInk, dimVertexInk, VIOLATION_INK,
  type EdgeTone,
} from './pathPrimitives';

/** Right-edge overflow hint, surface-independent: fades the content itself. */
const FADE_MASK = 'linear-gradient(to right, #000 calc(100% - 28px), transparent 100%)';

/** Annotation kind → the tone the shared primitives understand. */
function toneOf(ann: PathAnnotation | undefined): EdgeTone {
  if (ann?.kind === 'equality_violation') return 'violation';
  if (ann?.kind === 'length_exceeded') return 'dim';
  return 'normal';
}

/** Inline text path: "Person →KNOWS→ Person →KNOWS→ Person" with hover for IDs.
 *  Every primitive comes from pathPrimitives so a plain RPQ row, a CRPQ chain
 *  row and a WE grid row draw the same circle and the same arrow. */
const PathDiagram: FC<{
  elements: PathElement[];
  isDark: boolean;
  annotations?: PathAnnotation[];
  /** Full path string shown on hover over any vertex abbreviation */
  pathTitle?: string;
  /** Full type names rather than single-letter abbreviations */
  showFullLabels?: boolean;
  /** Numeric vid under each circle */
  showVertexIds?: boolean;
}> = ({ elements, isDark, annotations, pathTitle, showFullLabels, showVertexIds }) => {
  // Map element index back to hop (edge) index for annotation lookup
  let edgeCount = 0;

  return (
    <span
      className="path-diagram inline-flex items-center flex-wrap font-mono"
      style={{ columnGap: PATH_TOKENS.hopGap, rowGap: PATH_TOKENS.wrapGap }}
    >
      {elements.map((el, i) => {
        if (el.type === 'vertex') {
          const { typeName, vid } = parseVertexInfo(el.text);
          const fullLabel = typeName ? `${typeName} (${vid})` : `v${vid}`;
          const ann = annotations ? getAnnotationAt(annotations, edgeCount) : undefined;
          const isExceeded = ann?.kind === 'length_exceeded';
          // Witness waypoints are real vertices but not bound query variables —
          // render them smaller and faded so the bound ones stay the headline.
          const sec = el.secondary === true;
          const vertexNode = (
            <VertexCircle
              key={i}
              typeName={typeName}
              vid={vid}
              isDark={isDark}
              size={sec ? 'sm' : 'md'}
              dim={isExceeded}
              // A re-drawn query vertex (chain junction / cycle closure) gets
              // the shared double-ring treatment so both mentions read as one
              // vertex.
              ring={el.closure ? 'closure' : null}
              showCaption={showVertexIds === true && !sec}
              title={ann ? `${ann.reason}\n${pathTitle ?? fullLabel}` : (pathTitle ?? fullLabel)}
            />
          );
          if (el.closure === 'cycle') {
            // The flow closes back onto this circle — say so explicitly.
            const c = isExceeded ? dimVertexInk(isDark) : vertexAccent(typeName, isDark);
            return (
              <span key={i} className="path-cycle inline-flex items-center shrink-0" style={{ gap: PATH_TOKENS.hopGap }}>
                {vertexNode}
                <span
                  className="cursor-default"
                  style={{ fontSize: PATH_TOKENS.arrowFont, lineHeight: 1, color: c, opacity: 0.85 }}
                  title={`closes the cycle at ${fullLabel}`}
                >
                  ⟲
                </span>
              </span>
            );
          }
          return vertexNode;
        }
        if (el.type === 'edge') {
          if (el.text === ',') {
            edgeCount = 0;
            return (
              <span
                key={i}
                className="path-chain-sep"
                style={{ color: dimInk(isDark), fontSize: PATH_TOKENS.arrowFont, lineHeight: 1 }}
              >
                |
              </span>
            );
          }
          const hopIdx = edgeCount;
          edgeCount++;
          const ann = annotations ? getAnnotationAt(annotations, hopIdx) : undefined;
          // `reversed` hops belong to a query edge whose data direction runs
          // right → left; drawing "→" there would assert an edge that does not
          // exist in the graph.
          return (
            <EdgeChip
              key={i}
              label={el.text}
              reversed={el.reversed}
              isDark={isDark}
              tone={ann ? toneOf(ann) : (el.linking ? 'linking' : 'normal')}
              color={el.linking ? undefined : edgeLabelColor(el.text, isDark)}
              title={ann?.reason}
            />
          );
        }
        return null;
      })}
    </span>
  );
};

/** A plain CRPQ sample expressed in the word-equality pair shape.
 *
 *  The compare tab shows one query with and without its equality constraint;
 *  laying both sides out the same way is the whole point of putting them side
 *  by side. This reads the sample's OWN witnesses -- no second query, no
 *  invented pairing -- so the plain column shows exactly what the plain run
 *  returned, only in two rows instead of one flat chain.
 *
 *  Returns null when the context carries no equality (an ordinary CRPQ, which
 *  has no P1/P2 to split into) or the bindings do not line up. */
function crpqSampleAsWePair(
  sample: SamplePath,
  queryContext: QueryGraph | null,
): WESamplePair | null {
  const wec = queryContext?.weConstraints?.[0];
  if (!wec || !queryContext) return null;

  const bindingOf = (qid: string): number | undefined => {
    const i = queryContext.vertices.findIndex((v) => v.id === qid);
    return i >= 0 ? sample.vertices[i] : undefined;
  };

  const pathFor = (edgeId: string): SamplePath | null => {
    const ei = queryContext.edges.findIndex((e) => e.id === edgeId);
    if (ei < 0) return null;
    const qe = queryContext.edges[ei];
    const sv = bindingOf(qe.source);
    const tv = bindingOf(qe.target);
    if (sv == null || tv == null) return null;
    const w = witnessForQueryEdge(sample.edge_paths, ei, sv, tv);
    if (w) {
      return { vertices: w.vertices, edge_labels: w.edgeLabels, vertex_labels: w.vertexLabels };
    }
    // No reconstructed witness: keep the query edge as its single arrow, the
    // same thing the flat renderer falls back to.
    return { vertices: [sv, tv], edge_labels: [qe.label], vertex_labels: [] };
  };

  const path1 = pathFor(wec.edge1Id);
  const path2 = pathFor(wec.edge2Id);
  if (!path1 || !path2) return null;

  // Whatever is neither P1 nor P2 is the edge joining the two sources. A
  // same-source equality simply has no such edge.
  const linkEdge = queryContext.edges.find(
    (e) => e.id !== wec.edge1Id && e.id !== wec.edge2Id,
  );
  const ls = linkEdge ? bindingOf(linkEdge.source) : undefined;
  const lt = linkEdge ? bindingOf(linkEdge.target) : undefined;

  return {
    path1,
    path2,
    src_vid: path1.vertices[0],
    ...(linkEdge && ls != null && lt != null
      ? { linking_edge: { vertices: [ls, lt], label: linkEdge.label } }
      : {}),
  };
}

/** Hop-aligned WE pair grid: P1 and P2 rendered as two column-locked rows of a
 *  single CSS grid so hop k of P1 sits exactly above hop k of P2, with the
 *  shared label sequence written once underneath. The shared source is drawn
 *  ONCE spanning both rows (same-source) or as two circles joined by the
 *  dotted linking edge (diff-source) — same vocabulary the graph view uses. */
const WEPairBlock: FC<{
  sample: WESamplePair;
  queryContext: QueryGraph | null;
  queryType: string;
  weEdgeLabels: { p1Name: string; p2Name: string; p1Label: string; p2Label: string } | null;
  schema?: Schema | null;
  isDark: boolean;
  annotations?: PathAnnotation[];
  showFullLabels?: boolean;
  showVertexIds?: boolean;
}> = ({ sample, queryContext, queryType, weEdgeLabels, schema, isDark: d, annotations, showFullLabels, showVertexIds }) => {
  const wec = queryContext?.weConstraints?.[0];
  const isSameSource = wec ? wec.sourceConstraint !== 'different' : sample.linking_edge == null;
  const isPrefix = wec?.type === 'prefix';

  const p1 = formatPathHops(sample.path1, queryContext, queryType, weEdgeLabels?.p1Label, schema);
  const p2 = formatPathHops(sample.path2, queryContext, queryType, weEdgeLabels?.p2Label, schema);
  const maxHops = Math.max(p1.hops.length, p2.hops.length, 1);
  // Every distinct hop label in this block gets a number (first appearance,
  // P1 then P2) and the graph view's per-label colour. Arrows carry the
  // number and colour; the label text is written once, in the legend below.
  // This replaced a shared-label row whose labels overflowed their narrow
  // arrow columns and ran into each other ("HAS_INTERESTHAS_TYPE").
  const labelIndex = new Map<string, number>();
  for (const hp of [p1, p2]) for (const h of hp.hops) if (!labelIndex.has(h.edge.text)) labelIndex.set(h.edge.text, labelIndex.size + 1);
  const legendEntries = [...labelIndex.entries()].map(([label, n]) => ({ n, label, color: edgeLabelColor(label, d) }));
  // Prefix WE: P1 legally freezes at its last vertex while P2 continues.
  if (isPrefix) (p1.hops.length > 0 ? p1.hops[p1.hops.length - 1].vertex : p1.source).terminal = true;

  const flat = (hp: HopStructuredPath) => [hp.source, ...hp.hops.flatMap((h) => [h.edge, h.vertex])];
  const title1 = buildPathTitle(flat(p1));
  const title2 = buildPathTitle(flat(p2));

  // Linking edge between the two path sources (diff-source WE) + any leftover
  // extra query edges that do NOT join the two sources (rare; plain fallback).
  const src1 = sample.path1.vertices[0];
  const src2 = sample.path2.vertices[0];
  let linkLabel: string | null = null;
  let linkTitle = '';
  const fallbackExtras: Array<{ label: string; sv: number; tv: number; srcType: string | null; tgtType: string | null }> = [];
  if (queryContext && wec) {
    const weIds = new Set([wec.edge1Id, wec.edge2Id]);
    const extras = queryContext.edges.filter((e) => !weIds.has(e.id));
    const p1e = queryContext.edges.find((e) => e.id === wec.edge1Id);
    const p2e = queryContext.edges.find((e) => e.id === wec.edge2Id);
    const qvm = new Map<string, number>();
    if (p1e) { qvm.set(p1e.source, sample.path1.vertices[0]); qvm.set(p1e.target, sample.path1.vertices[sample.path1.vertices.length - 1]); }
    if (p2e) { qvm.set(p2e.source, sample.path2.vertices[0]); qvm.set(p2e.target, sample.path2.vertices[sample.path2.vertices.length - 1]); }
    for (const qe of extras) {
      const sv = qvm.get(qe.source), tv = qvm.get(qe.target);
      if (sv == null || tv == null || sv === tv) continue;
      const joinsSources = !isSameSource && ((sv === src1 && tv === src2) || (sv === src2 && tv === src1));
      if (joinsSources && linkLabel == null) {
        linkLabel = qe.label;
        linkTitle = `v(${src1}) - ${qe.label} - v(${src2})`;
        continue;
      }
      const srcQv = queryContext.vertices.find((v) => v.id === qe.source);
      const tgtQv = queryContext.vertices.find((v) => v.id === qe.target);
      fallbackExtras.push({
        label: qe.label, sv, tv,
        srcType: srcQv?.label && srcQv.label.toLowerCase() !== 'any' ? srcQv.label : null,
        tgtType: tgtQv?.label && tgtQv.label.toLowerCase() !== 'any' ? tgtQv.label : null,
      });
    }
  }
  if (!isSameSource && linkLabel == null && sample.linking_edge) {
    linkLabel = sample.linking_edge.label;
    linkTitle = `v(${src1}) - ${linkLabel} - v(${src2})`;
  }

  // Overflow discoverability: subtle right-edge fade while more columns hide
  // to the right (SSR/first paint: hidden until measured).
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showFade, setShowFade] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const check = () => setShowFade(el.scrollWidth - el.clientWidth - el.scrollLeft > 4);
    check();
    el.addEventListener('scroll', check, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(check) : null;
    ro?.observe(el);
    return () => { el.removeEventListener('scroll', check); ro?.disconnect(); };
  }, [maxHops]);

  const ink = mutedInk(d);
  // One gap for P1→P2 and for P2→shared labels, in BOTH source modes: the same
  // datum must not sit 3px under its hop in one mode and 14px in the other.
  // A dotted connector needs vertical room the default gap does not have: the
  // label chip alone is 13px inside 16px, which left nothing beside it and is
  // why the segments used to be anchored at the circle centres and drawn
  // straight through them.  Only the different-source layout draws one, and
  // this grid has just the two rows, so widening here moves nothing else.
  const hasConnector = !isSameSource && linkLabel != null;
  const rowGap = PATH_TOKENS.weRowGap + (hasConnector ? 20 : 0);
  // Row height, and therefore where the fork tips and the dotted connector have
  // to land, grows when the vid captions are on.
  const rowH = PATH_TOKENS.vertex + (showVertexIds ? PATH_TOKENS.captionGap + PATH_TOKENS.captionFont : 0);
  const blockH = rowH * 2 + rowGap;

  /** Endpoint circle. `annHop` is the grid column whose length annotation grays
   *  this circle (source circles pass null). */
  const circleNode = (el: PathElement, rowColor: string, annHop: number | null, title: string, key?: string | number) => {
    const { typeName, vid } = parseVertexInfo(el.text);
    const ann = annotations != null && annHop != null ? getAnnotationAt(annotations, annHop) : undefined;
    return (
      <VertexCircle
        key={key}
        typeName={typeName}
        vid={vid}
        isDark={d}
        dim={ann?.kind === 'length_exceeded'}
        // Prefix-WE freeze point: double ring — P1 ends here, P2 continues.
        ring={el.terminal ? 'terminal' : null}
        ringColor={rowColor}
        showCaption={showVertexIds === true}
        className={el.terminal ? 'we-p1-terminal' : undefined}
        title={el.terminal ? `${title}\nP1 ends here — its word is a prefix of P2's` : (ann ? `${ann.reason}\n${title}` : title)}
      />
    );
  };

  const arrowNode = (edge: PathElement, hopIdx: number) => {
    const ann = annotations != null ? getAnnotationAt(annotations, hopIdx) : undefined;
    return (
      <EdgeChip
        label={edge.text}
        reversed={edge.reversed}
        isDark={d}
        tone={toneOf(ann)}
        showLabel={false}
        color={edgeLabelColor(edge.text, d)}
        badge={labelIndex.get(edge.text)}
        title={ann?.reason ?? edge.text}
      />
    );
  };

  // Role colours come from the SAME helper the graph's WE legend uses, so the
  // pastel P1/P2 blues do not sit washed-out on a white card in light mode.
  const p1Color = weRoleColor('path1', d);
  const p2Color = weRoleColor('path2', d);
  const rows = [
    { hp: p1, name: weEdgeLabels?.p1Name ?? 'P1', color: p1Color, row: 1, title: title1 },
    { hp: p2, name: weEdgeLabels?.p2Name ?? 'P2', color: p2Color, row: 2, title: title2 },
  ];

  const cells: ReactNode[] = [];
  for (const { hp, name, color, row, title } of rows) {
    cells.push(
      <span
        key={`name${row}`}
        className="we-row-name font-bold self-center"
        style={{ gridRow: row, gridColumn: 1, color, borderLeft: `2px solid ${color}50`, paddingLeft: 4, paddingRight: 6, fontSize: 12, lineHeight: 1 }}
      >
        {name}
      </span>,
    );
    for (let k = 0; k < maxHops; k++) {
      const hop = hp.hops[k];
      if (hop) {
        cells.push(
          // justify-self:center — the hop and the label that names it live in
          // the same grid column, so both centre and stay registered even when
          // a long label (IS_LOCATED_IN) widens the column past the hop.
          <span key={`h${row}_${k}`} className="we-hop inline-flex items-center" style={{ gridRow: row, gridColumn: 3 + k, justifySelf: 'center' }}>
            {arrowNode(hop.edge, k)}
            {/* PathDiagram grays vertex i by the annotation of hop i (the hop it
                opens); this vertex closes hop k, i.e. opens hop k+1. */}
            {circleNode(hop.vertex, color, k + 1, title)}
          </span>,
        );
      } else {
        // This path ended before column k. For prefix WE the dim dashes ARE the
        // point: P1's word stopped while P2 kept going. The cell mirrors a real
        // hop (hidden arrow + a circle-sized box) so the dashes sit exactly
        // where the missing circle would have been.
        cells.push(
          <span key={`h${row}_${k}`} className="we-hop we-hop-missing inline-flex items-center" style={{ gridRow: row, gridColumn: 3 + k, justifySelf: 'center' }}>
            <span aria-hidden style={{ visibility: 'hidden' }}>
              <EdgeChip label="" isDark={d} showLabel={false} badge={1} />
            </span>
            <span
              className="we-hop-dash inline-flex items-center justify-center shrink-0 font-mono cursor-default"
              style={{ width: PATH_TOKENS.vertex, height: PATH_TOKENS.vertex, fontSize: PATH_TOKENS.labelFont, lineHeight: 1, color: dimInk(d), opacity: 0.55, letterSpacing: 1 }}
              title={isPrefix && row === 1 ? 'P1 already ended — prefix satisfied' : 'path ended'}
            >
              ––
            </span>
          </span>,
        );
      }
    }
  }

  // Source column (2): drawn once spanning both rows when shared, or two
  // circles joined by the dotted linking edge when the sources differ.
  if (isSameSource) {
    // Fork tips are placed from the SAME tokens the rows use, so they land on
    // the two row centres instead of on a hard-coded 36px guess.
    const forkW = 12;
    const cy = blockH / 2;
    const y1 = PATH_TOKENS.vertex / 2;
    const y2 = blockH - PATH_TOKENS.vertex / 2 - (rowH - PATH_TOKENS.vertex);
    cells.push(
      <span key="src" className="we-shared-source inline-flex items-center" style={{ gridRow: '1 / span 2', gridColumn: 2, alignSelf: 'stretch', justifySelf: 'center' }}>
        {circleNode(p1.source, p1Color, null, `${title1}\n${title2}`)}
        {/* fork glyph: the one source feeds both rows */}
        <svg className="we-fork shrink-0" width={forkW} height={blockH} viewBox={`0 0 ${forkW} ${blockH}`} fill="none" aria-hidden>
          <path d={`M1 ${cy} C6 ${cy} 6 ${y1} ${forkW - 1} ${y1}`} stroke={p1Color} strokeWidth="1.5" strokeLinecap="round" />
          <path d={`M1 ${cy} C6 ${cy} 6 ${y2} ${forkW - 1} ${y2}`} stroke={p2Color} strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </span>,
    );
  } else {
    cells.push(
      <span key="src1" style={{ gridRow: 1, gridColumn: 2, justifySelf: 'center' }}>
        {circleNode(p1.source, p1Color, null, title1)}
      </span>,
      <span key="src2" style={{ gridRow: 2, gridColumn: 2, justifySelf: 'center' }}>
        {circleNode(p2.source, p2Color, null, title2)}
      </span>,
      // Dotted neutral connector — the linking edge that actually joins the two
      // sources, drawn the same way the graph view draws it. It runs between the
      // two circle CENTRES: with two equal rows and one gap those sit at
      // (100% - gap)/4 from each end, whatever the captions do to the row
      // height. The line is drawn as two segments with an 18px hole in the
      // middle instead of one line masked by an opaque chip — a mask has to
      // guess the card colour and gets it wrong on hover and on solo.
      <span key="srclink" className="we-link-connector" style={{ gridRow: '1 / span 2', gridColumn: 2, justifySelf: 'stretch', alignSelf: 'stretch', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 0 }}>
        {/* Start below circle 1 and stop above circle 2 rather than at their
            centres: a circle is translucent, so a connector anchored at the
            centre shows through the glyph inside it. Each circle occupies the
            top PATH_TOKENS.vertex px of its row, so those are the two insets --
            and unlike a percentage they stay right when a vid caption makes the
            row taller. */}
        {(() => {
          // Pixels, not percentages: a circle sits in the top PATH_TOKENS.vertex
          // of its row, so the two ends are known exactly and stay right when a
          // vid caption makes the row taller.  Mixing px against `calc(50% ...)`
          // is what silently gave both segments a negative height and dropped
          // the line altogether.
          const CHIP_HALF = 9;
          const mid = blockH / 2;
          const spans = [
            { key: 'a', top: PATH_TOKENS.vertex + 2, end: mid - CHIP_HALF },
            { key: 'b', top: mid + CHIP_HALF,        end: rowH + rowGap - 2 },
          ];
          return spans
            .filter((sp) => sp.end - sp.top > 1)
            .map((sp) => (
              <span
                key={sp.key}
                aria-hidden
                className="we-link-line"
                style={{ position: 'absolute', top: sp.top, height: sp.end - sp.top,
                         left: '50%', width: 0, borderLeft: `2px dotted ${ink}` }}
              />
            ));
        })()}
        {linkLabel != null && (
          <span
            className="we-link-chip relative rounded border font-semibold"
            style={{ fontSize: PATH_TOKENS.captionFont, lineHeight: 1, height: PATH_TOKENS.captionFont + 4, paddingLeft: 4, paddingRight: 4, display: 'inline-flex', alignItems: 'center', borderColor: d ? '#475569' : '#cbd5e1', borderStyle: 'dashed', color: ink }}
            title={linkTitle}
          >
            {linkLabel}
          </span>
        )}
      </span>,
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {/* Overflow hint: fade the CONTENT out with a mask instead of painting an
          opaque veil in a guessed card colour — the card is gray-800/20 when
          idle, /40 on hover and cyan-900/20 when solo, so a veil is wrong in
          two of those three states. */}
      <div
        ref={scrollRef}
        className="we-scroll overflow-x-auto"
        style={{
          scrollbarWidth: 'thin',
          ...(showFade ? { maskImage: FADE_MASK, WebkitMaskImage: FADE_MASK } : {}),
        }}
      >
        <div
          className="we-pair-grid grid w-max items-center font-mono pr-2"
          style={{ gridTemplateColumns: `max-content max-content repeat(${maxHops}, max-content)`, rowGap, columnGap: 0 }}
        >
          {cells}
        </div>
      </div>
      {legendEntries.length > 0 && <EdgeLegend entries={legendEntries} isDark={d} />}
      {/* Extra query edges that do NOT join the two path sources — plain rows,
          neutral slate + dashed to match the linking vocabulary. */}
      {fallbackExtras.length > 0 && (
        <div className={`pt-1.5 mt-0.5 border-t flex flex-col gap-1 ${d ? 'border-gray-700/50' : 'border-gray-200'}`}>
          {fallbackExtras.map((x, ei) => {
            const srcAbbrev = showFullLabels ? (x.srcType ?? `v${x.sv}`) : (x.srcType ? x.srcType[0].toUpperCase() : String(x.sv));
            const tgtAbbrev = showFullLabels ? (x.tgtType ?? `v${x.tv}`) : (x.tgtType ? x.tgtType[0].toUpperCase() : String(x.tv));
            return (
              <div key={ei} className="we-fallback-link flex items-center gap-2 font-mono" style={{ fontSize: PATH_TOKENS.arrowFont }} title={`${x.srcType ?? 'v'}(${x.sv}) - ${x.label} - ${x.tgtType ?? 'v'}(${x.tv})`}>
                <span className="font-bold uppercase tracking-widest w-5 shrink-0" style={{ color: ink, fontSize: PATH_TOKENS.captionFont }}>link</span>
                <span style={{ color: ink }} title={`${x.srcType ?? 'v'}(${x.sv})`}>{srcAbbrev}</span>
                <span style={{ color: ink, opacity: 0.5 }}>┄</span>
                <span className="rounded border font-semibold" style={{ fontSize: PATH_TOKENS.labelFont, lineHeight: 1, paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2, borderColor: d ? '#475569' : '#cbd5e1', borderStyle: 'dashed', color: ink }}>
                  {x.label}
                </span>
                <span style={{ color: ink, opacity: 0.5 }}>┄</span>
                <span style={{ color: ink }} title={`${x.tgtType ?? 'v'}(${x.tv})`}>{tgtAbbrev}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const PathList: FC<PathListProps> = ({
  result,
  hoveredPath,
  soloPath,
  onHoverPath,
  onClickPath,
  queryContext,
  schema,
  isDark = true,
  annotations: sampleAnnotations,
  showFullLabels = false,
  showVertexIds,
  weRoleByEdgeId,
  dotColor,
}) => {
  const captionIds = showVertexIds ?? showFullLabels;
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll selected path into view when soloPath changes externally (e.g., from graph click)
  useEffect(() => {
    if (soloPath === null || !listRef.current) return;
    const row = listRef.current.querySelector(`[data-path-idx="${soloPath}"]`);
    row?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [soloPath]);

  const weEdgeLabels = (() => {
    // Not gated on query_type: the compare tab's plain side is a CRPQ that
    // still has P1 and P2 to name, and it is handed the extended context.
    if (!queryContext) return null;
    const wec = queryContext.weConstraints[0];
    if (!wec) return null;
    const e1 = queryContext.edges.find((e) => e.id === wec.edge1Id);
    const e2 = queryContext.edges.find((e) => e.id === wec.edge2Id);
    return {
      p1Name: e1?.automataName ?? 'P1',
      p2Name: e2?.automataName ?? 'P2',
      p1Label: e1?.label ?? '?',
      p2Label: e2?.label ?? '?',
    };
  })();

  // Detect which annotation kinds are present for legend
  const annotationKinds = useMemo(() => {
    if (!sampleAnnotations) return new Set<string>();
    const kinds = new Set<string>();
    for (const anns of sampleAnnotations) {
      for (const a of anns) kinds.add(a.kind);
    }
    return kinds;
  }, [sampleAnnotations]);

  const d = isDark;
  return (
    <div className={`flex flex-col h-full ${d ? 'bg-gray-900' : 'bg-white'}`}>
      {/* Minimal header */}
      <div className={`flex items-center justify-between px-3 py-1.5 border-b shrink-0 ${d ? 'border-gray-700/80 bg-gray-800/40' : 'border-gray-200 bg-gray-50'}`}>
        <span className={`text-xs font-bold uppercase tracking-wider ${d ? 'text-gray-400' : 'text-gray-500'}`}>
          Sample Paths
        </span>
        <span className={`text-xs ${d ? 'text-gray-600' : 'text-gray-400'}`}>
          click to highlight
        </span>
      </div>

      {/* Annotation legend — shown only when annotations exist */}
      {annotationKinds.size > 0 && (
        <div className={`flex items-center gap-3 px-3 py-1 border-b shrink-0 ${d ? 'border-gray-800 bg-gray-800/20' : 'border-gray-100 bg-gray-50/50'}`}>
          {/* The swatch IS the mark: a red "≠" for a broken equality, a dimmed
              circle+dashes for a hop past the limit. A colored dot explained
              neither, because neither mark is a dot. */}
          {annotationKinds.has('equality_violation') && (
            <span className="flex items-center gap-1.5 text-[11px] font-medium" style={{ color: VIOLATION_INK }}>
              <span className="font-mono font-bold" style={{ fontSize: PATH_TOKENS.arrowFont, lineHeight: 1 }}>≠</span>
              Different label sequence
            </span>
          )}
          {annotationKinds.has('length_exceeded') && (
            <span className="flex items-center gap-1.5 text-[11px] font-medium" style={{ color: dimInk(d) }}>
              <span className="inline-flex items-center gap-0.5">
                <span
                  className="inline-block rounded-full"
                  style={{
                    width: 10, height: 10,
                    backgroundColor: dimVertexInk(d) + '20',
                    border: `1.5px solid ${dimVertexInk(d)}60`,
                    opacity: 0.6,
                  }}
                />
                <span className="font-mono" style={{ fontSize: PATH_TOKENS.labelFont, lineHeight: 1, opacity: 0.6 }}>––</span>
              </span>
              Exceeds hop limit
            </span>
          )}
        </div>
      )}

      {/* Path list */}
      <div ref={listRef} className="flex-1 overflow-y-auto">
        {result.samples.length === 0 && (
          <div className={`text-sm text-center py-8 ${d ? 'text-gray-500' : 'text-gray-400'}`}>
            <p>No sample paths available</p>
            <p className={`text-xs mt-1 ${d ? 'text-gray-600' : 'text-gray-400'}`}>
              Count and timing are available above
            </p>
          </div>
        )}


        {result.samples.map((sample, idx) => {
          const color = dotColor ?? PATH_COLORS[idx % PATH_COLORS.length];
          const isSolo = soloPath === idx;
          const isFaded = soloPath !== null && soloPath !== idx;
          // Hovering the graph sets hoveredPath upstream; mirror it here so the
          // highlight is symmetric instead of list → graph only.
          const isHovered = hoveredPath === idx;
          const isWE = isWESamplePair(sample);
          // A plain CRPQ beside its equality counterpart is laid out the same
          // way, so the two columns can be read against each other.
          const pairView: WESamplePair | null = isWE
            ? sample
            : crpqSampleAsWePair(sample, queryContext);

          // Per-sample annotation status
          const sampleAnns = sampleAnnotations?.[idx];
          const showStatus = sampleAnns != null && sampleAnns.length >= 0;
          const status = showStatus ? sampleStatus(sampleAnns) : null;
          const reason = showStatus ? summaryReason(sampleAnns) : '';

          const violationBadge = showStatus && status !== 'accepted' && reason ? (
            <span className={`text-[10px] leading-tight ${
              status === 'equality_violation' ? 'text-red-400' : 'text-gray-400'
            }`}>
              {reason}
            </span>
          ) : null;

          return (
            <div key={idx} data-path-idx={idx} className="px-2 py-1">
              <div
                className={`cursor-pointer rounded-xl border transition-all duration-100 ${
                  isSolo
                    ? d ? 'border-cyan-500/50 bg-cyan-900/20' : 'border-cyan-400/40 bg-cyan-50'
                    : isFaded ? 'opacity-25'
                    : isHovered
                      ? d ? 'border-gray-600/50 bg-gray-800/40' : 'border-gray-300 bg-gray-50 shadow-sm'
                      : d ? 'border-gray-700/40 bg-gray-800/20 hover:border-gray-600/50 hover:bg-gray-800/40'
                          : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50 shadow-sm'
                }`}
                onMouseEnter={() => onHoverPath(idx)}
                onMouseLeave={() => onHoverPath(null)}
                onClick={() => onClickPath(idx)}
              >
                <div className="flex items-start gap-2 px-3 py-2.5">
                  {/* Left: index + color dot */}
                  <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
                    <span className={`text-[10px] w-4 text-right font-mono ${d ? 'text-gray-600' : 'text-gray-400'}`}>
                      {idx + 1}
                    </span>
                    <span
                      className="inline-block w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: color }}
                    />
                  </div>

                  {/* Right: visual path + badges */}
                  <div className="flex-1 min-w-0">
                    {pairView ? (
                      <div className="flex flex-col gap-1.5">
                        <WEPairBlock
                          sample={pairView}
                          queryContext={queryContext}
                          queryType={result.query_type}
                          weEdgeLabels={weEdgeLabels}
                          schema={schema}
                          isDark={d}
                          annotations={sampleAnnotations?.[idx]}
                          showFullLabels={showFullLabels}
                          showVertexIds={captionIds}
                        />
                        {/* Violation reason for WE paths */}
                        {violationBadge && <div className="mt-0.5">{violationBadge}</div>}
                      </div>
                    ) : isWESamplePair(sample) ? null : (
                      <div className="flex flex-col gap-0.5">
                        {(() => {
                          const elems = formatPathElements(sample, queryContext, result.query_type, undefined, schema, weRoleByEdgeId);
                          return (
                            <PathDiagram elements={elems} isDark={d} annotations={sampleAnnotations?.[idx]} pathTitle={buildPathTitle(elems)} showFullLabels={showFullLabels} showVertexIds={captionIds} />
                          );
                        })()}
                        {violationBadge}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

    </div>
  );
};

export default PathList;
