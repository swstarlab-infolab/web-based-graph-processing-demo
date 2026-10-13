import { useRef, useEffect, useLayoutEffect, useMemo, useCallback, useState, type FC, type MutableRefObject } from 'react';
import cytoscape from 'cytoscape';
// @ts-ignore — no type declarations for cytoscape-elk
import elk from 'cytoscape-elk';
import type { QueryResult, QueryGraph, Schema, SamplePath } from '../../types';

cytoscape.use(elk);
import { isWESamplePair, PATH_COLORS } from '../../types';
import {
  getNodeColor, getNodeDeepColor, edgeLabelColor, weRoleColor,
  GRAPH_BG_DARK, GRAPH_BG_LIGHT,
  graphCanvasBackground, graphToolbarButtonClass,
} from '../../utils/graphColors';
import { safeDestroyCy, runElkLayout } from '../../utils/cySafeLayout';
import { witnessForQueryEdge } from '../../utils/witnessPath';
import { fetchNeighborhood, type NeighborhoodResponse } from '../../utils/api';

/* ---- shared helpers ---- */

// perHopLabel: resolve a single hop's display label from a concatenation regex.
// "/" is the concatenation operator. Fixed (non-quantified) parts at the END anchor to the
// last N hops; the first (possibly quantified) part fills all remaining hops.
// e.g. "KNOWS*/HAS_INTEREST" with 3 hops → ["KNOWS","KNOWS","HAS_INTEREST"]
function perHopLabel(label: string, hopIdx: number, totalHops?: number): string {
  const strip = (s: string) => s.replace(/([*+?]|\[\d*\.\.\d*\])$/, '') || s;
  if (!label.includes('/')) return strip(label);
  const parts = label.split('/');
  const n = totalHops ?? parts.length;
  const isQuant = (p: string) => /([*+?]|\[\d*\.\.\d*\])$/.test(p);
  let fixedEnd = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (isQuant(parts[i])) break;
    fixedEnd++;
  }
  const startFixed = n - fixedEnd;
  if (hopIdx >= startFixed) {
    const partIdx = (parts.length - fixedEnd) + (hopIdx - startFixed);
    return strip(parts[Math.min(partIdx, parts.length - 1)]);
  }
  return strip(parts[0]);
}

function deriveEdgeLabels(
  pathLen: number, queryContext: QueryGraph | null, queryType: string, weRole?: 'path1' | 'path2',
): string[] {
  if (!queryContext) return Array(pathLen).fill('');
  if (queryType === 'word_equality') {
    const wec = queryContext.weConstraints[0];
    const edgeId = weRole === 'path2' ? wec?.edge2Id : wec?.edge1Id;
    const qEdge = edgeId ? queryContext.edges.find((e) => e.id === edgeId) : queryContext.edges[0];
    const rawLabel = qEdge?.label ?? '';
    return Array.from({ length: pathLen }, (_, i) => perHopLabel(rawLabel, i, pathLen));
  }
  if (queryType === 'rpq') {
    const rawLabel = queryContext.edges[0]?.label ?? '';
    return Array.from({ length: pathLen }, (_, i) => perHopLabel(rawLabel, i, pathLen));
  }
  return Array.from({ length: pathLen }, (_, i) => {
    const srcId = queryContext.vertices[i]?.id;
    const tgtId = queryContext.vertices[i + 1]?.id;
    const qEdge = queryContext.edges.find(
      (e) => (e.source === srcId && e.target === tgtId) || (e.source === tgtId && e.target === srcId),
    );
    return perHopLabel(qEdge?.label ?? '', i, pathLen);
  });
}

function inferVertexTypeAtPos(
  inEdgeLabel: string | undefined,
  outEdgeLabel: string | undefined,
  schema: Schema | null,
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
  vid: number, posInPath: number, pathLen: number,
  queryContext: QueryGraph | null, queryType: string, schema?: Schema | null, edgeLabels?: string[],
  backendType?: string,
): string {
  if (backendType && backendType.toLowerCase() !== 'any') return `${backendType} (${vid})`;
  if (!queryContext) return `v${vid}`;
  let label: string | undefined;
  if (queryType === 'crpq') label = queryContext.vertices[posInPath]?.label;
  else if (posInPath === 0) label = queryContext.vertices[0]?.label;
  else if (posInPath === pathLen) {
    const lastIdx = queryContext.vertices.length - 1;
    label = queryContext.vertices[lastIdx >= 0 ? lastIdx : 0]?.label;
  }
  if (label && label.toLowerCase() !== 'any') return `${label} (${vid})`;
  if (schema?.edge_endpoints && edgeLabels) {
    const inEdge  = posInPath > 0      ? edgeLabels[posInPath - 1] : undefined;
    const outEdge = posInPath < pathLen ? edgeLabels[posInPath]     : undefined;
    const inferred = inferVertexTypeAtPos(inEdge, outEdge, schema);
    if (inferred) return `${inferred} (${vid})`;
  }
  return `v${vid}`;
}

interface CyNode {
  id: string; vid: number; vertexType: string; color: string; fill: string;
  paths: number[];
  /** Query variable this vertex is bound to (CRPQ), e.g. "person1" */
  qvName?: string;
  /** This vertex also appears in another sample's subgraph */
  shared?: boolean;
  /** Waypoint on a witness path — real, but not bound to a query variable */
  intermediate?: boolean;
}
interface CyEdge {
  id: string; source: string; target: string; label: string; color: string; pathIdx: number;
  isLinking?: boolean; weRole?: 'path1' | 'path2';
  /** e.g. "hop 2/3 of KNOWS*" — set on witness hops */
  hopInfo?: string;
}

