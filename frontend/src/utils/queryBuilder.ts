import type { QueryGraph, QueryEdge, NFADefinition, QueryVertex } from '../types';
import {
  buildSingleLabelNFA,
  buildAlternationNFA,
} from './regexToNFA';

/**
 * Convert the visual QueryGraph from the canvas into the engine query JSON format.
 *
 * Reference format (from queries/WE-q2-simple.json):
 * {
 *   "query_vertices": ["v1:Any", "v2:Any", ...],
 *   "query_edges": ["(v1)-[P1]->(v2)", ...],
 *   "automata": { "P1": { ... NFA ... } },
 *   "word_equality_constraints": [{ "path1": "P1", "path2": "P2", "source_constraint": "same" }]
 * }
 */
export function buildQueryJSON(graph: QueryGraph): Record<string, unknown> {
  // Map vertex IDs to sequential names: v1, v2, ...
  const vertexIdMap = new Map<string, string>();
  graph.vertices.forEach((v, i) => {
    vertexIdMap.set(v.id, `v${i + 1}`);
  });

  // Build query_vertices: ["v1:Person", "v2:Any", ...]
  const query_vertices = graph.vertices.map((v) => {
    const vName = vertexIdMap.get(v.id)!;
    return `${vName}:${v.label}`;
  });

  // Collect edge IDs referenced by WE constraints (they always need automata entries)
  const weEdgeIds = new Set<string>();
  for (const wec of graph.weConstraints) {
    weEdgeIds.add(wec.edge1Id);
    weEdgeIds.add(wec.edge2Id);
  }

  // Build query_edges and automata
  const query_edges: string[] = [];
  const automata: Record<string, NFADefinition> = {};

  for (const edge of graph.edges) {
    const srcName = vertexIdMap.get(edge.source);
    const tgtName = vertexIdMap.get(edge.target);
    if (!srcName || !tgtName) continue;

    // Plain 1-hop edge with no constraints → use label directly, no automata entry
    const needsAutomata =
      edge.quantifier !== '1' ||
      (edge.alternateLabels && edge.alternateLabels.length > 0) ||
      edge.originalNFA != null ||
      edge.minLength != null || edge.maxLength != null ||
      weEdgeIds.has(edge.id);

    if (needsAutomata) {
      query_edges.push(formatEdgeString(edge, srcName, tgtName, edge.automataName));
      automata[edge.automataName] = buildEdgeNFA(edge);
    } else {
      query_edges.push(formatEdgeString(edge, srcName, tgtName, edge.label));
    }
  }

  const result: Record<string, unknown> = { query_vertices, query_edges };
  if (Object.keys(automata).length > 0) result.automata = automata;

  // Vertex inequality constraints (e.g. "v1<>v2")
  if (graph.inequalities && graph.inequalities.length > 0) {
    const constraints = graph.inequalities
      .map(({ v1Id, v2Id }) => {
        const a = vertexIdMap.get(v1Id);
        const b = vertexIdMap.get(v2Id);
        return a && b ? `${a}<>${b}` : null;
      })
      .filter((c): c is string => c != null);
    if (constraints.length > 0) result.constraints = constraints;
  }

  // Add WE constraints if any
  if (graph.weConstraints.length > 0) {
    const edgeIdToAutomata = new Map<string, string>();
    for (const edge of graph.edges) {
      edgeIdToAutomata.set(edge.id, edge.automataName);
    }

    result.word_equality_constraints = graph.weConstraints.map((wec) => {
      const entry: Record<string, string> = {
        path1: edgeIdToAutomata.get(wec.edge1Id) || 'P1',
        path2: edgeIdToAutomata.get(wec.edge2Id) || 'P2',
        source_constraint: wec.sourceConstraint || 'same',
      };
      if (wec.type) entry.type = wec.type;
      if (wec.linkingLabel) entry.linking_label = wec.linkingLabel;
      return entry;
    });
  }

  return result;
}

/**
 * Format an edge string in the engine query convention.
 * Forward:  (v1)-[LABEL]->(v2)
 * Reverse:  (v1)<-[LABEL]-(v2)
 */
function formatEdgeString(
  edge: QueryEdge,
  srcName: string,
  tgtName: string,
  labelName: string,
): string {
  if (edge.direction === 'reverse') {
    return `(${srcName})<-[${labelName}]-(${tgtName})`;
  }
  return `(${srcName})-[${labelName}]->(${tgtName})`;
}

/**
 * Build an NFA definition for a query edge.
 * If the edge has an originalNFA from a preset, use it directly.
 * Otherwise, build from label+quantifier.
 */