function buildCyElements(
  result: QueryResult, queryContext: QueryGraph | null, schema: Schema | null | undefined,
  isDark: boolean,
): { nodes: CyNode[]; edges: CyEdge[] } {
  // Accent color carries mode-aware contrast; fill stays pastel in both modes
  const accentFor = (type: string) => (isDark ? getNodeColor(type) : getNodeDeepColor(type));
  const nodeMap = new Map<string, CyNode>();
  const edges: CyEdge[] = [];

  // Node ids are scoped to their sample so each sample renders as its own
  // complete subgraph. Sharing ids across samples fused unrelated matches
  // into a single blob — and, because CRPQ vids are block-local, could fuse
  // genuinely different vertices that happen to share a local id.
  const nodeKey = (pathIdx: number, vid: number) => `s${pathIdx}_n${vid}`;

  function addPath(path: SamplePath, pathIdx: number, weRole?: 'path1' | 'path2') {
    const numEdges = Math.max(0, path.vertices.length - 1);
    const edgeLabels = deriveEdgeLabels(numEdges, queryContext, result.query_type, weRole);
    const isCrpq = result.query_type === 'crpq';

    for (let i = 0; i < path.vertices.length; i++) {
      const vid = path.vertices[i];
      const nodeId = nodeKey(pathIdx, vid);
      if (!nodeMap.has(nodeId)) {
        const fullLabel = deriveVertexLabel(vid, i, numEdges, queryContext, result.query_type, schema, edgeLabels, path.vertex_types?.[i]);
        const typeName = fullLabel.includes(' (') ? fullLabel.split(' (')[0] : fullLabel;
        nodeMap.set(nodeId, {
          id: nodeId, vid, vertexType: typeName,
          color: accentFor(typeName), fill: getNodeColor(typeName), paths: [pathIdx],
          ...(isCrpq ? { qvName: queryContext?.vertices[i]?.id } : {}),
        });
      }
    }

    if (isCrpq && queryContext) {
      const witnesses = path.edge_paths;
      // A plain CRPQ rendered next to its word-equality counterpart still knows
      // which of its edges the WE calls P1 and P2 (the compare tab hands this
      // view the extended context). Anything outside that pair is the edge
      // linking the two sources -- structure, not a compared path.
      const wec = queryContext.weConstraints?.[0];
      const weRoleOf = (edgeId: string): 'path1' | 'path2' | null =>
        !wec ? null
          : edgeId === wec.edge1Id ? 'path1'
          : edgeId === wec.edge2Id ? 'path2'
          : null;

      queryContext.edges.forEach((qEdge, qIdx) => {
        const qRole = weRoleOf(qEdge.id);
        const qLinking = wec != null && qRole == null;
        const srcIdx = queryContext.vertices.findIndex((v) => v.id === qEdge.source);
        const tgtIdx = queryContext.vertices.findIndex((v) => v.id === qEdge.target);
        if (srcIdx < 0 || tgtIdx < 0 || srcIdx >= path.vertices.length || tgtIdx >= path.vertices.length) return;
        const displayLabel = qEdge.label.replace(/\//g, '→');

        // A CRPQ sample binds one vertex per query variable; when the solver
        // also reconstructed the real path behind a query edge, draw that path
        // hop by hop instead of one synthetic arrow. Waypoints become nodes of
        // their own, still scoped to this sample by nodeKey().
        const w = witnessForQueryEdge(witnesses, qIdx, path.vertices[srcIdx], path.vertices[tgtIdx]);
        if (w) {
          for (let h = 0; h < w.vertices.length; h++) {
            const wvid = w.vertices[h];
            const wNodeId = nodeKey(pathIdx, wvid);
            // The two endpoints (and any waypoint that happens to also be a
            // bound variable) were already added above — never downgrade them
            // to an intermediate, their qvName has to stay.
            if (nodeMap.has(wNodeId)) continue;
            const raw = w.vertexLabels[h] ?? '';
            const typeName = raw && raw.toLowerCase() !== 'any' ? raw : '';
            nodeMap.set(wNodeId, {
              id: wNodeId, vid: wvid, vertexType: typeName,
              color: accentFor(typeName), fill: getNodeColor(typeName),
              paths: [pathIdx], intermediate: true,
            });
          }
          // Hops are drawn in the solver's order, which is the TRUE DATA
          // DIRECTION. Re-pointing them at the query edge's canvas orientation
          // would flip every arrowhead on a "(a)<-[L]-(b)" edge (the parser
          // stores that form as v1=b, v2=a) and make each hop claim an edge
          // that does not exist.
          for (let h = 0; h < w.hops; h++) {
            const lbl = w.edgeLabels[h] ?? '';
            edges.push({
              id: `e${edges.length}`,
              source: nodeKey(pathIdx, w.vertices[h]), target: nodeKey(pathIdx, w.vertices[h + 1]),
              label: lbl,
              // Role colour when the WE names this edge, so the plain side and
              // the extended side paint the same chain the same way.
              color: qRole ? weRoleColor(qRole, isDark) : edgeLabelColor(lbl, isDark),
              pathIdx,
              ...(qRole ? { weRole: qRole } : {}),
              ...(qLinking ? { isLinking: true } : {}),
              ...(w.hops > 1 ? { hopInfo: `hop ${h + 1}/${w.hops} of ${displayLabel}` } : {}),
            });
          }
          return;
        }

        edges.push({
          id: `e${edges.length}`,
          source: nodeKey(pathIdx, path.vertices[srcIdx]), target: nodeKey(pathIdx, path.vertices[tgtIdx]),
          label: displayLabel,
          color: qRole ? weRoleColor(qRole, isDark) : edgeLabelColor(displayLabel, isDark),
          pathIdx,
          ...(qRole ? { weRole: qRole } : {}),
          ...(qLinking ? { isLinking: true } : {}),
        });
      });
    } else {
      for (let i = 0; i < numEdges; i++) {
        const lbl = path.edge_labels?.[i] != null
          ? perHopLabel(path.edge_labels[i], i, numEdges)
          : edgeLabels[i] ?? '';
        // `vertices` stays in traversal order (nodes and their per-sample
        // nodeKey scoping are untouched), but a PREPEND automaton walks the
        // graph backwards: for a flagged hop the grid edge runs
        // vertices[i+1] -> vertices[i], so swap the endpoints to point the
        // arrowhead the way the data goes.
        const rev = path.edge_reversed?.[i] ?? false;
        const a = nodeKey(pathIdx, path.vertices[i]);
        const b = nodeKey(pathIdx, path.vertices[i + 1]);
        // WE pair paths are colored by role (P1 blue / P2 pink) so the two
        // sides of the equality constraint stand apart; other edges by label.
        edges.push({
          id: `e${edges.length}`,
          source: rev ? b : a, target: rev ? a : b,
          label: lbl, color: weRole ? weRoleColor(weRole, isDark) : edgeLabelColor(lbl, isDark), pathIdx,
          ...(weRole ? { weRole } : {}),
        });
      }
    }
  }

  // For WE queries, identify non-path query edges (e.g. KNOWS) to render between samples
  const weExtraEdges: Array<{ sourceQV: string; targetQV: string; label: string }> = [];
  if (result.query_type === 'word_equality' && queryContext && queryContext.weConstraints.length > 0) {
    const weEdgeIds = new Set<string>();
    for (const wec of queryContext.weConstraints) {
      weEdgeIds.add(wec.edge1Id);
      weEdgeIds.add(wec.edge2Id);
    }
    for (const qe of queryContext.edges) {
      if (!weEdgeIds.has(qe.id)) {
        weExtraEdges.push({ sourceQV: qe.source, targetQV: qe.target, label: qe.label });
      }
    }
  }

  for (let i = 0; i < result.samples.length; i++) {
    const sample = result.samples[i];
    if (isWESamplePair(sample)) {
      addPath(sample.path1, i, 'path1');
      addPath(sample.path2, i, 'path2');

      // Add non-path query edges (e.g. KNOWS between v1, v2) using query graph vertex mapping
      if (weExtraEdges.length > 0 && queryContext) {
        const wec = queryContext.weConstraints[0];
        const p1Edge = queryContext.edges.find(e => e.id === wec?.edge1Id);
        const p2Edge = queryContext.edges.find(e => e.id === wec?.edge2Id);
        // Map query vertex IDs → sample vertex IDs
        const qvMap = new Map<string, number>();
        if (p1Edge) {
          qvMap.set(p1Edge.source, sample.path1.vertices[0]);
          qvMap.set(p1Edge.target, sample.path1.vertices[sample.path1.vertices.length - 1]);
        }
        if (p2Edge) {
          qvMap.set(p2Edge.source, sample.path2.vertices[0]);
          qvMap.set(p2Edge.target, sample.path2.vertices[sample.path2.vertices.length - 1]);
        }
        for (const extra of weExtraEdges) {
          const srcVid = qvMap.get(extra.sourceQV);
          const tgtVid = qvMap.get(extra.targetQV);
          if (srcVid == null || tgtVid == null || srcVid === tgtVid) continue;
          for (const [vid, qvId] of [[srcVid, extra.sourceQV], [tgtVid, extra.targetQV]] as const) {
            const nodeId = nodeKey(i, vid);
            if (nodeMap.has(nodeId)) continue;
            const qv = queryContext.vertices.find(v => v.id === qvId);
            const vtype = (qv?.label && qv.label !== 'Any') ? qv.label : 'Person';
            nodeMap.set(nodeId, {
              id: nodeId, vid, vertexType: vtype, qvName: qvId,
              color: accentFor(vtype), fill: getNodeColor(vtype), paths: [i],
            });
          }
          edges.push({
            id: `e${edges.length}`, source: nodeKey(i, srcVid), target: nodeKey(i, tgtVid),
            label: extra.label, color: edgeLabelColor(extra.label, isDark), pathIdx: i, isLinking: true,
          });
        }
      }
    } else {
      addPath(sample, i);
    }
  }

  // Sample subgraphs are drawn separately, so mark vertices that recur in
  // other samples — the overlap between matches stays visible without
  // collapsing distinct matches into one component.
  const nodes = Array.from(nodeMap.values());
  const sampleCountByVid = new Map<number, Set<number>>();
  for (const n of nodes) {
    const set = sampleCountByVid.get(n.vid) ?? new Set<number>();
    set.add(n.paths[0]);
    sampleCountByVid.set(n.vid, set);
  }
  for (const n of nodes) {
    if ((sampleCountByVid.get(n.vid)?.size ?? 0) > 1) n.shared = true;
  }
  return { nodes, edges };
}

/* ---- neighbourhood context layer ---------------------------------- *
 * Opt-in faint backdrop of 1-hop incident edges around the matched
 * subgraph. Context elements carry the `.context` class, no `paths` and no
 * `pathIdx`, and are deliberately kept out of BOTH the solo highlight/dim
 * bookkeeping and every fit — turning the layer on must not move the camera
 * or change how the match itself reads.
 * ------------------------------------------------------------------- */

/** Total incident edges asked of the backend per seed vertex (both directions
 *  and all labels share this one budget). Small on purpose: this is a backdrop,
 *  not a browsable neighbourhood, and the budget is shared round-robin across
 *  edge labels so one high-degree label cannot hide the rest. */
const CONTEXT_MAX_PER_VERTEX = 10;
/** Hard ceiling on rendered context edges, so a hub vertex cannot bury the match. */
const CONTEXT_MAX_EDGES = 500;

/** Everything belonging to the match itself (i.e. not the context backdrop). */
function matchEles(cy: cytoscape.Core): cytoscape.CollectionReturnValue {
  return cy.elements().not('.context');
}

function strHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Turn a neighbourhood response into cytoscape elements laid out around the
 *  already-positioned match nodes. Deliberately does NOT run a layout: a
 *  relayout would move the match and jump the camera, so each new vertex is
 *  simply fanned out around the match node it hangs off. */
function buildContextElements(
  data: NeighborhoodResponse, nodes: CyNode[], edges: CyEdge[],
  cy: cytoscape.Core, isDark: boolean,
): cytoscape.ElementDefinition[] {
  const labelById = new Map<number, string>();
  for (const v of data.vertices ?? []) labelById.set(v.id, v.label ?? '');

  const matchByVid = new Map<number, CyNode[]>();
  for (const n of nodes) {
    const arr = matchByVid.get(n.vid);
    if (arr) arr.push(n); else matchByVid.set(n.vid, [n]);
  }
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const matchPairs = new Set(edges.map((e) => pairKey(e.source, e.target)));

  const ctxNodes = new Map<string, { def: cytoscape.ElementDefinition; anchorId: string }>();
  const ctxEdges: cytoscape.ElementDefinition[] = [];
  const seenEdge = new Set<string>();

  const declareCtxNode = (pathIdx: number, vid: number, anchorId: string): string => {
    const id = `ctxn_s${pathIdx}_n${vid}`;
    if (!ctxNodes.has(id)) {
      const raw = labelById.get(vid) ?? '';
      const typeName = raw && raw.toLowerCase() !== 'any' ? raw : '';
      ctxNodes.set(id, {
        anchorId,
        def: {
          group: 'nodes',
          data: {
            id, vid, label: '', typeLabel: typeName || 'vertex',
            color: isDark ? getNodeColor(typeName) : getNodeDeepColor(typeName),
            fill: getNodeColor(typeName),
            paths: '', qvName: '', shared: '',
          },
          classes: 'context',
          selectable: false, grabbable: false,
        },
      });
    }
    return id;
  };

  const pushCtxEdge = (a: string, b: string, label: string) => {
    if (ctxEdges.length >= CONTEXT_MAX_EDGES) return;
    // An edge the match already draws must not be shadowed by a faint copy.
    if (matchPairs.has(pairKey(a, b))) return;
    const k = `${a}>${b}|${label}`;
    if (seenEdge.has(k)) return;
    seenEdge.add(k);
    ctxEdges.push({
      group: 'edges',
      data: {
        id: `ctxe${ctxEdges.length}`, source: a, target: b,
        label, color: '', pathIdx: '', weRole: '', isLinking: '', hopInfo: '',
      },
      classes: 'context',
      selectable: false, grabbable: false,
    });
  };

  for (const e of data.edges ?? []) {
    if (ctxEdges.length >= CONTEXT_MAX_EDGES) break;
    const srcMatches = matchByVid.get(e.source);
    const tgtMatches = matchByVid.get(e.target);
    const label = e.label ?? '';

    if (srcMatches && tgtMatches) {
      // Both endpoints are matched vertices: a real edge between two bound
      // vertices that the pattern itself does not use. Only join them inside
      // the same sample so per-sample subgraph isolation survives.
      for (const sn of srcMatches) {
        for (const tn of tgtMatches) {
          if (sn.paths[0] !== tn.paths[0]) continue;
          pushCtxEdge(sn.id, tn.id, label);
        }
      }
    } else if (srcMatches) {
      for (const sn of srcMatches) {
        pushCtxEdge(sn.id, declareCtxNode(sn.paths[0], e.target, sn.id), label);
      }
    } else if (tgtMatches) {
      for (const tn of tgtMatches) {
        pushCtxEdge(declareCtxNode(tn.paths[0], e.source, tn.id), tn.id, label);
      }
    }
    // Neither endpoint in the match (shouldn't happen — every returned edge is
    // incident to a seed): nothing to anchor it to, so skip.
  }

  // A declared node whose edge was then suppressed (duplicate / already in the
  // match / over the cap) would render as a stray dot. Keep only used ones.
  const used = new Set<string>();
  for (const ce of ctxEdges) {
    const s = ce.data.source as string;
    const t = ce.data.target as string;
    if (ctxNodes.has(s)) used.add(s);
    if (ctxNodes.has(t)) used.add(t);
  }

  const byAnchor = new Map<string, string[]>();
  for (const [id, rec] of ctxNodes) {
    if (!used.has(id)) continue;
    const arr = byAnchor.get(rec.anchorId);
    if (arr) arr.push(id); else byAnchor.set(rec.anchorId, [id]);
  }

  // Nodes first: cytoscape needs both endpoints present when an edge restores.
  const defs: cytoscape.ElementDefinition[] = [];
  for (const [anchorId, ids] of byAnchor) {
    const anchor = cy.$id(anchorId);
    const base = anchor.length > 0 ? anchor.position() : { x: 0, y: 0 };
    const radius = 78 + Math.min(ids.length, 14) * 6;
    // Fan deterministically, with a per-anchor phase so adjacent anchors do
    // not produce overlapping spokes.
    const phase = (strHash(anchorId) % 360) * (Math.PI / 180);
    ids.forEach((id, i) => {
      const a = (2 * Math.PI * i) / ids.length + phase;
      const rec = ctxNodes.get(id)!;
      defs.push({
        ...rec.def,
        position: { x: base.x + radius * Math.cos(a), y: base.y + radius * Math.sin(a) },
      });
    });
  }
  defs.push(...ctxEdges);
  return defs;
}

/** One zoom ceiling for every fit — mismatched caps caused a visible
 *  large→small jump on tiny sample graphs (initial fit hit maxZoom=4,
 *  the follow-up highlight fit capped at 2.5). */
const MAX_FIT_ZOOM = 2.5;

function fitCapped(cy: cytoscape.Core, eles: cytoscape.CollectionArgument | undefined, padding: number) {
  // No explicit target means "frame the match" — never the context backdrop,
  // so switching the backdrop on/off leaves the camera exactly where it was.
  const target = eles ?? matchEles(cy);
  if (target.length === 0) return;
  cy.fit(target, padding);
  if (cy.zoom() > MAX_FIT_ZOOM) {
    cy.zoom(MAX_FIT_ZOOM);
    cy.center(target);
  }
}

/** Apply solo-path highlight/dim classes and frame the relevant elements. */
function applyHighlightAndFit(cy: cytoscape.Core, solo: number | null) {
  const match = matchEles(cy);
  match.removeClass('dimmed highlighted');
  if (solo === null) {
    fitCapped(cy, undefined, 40);
    return;
  }
  match.nodes().forEach((node) => {
    const paths = String(node.data('paths') ?? '').split(',').map(Number);
    if (paths.includes(solo)) node.addClass('highlighted');
    else node.addClass('dimmed');
  });
  match.edges().forEach((edge) => {
    if (Number(edge.data('pathIdx')) !== solo) edge.addClass('dimmed');
  });
  const highlighted = cy.nodes('.highlighted');
  if (highlighted.length > 0) fitCapped(cy, highlighted, 60);
}

export interface GraphRendererProps {
  result: QueryResult | null;
  soloPath: number | null;
  queryContext: QueryGraph | null;
  schema?: Schema | null;
  isDark?: boolean;
  onFitRef?: MutableRefObject<(() => void) | null>;
  onZoomToSoloRef?: MutableRefObject<(() => void) | null>;
  onSoloPathChange?: (pathIdx: number | null) => void;
  /** Dataset the result came from — needed to ask for graph context */
  datasetId?: string;
}

interface CyTooltip { x: number; y: number; title: string; subtitle: string; color: string }

const ForceGraphCytoscape: FC<GraphRendererProps> = ({
  result, soloPath, queryContext, schema, isDark = true, onFitRef, onZoomToSoloRef, onSoloPathChange,
  datasetId,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const d = isDark;
  const bgColor = d ? GRAPH_BG_DARK : GRAPH_BG_LIGHT;
  const [tooltip, setTooltip] = useState<CyTooltip | null>(null);
  const tooltipRef = useRef<CyTooltip | null>(null);
  const [graphReady, setGraphReady] = useState(false);

  // Neighbourhood context backdrop — opt in, default off.
  const [contextOn, setContextOn] = useState(false);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextData, setContextData] = useState<NeighborhoodResponse | null>(null);

  const { nodes, edges } = useMemo(() => {
    if (!result || result.samples.length === 0) return { nodes: [], edges: [] };
    return buildCyElements(result, queryContext, schema, d);
  }, [result, queryContext, schema, d]);

  // A new result invalidates the cached neighbourhood; start clean rather than
  // paint the previous match's surroundings around the new one.
  useEffect(() => {
    setContextOn(false);
    setContextData(null);
    setContextLoading(false);
  }, [result]);

  // WE legend info: present when samples are (path1, path2) equality pairs
  const wePair = useMemo(() => {
    if (!result) return null;
    const wec = queryContext?.weConstraints?.[0];
    if (!wec) return null;
    const isWePairs =
      result.query_type === 'word_equality' &&
      !result.synthesized_pairs &&
      result.samples.some(isWESamplePair);
    // The compare tab's plain side runs the SAME query minus the equality, so
    // its chains are still P1 and P2 and deserve the same vocabulary. It must
    // not claim the equality holds, though — `constrained` gates that phrase.
    // It reaches here either as a plain CRPQ or as frontend-paired samples;
    // both get the legend, neither gets the claim. A plain RPQ has no chains
    // to name and is the one case that drops out.
    const isPlainSide = result.query_type === 'crpq' || result.synthesized_pairs === true;
    if (!isWePairs && !isPlainSide) return null;
    const p1Name = queryContext?.edges.find((e) => e.id === wec.edge1Id)?.automataName || 'P1';
    const p2Name = queryContext?.edges.find((e) => e.id === wec.edge2Id)?.automataName || 'P2';
    // Diff-source WE: the dotted linking edge joins the two path sources —
    // name it in the legend so the dotted style has a vocabulary entry.
    const linkSample = result.samples.find(isWESamplePair);
    const hasLink = wec.sourceConstraint === 'different' || linkSample?.linking_edge != null;
    const linkLabel = hasLink ? (wec.linkingLabel ?? linkSample?.linking_edge?.label ?? 'link') : null;
    return {
      p1Name, p2Name, linkLabel,
      isPrefix: (wec.type ?? 'we') === 'prefix',
      constrained: isWePairs,
    };
  }, [result, queryContext]);

  // Latest soloPath for async layout callbacks (rebuild effect deps exclude it)
  const soloPathRef = useRef(soloPath);
  soloPathRef.current = soloPath;

  useEffect(() => {
    if (onFitRef) onFitRef.current = () => { const cy = cyRef.current; if (cy) fitCapped(cy, undefined, 40); };
  }, [onFitRef]);

  // Rebuild cytoscape instance when graph data changes
  useEffect(() => {
    safeDestroyCy(cyRef.current);
    cyRef.current = null;
    setTooltip(null);
    setGraphReady(false);
    if (!containerRef.current || nodes.length === 0) return;

    const cyNodes: cytoscape.ElementDefinition[] = nodes.map((n) => ({
      group: 'nodes',
      data: {
        id: n.id, vid: n.vid, label: n.vertexType.charAt(0), typeLabel: n.vertexType,
        color: n.color, fill: n.fill, paths: n.paths.join(','),
        qvName: n.qvName ?? '', shared: n.shared ? 'true' : '',
        intermediate: n.intermediate ? 'true' : '',
      },
      classes: [n.shared ? 'shared' : '', n.intermediate ? 'intermediate' : ''].filter(Boolean).join(' '),
    }));
    const cyEdges: cytoscape.ElementDefinition[] = edges.map((e) => ({
      group: 'edges',
      data: { id: e.id, source: e.source, target: e.target, label: e.label, color: e.color, pathIdx: String(e.pathIdx), isLinking: e.isLinking ? 'true' : '', weRole: e.weRole ?? '', hopInfo: e.hopInfo ?? '' },
      classes: [e.isLinking ? 'linking' : '', e.weRole === 'path2' ? 'we-p2' : ''].filter(Boolean).join(' '),
    }));

    const cy = cytoscape({
      container: containerRef.current,
      elements: [...cyNodes, ...cyEdges],
      autoungrabify: false,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'data(fill)',
            'background-opacity': d ? 0.2 : 0.35,
            'border-color': 'data(color)',
            'border-width': 2.5,
            'color': 'data(color)',
            'label': 'data(label)',
            'text-valign': 'center' as any,
            'text-halign': 'center' as any,
            'font-size': '17px',
            'font-family': 'ui-sans-serif, system-ui, sans-serif',
            'font-weight': 800 as any,
            'min-zoomed-font-size': 6,
            'width': 44,
            'height': 44,
            'underlay-color': 'data(color)' as any,
            'underlay-opacity': (d ? 0.1 : 0.07) as any,
            'underlay-padding': 0 as any,
            'underlay-shape': 'ellipse' as any,
            'overlay-opacity': 0,
          },
        },
        {
          selector: 'edge',
          style: {
            'line-color': 'data(color)',
            'line-cap': 'round' as any,
            'target-arrow-color': 'data(color)',
            'target-arrow-shape': 'triangle-backcurve' as any,
            'arrow-scale': 1.1,
            'curve-style': 'bezier' as any,
            'control-point-step-size': 75,
            'width': 2.2,
            'label': 'data(label)',
            'font-size': '13px',
            'font-family': 'ui-monospace, monospace',
            'min-zoomed-font-size': 8,
            'color': 'data(color)',
            'text-rotation': 'autorotate' as any,
            'text-background-color': bgColor,
            'text-background-opacity': 0.92,
            'text-background-shape': 'round-rectangle' as any,
            'text-background-padding': '4px',
            'overlay-opacity': 0,
          },
        },
        {
          // P2 stays solid.  P1 and P2 routinely traverse the same edges -- any
          // WE query over an undirected label like KNOWS does -- and a dashed
          // stroke laid over a solid one on identical geometry reads as visual
          // noise rather than as a second path.  Colour and the diamond arrow
          // carry the role on their own.
          selector: 'edge.we-p2',
          style: {
            'target-arrow-shape': 'diamond',
            'arrow-scale': 0.7,
          },
        },
        {
          selector: 'edge.linking',
          style: {
            'line-style': 'dotted' as any,
            'line-dash-pattern': [2, 5] as any,
            'target-arrow-shape': 'none',
            'source-arrow-shape': 'none',
            'width': 1.5,
            'opacity': 0.55,
          } as any,
        },
        {
          // Waypoint on a witness path: a real vertex, but not bound to a query
          // variable. Kept visibly secondary so the bound variables still read
          // as the answer. Declared BEFORE .shared/.dimmed/.highlighted so
          // those keep winning — cytoscape resolves per property by stylesheet
          // order (last matching rule wins), not by CSS specificity.
          selector: 'node.intermediate',
          style: {
            'width': 26,
            'height': 26,
            'font-size': '10px',
            'font-weight': 600 as any,
            'border-width': 1.5,
            'background-opacity': d ? 0.14 : 0.25,
            'underlay-opacity': 0 as any,
          } as any,
        },
        {
          // Same real vertex also matched in another sample's subgraph
          selector: 'node.shared',
          style: { 'border-style': 'double' as any, 'border-width': 5 } as any,
        },
        {
          // …re-scaled for the smaller waypoint circles (a 5px double border on
          // a 26px node swallows the node).
          selector: 'node.intermediate.shared',
          style: { 'border-style': 'double' as any, 'border-width': 3 } as any,
        },
        {
          selector: 'node.dimmed',
          style: { opacity: 0.08, 'underlay-opacity': 0 } as any,
        },
        {
          selector: 'edge.dimmed',
          style: { opacity: 0.15, 'text-opacity': 0.4 } as any,
        },
        {
          selector: '.highlighted',
          style: {
            'border-width': 3.5,
            'background-opacity': d ? 0.45 : 0.55,
            'width': 56,
            'height': 56,
            'underlay-opacity': 0.26,
            'underlay-padding': 0,
            'z-index': 999,
          } as any,
        },
        {
          // A highlighted waypoint must still stay smaller than the bound
          // variables around it, so re-assert size AFTER .highlighted. Only
          // geometry is touched — opacity and z-index stay with .highlighted,
          // and .dimmed (declared earlier, mutually exclusive with
          // .highlighted) is untouched either way.
          selector: 'node.intermediate.highlighted',
          style: {
            'width': 32,
            'height': 32,
            'border-width': 2,
            'font-size': '11px',
            'underlay-opacity': 0.16,
          } as any,
        },
        {
          // ---- neighbourhood context backdrop ----
          // Declared last: `.context` is never combined with .dimmed or
          // .highlighted (applyHighlightAndFit only walks matchEles(), which
          // excludes them), so nothing here can shadow those rules — and
          // nothing there can brighten the backdrop.
          // z-compound-depth 'bottom' sorts strictly below every match element
          // (cytoscape zsort: depth first, then node-over-edge, then z-index),
          // so the backdrop stays behind even the match's edges.
          // events:'no' makes it click- and hover-through: it reads as scenery.
          selector: 'node.context',
          style: {
            'width': 13,
            'height': 13,
            'label': '',
            'background-color': 'data(fill)',
            'background-opacity': d ? 0.4 : 0.55,
            'border-color': 'data(color)',
            'border-width': 1,
            'border-style': 'solid',
            'opacity': d ? 0.24 : 0.3,
            'underlay-opacity': 0,
            'z-compound-depth': 'bottom',
            'z-index': 0,
            'events': 'no',
          } as any,
        },
        {
          selector: 'edge.context',
          style: {
            'width': 1,
            'label': '',
            'line-color': d ? '#64748b' : '#94a3b8',
            'line-style': 'solid',
            'curve-style': 'bezier',
            'target-arrow-shape': 'none',
            'source-arrow-shape': 'none',
            'opacity': d ? 0.2 : 0.26,
            'text-opacity': 0,
            'z-compound-depth': 'bottom',
            'z-index': 0,
            'events': 'no',
          } as any,
        },
      ],
      minZoom: 0.1,
      maxZoom: 4,
      userZoomingEnabled: true,
      userPanningEnabled: true,
    });

    cyRef.current = cy;

    // Stress layout tuned to spread paths apart: longer desired edges and wider
    // node clearance keep edge-label chips from colliding on multi-path samples.
    // Each sample is its own connected component, so they are laid out and
    // packed separately with a wide gutter between subgraphs.
    const elkLayout = {
      name: 'elk',
      elk: {
        algorithm: 'stress',
        'elk.spacing.nodeNode': '150',
        'elk.stress.desiredEdgeLength': '210',
        'elk.stress.epsilon': '1e-4',
        'elk.stress.iterationLimit': '3000',
        'elk.separateConnectedComponents': 'true',
        'elk.spacing.componentComponent': '140',
        'elk.aspectRatio': '2.0',
      },
      fit: true,
      padding: 50,
      animate: false,
    };
    const runLayout = () => {
      cy.resize();
      // After layout: resize (re-measure container), apply highlight and the
      // FINAL framing, then reveal — fitting twice at different zoom caps
      // flashed tiny graphs at max zoom before shrinking.
      runElkLayout(cy, elkLayout, () => {
        if (cy.destroyed()) return;
        cy.resize();
        applyHighlightAndFit(cy, soloPathRef.current);
        setGraphReady(true);
      });
    };

    // Run layout immediately if container has dimensions, else wait via ResizeObserver
    const cont = containerRef.current!;
    let ro: ResizeObserver | null = null;
    if (cont.clientWidth > 0 && cont.clientHeight > 0) {
      runLayout();
    } else {
      ro = new ResizeObserver((entries) => {
        const { width, height } = entries[0].contentRect;
        if (width > 0 && height > 0) { ro!.disconnect(); ro = null; runLayout(); }
      });
      ro.observe(cont);
    }

    // Hover tooltip
    cy.on('mouseover', 'node', (evt) => {
      const n = evt.target;
      // Context backdrop is events:'no', so this is belt-and-braces — but its
      // nodes carry no `paths`, and reading one would solo path #0 by accident.
      if (n.hasClass('context')) return;
      const pos = evt.renderedPosition ?? evt.position;
      const rect = containerRef.current?.getBoundingClientRect();
      const ox = evt.originalEvent as MouseEvent;
      const x = rect ? ox.clientX - rect.left : pos.x;
      const y = rect ? ox.clientY - rect.top : pos.y;
      const qvName = n.data('qvName') as string;
      const typeLabel = (n.data('typeLabel') as string) || 'vertex';
      const sampleNo = Number(String(n.data('paths') ?? '').split(',')[0]) + 1;
      const isIntermediate = Boolean(n.data('intermediate'));
      const tip: CyTooltip = {
        x, y,
        title: qvName ? `${typeLabel} · ${qvName}` : typeLabel,
        subtitle: `ID: ${n.data('vid')} · match #${sampleNo}${isIntermediate ? ' · on path' : ''}${n.data('shared') ? ' · in other matches too' : ''}`,
        color: n.data('color') as string,
      };
      tooltipRef.current = tip;
      setTooltip(tip);
    });
    cy.on('mouseout', 'node', () => { tooltipRef.current = null; setTooltip(null); });

    cy.on('mouseover', 'edge', (evt) => {
      const e = evt.target;
      if (e.hasClass('context')) return;
      const ox = evt.originalEvent as MouseEvent;
      const rect = containerRef.current?.getBoundingClientRect();
      const x = rect ? ox.clientX - rect.left : 0;
      const y = rect ? ox.clientY - rect.top : 0;
      const weRole = e.data('weRole') as string;
      const roleSuffix = weRole === 'path1' ? ' (P1)' : weRole === 'path2' ? ' (P2)' : '';
      const hopInfo = (e.data('hopInfo') as string) || '';
      const tip: CyTooltip = {
        x, y,
        title: (e.data('label') as string || '(edge)') + roleSuffix,
        subtitle: `Path #${Number(e.data('pathIdx')) + 1}${hopInfo ? ` · ${hopInfo}` : ''}`,
        color: e.data('color') as string,
      };
      tooltipRef.current = tip;
      setTooltip(tip);
    });
    cy.on('mouseout', 'edge', () => { tooltipRef.current = null; setTooltip(null); });

    // Node click → select path
    cy.on('tap', 'node', (evt) => {
      if (evt.target.hasClass('context')) return;
      const paths = String(evt.target.data('paths') ?? '').split(',').map(Number);
      onSoloPathChange?.(paths[0] ?? null);
    });
    cy.on('tap', 'edge', (evt) => {
      if (evt.target.hasClass('context')) return;
      onSoloPathChange?.(Number(evt.target.data('pathIdx')));
    });
    cy.on('tap', (evt) => {
      if (evt.target === cy) onSoloPathChange?.(null); // click on background → deselect
    });

    return () => {
      ro?.disconnect();
      safeDestroyCy(cy);
      cyRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, bgColor]);

  // Fetch the neighbourhood once, the first time the backdrop is switched on.
  // Any failure (older backend answering 404, a query holding the lock, a
  // transport error) silently flips the toggle back off — this layer is
  // decoration and must never be able to break the page.
  useEffect(() => {
    if (!contextOn || contextData || nodes.length === 0) return;
    const ids = Array.from(new Set(nodes.map((n) => n.vid))).slice(0, 256);
    if (ids.length === 0) return;
    let cancelled = false;
    setContextLoading(true);
    fetchNeighborhood(ids, datasetId, CONTEXT_MAX_PER_VERTEX)
      .then((data) => { if (!cancelled) setContextData(data); })
      .catch(() => {
        if (cancelled) return;
        setContextData(null);
        setContextOn(false);
      })
      .finally(() => { if (!cancelled) setContextLoading(false); });
    return () => { cancelled = true; };
  }, [contextOn, contextData, nodes, datasetId]);

  // Add / remove the backdrop. Runs after every cytoscape rebuild too
  // (graphReady flips false→true each time), so a theme switch re-attaches it.
  // Deliberately never fits or lays out: the match keeps its positions and the
  // camera does not move.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || cy.destroyed()) return;
    cy.elements('.context').remove();
    if (!contextOn || !contextData || !graphReady) return;
    const defs = buildContextElements(contextData, nodes, edges, cy, d);
    if (defs.length === 0) return;
    cy.add(defs);
  }, [contextOn, contextData, graphReady, nodes, edges, d]);

  // Update mousemove to keep tooltip position current
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: MouseEvent) => {
      if (tooltipRef.current) {
        const rect = el.getBoundingClientRect();
        const next = { ...tooltipRef.current, x: e.clientX - rect.left, y: e.clientY - rect.top };
        tooltipRef.current = next;
        setTooltip(next);
      }
    };
    el.addEventListener('mousemove', handler);
    return () => el.removeEventListener('mousemove', handler);
  }, []);

  // Set zoom-to-solo function ref
  useEffect(() => {
    if (onZoomToSoloRef) {
      onZoomToSoloRef.current = () => {
        const cy = cyRef.current;
        if (!cy || soloPath === null) return;
        const highlighted = cy.nodes('.highlighted');
        if (highlighted.length > 0) fitCapped(cy, highlighted, 150);
      };
    }
  }, [onZoomToSoloRef, soloPath]);

  // Update highlight/dim and camera on soloPath change (instant, no animation)
  const updateHighlight = useCallback(() => {
    const cy = cyRef.current;
    if (!cy || !graphReady) return;  // skip before layout finishes
    applyHighlightAndFit(cy, soloPath);
  }, [soloPath, graphReady]);

  useLayoutEffect(() => { updateHighlight(); }, [updateHighlight]);

  const containerW = containerRef.current?.clientWidth ?? 800;
  const flipX = tooltip ? tooltip.x > containerW * 0.65 : false;

  return (
    <div className="relative w-full h-full" style={graphCanvasBackground(d)}>
      <div
        ref={containerRef}
        className="w-full h-full"
        style={{ opacity: graphReady ? 1 : 0, transition: 'opacity 0.18s ease' }}
      />
      {/* Loading overlay: shown while ELK layout is computing */}
      {!graphReady && nodes.length > 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="flex flex-col items-center gap-2">
            <div className="w-5 h-5 border-2 rounded-full animate-spin"
              style={{ borderColor: d ? 'rgba(55,65,81,0.4)' : 'rgba(203,213,225,0.6)', borderTopColor: d ? '#22d3ee' : '#0891b2' }} />
            <span className="text-[11px] font-medium" style={{ color: d ? '#475569' : '#94a3b8' }}>Laying out graph…</span>
          </div>
        </div>
      )}
      {nodes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className={`text-sm ${d ? 'text-gray-600' : 'text-gray-400'}`}>No results to display</p>
        </div>
      )}
      {/* Toolbar */}
      {nodes.length > 0 && (
        // items-end keeps the 32px icon buttons flush with the wider
        // "Context" pill below them.
        <div className="absolute top-2 right-2 z-10 flex flex-col items-end gap-1">
          {/* Zoom in */}
          <button
            className={`${graphToolbarButtonClass(d)} text-base font-bold`}
            onClick={() => {
              const cy = cyRef.current; if (!cy) return;
              cy.zoom({ level: Math.min(cy.zoom() * 1.4, 4), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
            }}
            title="Zoom in"
          >+</button>
          {/* Zoom out */}
          <button
            className={`${graphToolbarButtonClass(d)} text-base font-bold`}
            onClick={() => {
              const cy = cyRef.current; if (!cy) return;
              cy.zoom({ level: Math.max(cy.zoom() / 1.4, 0.1), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
            }}
            title="Zoom out"
          >−</button>
          {/* Fit to view */}
          <button
            className={graphToolbarButtonClass(d)}
            onClick={() => {
              const cy = cyRef.current; if (!cy) return;
              cy.resize();
              fitCapped(cy, undefined, 40);
            }}
            title="Fit to view"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" />
            </svg>
          </button>
          {/* Re-center */}
          <button
            className={graphToolbarButtonClass(d)}
            onClick={() => cyRef.current?.center()}
            title="Re-center view"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="8" cy="8" r="3"/>
              <line x1="8" y1="1" x2="8" y2="5"/><line x1="8" y1="11" x2="8" y2="15"/>
              <line x1="1" y1="8" x2="5" y2="8"/><line x1="11" y1="8" x2="15" y2="8"/>
            </svg>
          </button>
          {/* Graph context — faint 1-hop surroundings of the matched vertices.
              Placed last so the wider pill does not collide with the "⊙ Zoom"
              overlay ForceGraph renders at top-2/right-14. Inline styles carry
              the pressed state and the auto width so they beat the shared
              toolbar class regardless of tailwind rule order. */}
          <button
            className={`${graphToolbarButtonClass(d)} px-2 gap-1.5 text-[10px] font-semibold tracking-wide`}
            style={{
              width: 'auto',
              ...(contextOn
                ? d
                  ? { background: 'rgba(8,51,68,0.8)', borderColor: 'rgba(14,116,144,0.75)', color: '#67e8f9' }
                  : { background: 'rgba(236,254,255,0.95)', borderColor: '#a5f3fc', color: '#0e7490' }
                : {}),
            }}
            onClick={() => setContextOn((v) => !v)}
            aria-pressed={contextOn}
            title={
              contextOn
                ? 'Hide surrounding graph context'
                : 'Show surrounding graph context (1-hop neighbours of the matched vertices)'
            }
          >
            {contextLoading ? (
              <span
                className="w-3 h-3 border-2 rounded-full animate-spin shrink-0"
                style={{ borderColor: 'currentColor', borderTopColor: 'transparent', opacity: 0.8 }}
              />
            ) : (
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0">
                <circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none" />
                <circle cx="8" cy="8" r="5.5" strokeDasharray="2 2" />
              </svg>
            )}
            Context
          </button>
        </div>
      )}
      {/* WE pair legend: the two sides of the equality constraint.
          The bottom-right of this pane is owned by ResultPanel's 300px stats
          card (absolute bottom-3 right-3), so reserve 320px: the legend wraps
          instead of running underneath it in a narrow pane. */}
      {wePair && nodes.length > 0 && (
        <div className={`we-legend absolute bottom-2 left-2 z-20 flex flex-wrap items-center gap-x-3 gap-y-1 border rounded-lg px-3 py-1.5 text-xs backdrop-blur-sm ${
          d ? 'bg-gray-900/85 border-gray-700/60 text-gray-300' : 'bg-white/85 border-gray-300/70 text-gray-600'
        }`} style={{ maxWidth: 'calc(100% - 320px)' }}>
          <span className="flex items-center gap-1.5">
            <svg width="20" height="6"><line x1="1" y1="3" x2="19" y2="3" stroke={weRoleColor('path1', d)} strokeWidth="2.5" strokeLinecap="round" /></svg>
            <span className="font-bold" style={{ color: weRoleColor('path1', d) }}>{wePair.p1Name}</span>
          </span>
          <span className="flex items-center gap-1.5">
            {/* Solid, matching the canvas: P2 lost its dashed stroke because
                P1 and P2 share edges on undirected labels and the two strokes
                stacked into noise. */}
            <svg width="20" height="6"><line x1="1" y1="3" x2="19" y2="3" stroke={weRoleColor('path2', d)} strokeWidth="2.5" strokeLinecap="round" /></svg>
            <span className="font-bold" style={{ color: weRoleColor('path2', d) }}>{wePair.p2Name}</span>
          </span>
          {wePair.linkLabel && (
            <span className="flex items-center gap-1.5">
              <svg width="20" height="6"><line x1="1" y1="3" x2="19" y2="3" stroke={d ? '#94a3b8' : '#64748b'} strokeWidth="2" strokeDasharray="2 4" strokeLinecap="round" /></svg>
              <span className="font-medium" style={{ color: d ? '#94a3b8' : '#64748b' }}>{wePair.linkLabel}</span>
            </span>
          )}
          <span className={d ? 'text-gray-500' : 'text-gray-400'}>
            {wePair.constrained
              ? (wePair.isPrefix ? 'prefix equality' : 'same label sequence')
              : 'no equality constraint'}
          </span>
        </div>
      )}

      {/* Tooltip */}
      {tooltip && (
        <div
          className={`absolute pointer-events-none z-50 rounded-xl px-3 py-2 shadow-2xl border text-xs backdrop-blur-sm ${
            d ? 'bg-gray-900/95 border-gray-600/60' : 'bg-white/95 border-gray-300/70'
          }`}
          style={{
            left: flipX ? undefined : tooltip.x + 14,
            right: flipX ? containerW - tooltip.x + 14 : undefined,
            top: tooltip.y + 14,
          }}
        >
          <div className="flex items-center gap-1.5 mb-1">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: tooltip.color }} />
            <span className={`font-semibold ${d ? 'text-gray-100' : 'text-gray-900'}`}>{tooltip.title}</span>
          </div>
          <span className={`font-mono ${d ? 'text-cyan-300' : 'text-cyan-600'}`}>{tooltip.subtitle}</span>
        </div>
      )}
    </div>
  );
};

export default ForceGraphCytoscape;