function buildEdgeNFA(edge: QueryEdge): NFADefinition {
  // Use preserved original NFA for complex patterns (concatenation, etc.)
  if (edge.originalNFA) {
    const nfa = { ...edge.originalNFA };
    // Length bounds are owned by the edge (so buildPlainGraph can strip them);
    // drop any bounds baked into the preset NFA before re-applying.
    delete nfa.min_length;
    delete nfa.max_length;
    if (edge.minLength != null) nfa.min_length = edge.minLength;
    if (edge.maxLength != null) nfa.max_length = edge.maxLength;
    return nfa;
  }

  const labels = edge.alternateLabels?.length
    ? [edge.label, ...edge.alternateLabels]
    : [edge.label];

  let nfa: NFADefinition;
  if (labels.length > 1) {
    nfa = buildAlternationNFA(labels, edge.quantifier, edge.direction);
  } else {
    nfa = buildSingleLabelNFA(edge.label, edge.quantifier, edge.direction);
  }

  // Apply length constraints
  if (edge.minLength != null) nfa.min_length = edge.minLength;
  if (edge.maxLength != null) nfa.max_length = edge.maxLength;

  return nfa;
}

/**
 * Parse a preset query JSON back into a QueryGraph for the canvas.
 */
export function parsePresetToQueryGraph(
  preset: Record<string, unknown>,
): {
  vertices: Array<{ label: string; position: { x: number; y: number } }>;
  edges: Array<{
    sourceIdx: number;
    targetIdx: number;
    label: string;
    quantifier: '1' | '*' | '+' | '?';
    direction: 'forward' | 'reverse' | 'both';
    automataName: string;
    alternateLabels?: string[];
    originalNFA?: NFADefinition;
    minLength?: number;
    maxLength?: number;
  }>;
  weConstraints: Array<{ automata1: string; automata2: string; type?: 'prefix'; sourceConstraint?: 'same' | 'different'; linkingLabel?: string }>;
  inequalities: Array<{ v1Idx: number; v2Idx: number }>;
} {
  const qverts = (preset.query_vertices as string[]) || [];
  const qedges = (preset.query_edges as string[]) || [];
  const automata = (preset.automata as Record<string, Record<string, unknown>>) || {};
  const weConstraints =
    (preset.word_equality_constraints as Array<Record<string, string>>) || [];
  const rawConstraints = (preset.constraints as string[]) || [];

  // Parse vertex names first (positions computed after edges for dynamic spacing)
  const vertexNames: string[] = [];
  const vertexLabels: string[] = [];
  for (const vs of qverts) {
    const colonIdx = vs.indexOf(':');
    vertexNames.push(colonIdx >= 0 ? vs.slice(0, colonIdx) : vs);
    vertexLabels.push(colonIdx >= 0 ? vs.slice(colonIdx + 1) : 'Any');
  }

  // Parse edges: "(v1)-[P1]->(v2)" or "(v1)<-[LABEL]-(v2)"
  const edges = qedges.map((es) => {
    const { sourceName, targetName, automataName, direction } = parseEdgeString(es);

    const srcIdx = vertexNames.indexOf(sourceName);
    const tgtIdx = vertexNames.indexOf(targetName);

    // Look up automata to get label and quantifier
    const auto = automata[automataName];
    let label = automataName;
    let quantifier: '1' | '*' | '+' | '?' = '1';
    let alternateLabels: string[] | undefined;

    let originalNFA: NFADefinition | undefined;

    if (auto) {
      const regex = auto.regular_expression as string;
      const alphabets = (auto.alphabets as string[]) || [];
      const parsed = parseRegex(regex, alphabets);
      label = parsed.label;
      quantifier = parsed.quantifier;
      alternateLabels = parsed.alternateLabels;

      let needsOriginal = parsed.needsOriginalNFA ?? false;
      // The label+quantifier+direction model rebuilds NFAs with a UNIFORM
      // transition direction. Preset automata may mix APPEND ("LABEL-") and
      // PREPEND ("-LABEL") transitions (e.g. "LIKES|(HAS_CREATOR)" walks
      // LIKES forward and HAS_CREATOR backward) — those must keep their NFA.
      if (!needsOriginal) {
        const trans = (auto.transitions as [string, string, string][]) || [];
        const expected = direction === 'reverse' ? 'prepend' : 'append';
        if (trans.some(t => (t[1].startsWith('-') ? 'prepend' : 'append') !== expected)) {
          needsOriginal = true;
        }
      }
      // Grouping parens inside alternation parts break label splitting
      // (alternate "(HAS_CREATOR)" would become a literal label).
      if (!needsOriginal &&
          [label, ...(alternateLabels ?? [])].some(l => l.includes('(') || l.includes(')'))) {
        needsOriginal = true;
      }
      if (needsOriginal && !parsed.needsOriginalNFA) {
        label = regex;
        alternateLabels = undefined;
        quantifier = '1';
      }

      // If the regex can't be decomposed into label+quantifier(+alternates),
      // preserve the original NFA verbatim.
      if (needsOriginal) {
        originalNFA = {
          regular_expression: regex,
          states: (auto.states as string[]) || [],
          alphabets,
          transitions: (auto.transitions as [string, string, string][]) || [],
          initial_states: (auto.initial_states as string[]) || [],
          final_states: (auto.final_states as string[]) || [],
        };
        if (auto.min_length != null) originalNFA.min_length = auto.min_length as number;
        if (auto.max_length != null) originalNFA.max_length = auto.max_length as number;
      }
    } else {
      // Plain edge — automataName is the label itself
      label = automataName;
    }

    // Extract length constraints from automata definition
    const minLength = auto?.min_length != null ? (auto.min_length as number) : undefined;
    const maxLength = auto?.max_length != null ? (auto.max_length as number) : undefined;

    return {
      sourceIdx: srcIdx >= 0 ? srcIdx : 0,
      targetIdx: tgtIdx >= 0 ? tgtIdx : 1,
      label,
      quantifier,
      direction,
      automataName,
      alternateLabels,
      originalNFA,
      minLength,
      maxLength,
    };
  });

  // Compute edge display label length for spacing
  function edgeLabelLen(e: typeof edges[number]): number {
    const altText = e.alternateLabels?.length
      ? `(${e.label}|${e.alternateLabels.join('|')})`
      : e.label;
    const quantLen = e.quantifier === '1' ? 0 : 1;
    const lenSuffix = (e.minLength != null || e.maxLength != null)
      ? `[${e.minLength ?? ''}..${e.maxLength ?? ''}]`.length : 0;
    return (e.automataName ? e.automataName.length + 2 : 0) + altText.length + quantLen + lenSuffix;
  }

  // Build adjacency with per-edge spacing proportional to label length
  const adj: Array<Array<{ target: number; spacing: number }>> = Array.from({ length: qverts.length }, () => []);
  for (const e of edges) {
    const spacing = Math.max(160, edgeLabelLen(e) * 11 + 60);
    adj[e.sourceIdx].push({ target: e.targetIdx, spacing });
    adj[e.targetIdx].push({ target: e.sourceIdx, spacing });
  }

  // BFS layout: place each vertex at a distance proportional to connecting edge label
  const positions: Array<{ x: number; y: number } | null> = new Array(qverts.length).fill(null);
  const rowSpacing = 160;
  positions[0] = { x: 150, y: 200 };
  const queue: number[] = [0];
  const visited = new Set<number>([0]);

  while (queue.length > 0) {
    const curr = queue.shift()!;
    const currPos = positions[curr]!;
    let branchIdx = 0;
    for (const { target, spacing } of adj[curr]) {
      if (visited.has(target)) continue;
      visited.add(target);
      positions[target] = {
        x: currPos.x + spacing,
        y: currPos.y + branchIdx * rowSpacing,
      };
      branchIdx++;
      queue.push(target);
    }
  }

  // Handle disconnected vertices
  let nextY = 200;
  for (let i = 0; i < qverts.length; i++) {
    if (!positions[i]) {
      nextY += rowSpacing;
      positions[i] = { x: 150, y: nextY };
    }
  }

  const vertices = vertexLabels.map((label, i) => ({
    label,
    position: positions[i]!,
  }));

  const weConstParsed = weConstraints.map((wec) => ({
    automata1: wec.path1 || '',
    automata2: wec.path2 || '',
    type: wec.type as 'prefix' | undefined,
    sourceConstraint: (wec.source_constraint === 'different' ? 'different' : 'same') as 'same' | 'different',
    linkingLabel: wec.linking_label as string | undefined,
  }));

  // Parse inequality constraints ("person1<>person2") into vertex index pairs
  const inequalities: Array<{ v1Idx: number; v2Idx: number }> = [];
  for (const c of rawConstraints) {
    const m = c.match(/^\s*(\w+)\s*<>\s*(\w+)\s*$/);
    if (!m) continue;
    const i1 = vertexNames.indexOf(m[1]);
    const i2 = vertexNames.indexOf(m[2]);
    if (i1 >= 0 && i2 >= 0) inequalities.push({ v1Idx: i1, v2Idx: i2 });
  }

  return { vertices, edges, weConstraints: weConstParsed, inequalities };
}

/**
 * Parse an edge string like "(v1)-[P1]->(v2)" or "(v1)<-[HAS_CREATOR]-(v2)".
 */
function parseEdgeString(edgeStr: string): {
  sourceName: string;
  targetName: string;
  automataName: string;
  direction: 'forward' | 'reverse' | 'both';
} {
  // Forward: (src)-[label]->(tgt)
  const fwdMatch = edgeStr.match(
    /^\(([^)]+)\)-\[([^\]]+)\]->\(([^)]+)\)$/,
  );
  if (fwdMatch) {
    return {
      sourceName: fwdMatch[1],
      targetName: fwdMatch[3],
      automataName: fwdMatch[2],
      direction: 'forward',
    };
  }

  // Reverse: (src)<-[label]-(tgt)
  const revMatch = edgeStr.match(
    /^\(([^)]+)\)<-\[([^\]]+)\]-\(([^)]+)\)$/,
  );
  if (revMatch) {
    return {
      sourceName: revMatch[1],
      targetName: revMatch[3],
      automataName: revMatch[2],
      direction: 'reverse',
    };
  }

  // Fallback
  return {
    sourceName: 'v1',
    targetName: 'v2',
    automataName: 'P1',
    direction: 'forward',
  };
}

/**
 * Parse a regular expression string and alphabets back to label + quantifier.
 */
function parseRegex(
  regex: string,
  alphabets: string[],
): {
  label: string;
  quantifier: '1' | '*' | '+' | '?';
  alternateLabels?: string[];
  needsOriginalNFA?: boolean;
} {
  // Bounded quantifier {m,n} (e.g. "KNOWS{1,3}") — the loop structure lives in
  // the preset NFA and the bounds in min/max_length, neither of which the
  // label+quantifier model can reproduce. Keep the original NFA.
  if (/\{\d*,?\d*\}/.test(regex)) {
    return {
      label: alphabets[0] || regex,
      quantifier: '1',
      needsOriginalNFA: true,
    };
  }

  // Detect possible expression-level quantifier on the last char
  const lastChar = regex[regex.length - 1];
  const hasQuantifier = ['*', '+', '?'].includes(lastChar);

  // Determine inner expression (with and without stripping the trailing quantifier)
  const inner = hasQuantifier ? regex.slice(0, -1) : regex;
  const stripped = inner.replace(/^\(/, '').replace(/\)$/, '');

  // Concatenation (A/B) — per-segment quantifiers must be preserved.
  // Check BEFORE stripping the trailing char, because "A*/B*" has '*' on B, not the whole expr.
  if (stripped.includes('/')) {
    // Use regex as-is; naive paren stripping breaks "A*/(B|C)" → "A*/(B|C"
    return {
      label: regex,
      quantifier: '1',
      needsOriginalNFA: true,
    };
  }

  // Now safe to treat lastChar as expression-level quantifier
  const quantifier = hasQuantifier ? (lastChar as '*' | '+' | '?') : '1';
  const clean = stripped; // already stripped outer parens from `inner`

  // Check for alternation (A|B) — only if no part contains quantifiers
  if (clean.includes('|')) {
    const parts = clean.split('|');
    const partsHaveQuantifiers = parts.some((p) => /[*+?]/.test(p));
    if (partsHaveQuantifiers) {
      // Complex regex — use first alphabet as display label, flag for original NFA
      return {
        label: alphabets[0] || clean,
        quantifier: '1',
        needsOriginalNFA: true,
      };
    }
    return {
      label: parts[0],
      quantifier,
      alternateLabels: parts.slice(1),
    };
  }

  // Single label
  return {
    label: alphabets.length > 0 ? alphabets[0] : clean,
    quantifier,
  };
}

/**
 * Build a single-edge QueryGraph (2 vertices, 1 edge) suitable for running
 * one CRPQ edge as a standalone RPQ query. Used to obtain full intermediate-
 * vertex path samples for the compare panel's plain-CRPQ side.
 */
export function buildSingleEdgeGraph(edge: QueryEdge, allVertices: QueryVertex[]): QueryGraph {
  const srcVertex = allVertices.find(v => v.id === edge.source)
    ?? { id: edge.source, label: 'Any', position: { x: 0, y: 0 } };
  const tgtVertexRaw = allVertices.find(v => v.id === edge.target);
  const vertices: QueryVertex[] = edge.target !== edge.source && tgtVertexRaw
    ? [srcVertex, tgtVertexRaw]
    : [srcVertex];
  return { vertices, edges: [edge], weConstraints: [] };
}
