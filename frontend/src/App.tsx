import { useState, useEffect, useCallback, useRef, useMemo, type FC } from 'react';
import type { Schema, QueryResult, PresetQuery, Dataset, QueryGraph, CatalogGroup } from './types';
import { useQueryGraph } from './components/QueryCanvas/useQueryGraph';
import Toolbar from './components/Toolbar';
import QueryEditor from './components/QueryEditor';
import QueryCanvas from './components/QueryCanvas/QueryCanvas';
import ResultPanel from './components/ResultPanel/ResultPanel';
import type { ResultTab } from './components/ResultPanel/ResultPanel';
import WelcomeScreen from './components/WelcomeScreen';
import { getWalkthrough, type WalkthroughDef } from './data/walkthroughSteps';
import type { StepResult } from './components/GuidedWalkthrough';
import { generateSuggestions } from './data/whatIfSuggestions';

type AppView = 'query' | 'graph' | 'compare' | 'benchmark';
import { buildQueryJSON, buildSingleEdgeGraph } from './utils/queryBuilder';
import type { SamplePath, WESamplePair, QueryEdge } from './types';
import {
  buildToggledQueryJSON,
  buildPlainGraph,
  detectConstraints,
  DEFAULT_TOGGLES,
  type ConstraintToggles,
} from './utils/queryToggle';
import {
  fetchDatasets,
  fetchEngineMode,
  fetchSchema,
  fetchPresets,
  runQuery,
  isMockMode,
  setCacheMode,
} from './utils/api';
import { MOCK_SCHEMA, MOCK_DATASETS, MOCK_PRESETS } from './data/mockData';


interface HistoryItem {
  id: string;
  timestamp: number;
  name: string;
  datasetId: string;
  queryJSON: Record<string, unknown>;
  totalCount: number | null;
  queryType: string | null;
  presetFilename: string | null;
}

interface ScenarioMeta { title: string; shortDesc: string; fullDesc: string; queryType: string }
const SCENARIO_META: Record<string, ScenarioMeta> = {
  'SO-q1':  { title: 'Answer Reach',        queryType: 'RPQ', shortDesc: 'A2Q* reachability',       fullDesc: 'Find all questions reachable from an answer through any chain of answer-to-question links.' },
  'SO-q2':  { title: 'Answer + Comments',   queryType: 'RPQ', shortDesc: 'A2Q? then C2A* chain',    fullDesc: 'Explore comment threads that optionally start from an answer — find how discussions branch.' },
  'SO-q3':  { title: 'Answer-Comment',      queryType: 'RPQ', shortDesc: 'A2Q then C2A* path',      fullDesc: 'From an answer to its question, then follow the comment chain — trace discussion flow.' },
  'SO-q4':  { title: 'Fixed 4-Hop',         queryType: 'RPQ', shortDesc: 'A2Q·A2Q·C2A·C2Q path',   fullDesc: 'A fixed 4-step journey: answer→question→comment→question — find cross-referenced content.' },
  'SO-q5':  { title: 'Comment-Answer',      queryType: 'RPQ', shortDesc: 'C2Q then A2Q then C2A*',  fullDesc: 'From a comment, reach its question, find an answer, then explore further comments.' },
  'SO-q6':  { title: 'Comment via Answers', queryType: 'RPQ', shortDesc: 'C2A·A2Q*·C2Q traversal', fullDesc: 'Trace how comments connect to questions through intermediate answer hops.' },
  'SO-q7':  { title: 'Union + Answer',      queryType: 'RPQ', shortDesc: 'Union edge then A2Q*',    fullDesc: 'Start with any relationship type, then follow answer chains — flexible entry point search.' },
  'SO-q8':  { title: 'Answer & Comment',    queryType: 'RPQ', shortDesc: 'A2Q* then C2A* sequence', fullDesc: 'Chain answer hops into comment hops — find how Q&A content flows into discussions.' },
  'SO-q9':  { title: 'Full Traversal',      queryType: 'RPQ', shortDesc: 'C2Q·A2Q*·C2A* chain',   fullDesc: 'The broadest Q&A traversal — comment to question to answers to further comments.' },
  'SO-q10': { title: 'Union Reach',         queryType: 'RPQ', shortDesc: 'Union Kleene-star',       fullDesc: 'Reachability using any combination of edge types — discover all connected Q&A content.' },
};

/** Natural sort key: splits filename into text/number segments for correct numeric ordering */
function natSortKey(filename: string): (string | number)[] {
  return filename.split(/(\d+)/).map(t => /^\d+$/.test(t) ? parseInt(t, 10) : t.toLowerCase());
}

function natSortPresets(arr: PresetQuery[]): PresetQuery[] {
  return [...arr].sort((a, b) => {
    const ka = natSortKey(a.filename);
    const kb = natSortKey(b.filename);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      const va = ka[i] ?? '';
      const vb = kb[i] ?? '';
      if (va === vb) continue;
      if (typeof va === 'number' && typeof vb === 'number') return va - vb;
      return String(va) < String(vb) ? -1 : 1;
    }
    return 0;
  });
}

/** Extract id, title, and description from a preset (uses catalog metadata if available) */
function parsePresetLabel(
  preset: PresetQuery | undefined,
  filename: string,
  catalogGroups: CatalogGroup[],
): { id: string; title: string; meta?: ScenarioMeta } {
  // Catalog-enriched preset (LDBC)
  if (preset?.catalog) {
    const cat = preset.catalog;
    const groupLabel = catalogGroups.find(g => g.id === cat.group)?.label ?? 'RPQ';
    const regex = (preset.content?.regex_pattern as string) ?? '';
    const desc = (preset.content?.description as string) ?? '';
    return {
      id: cat.id,
      title: cat.title,
      meta: { title: cat.title, shortDesc: regex || desc, fullDesc: desc, queryType: groupLabel },
    };
  }
  // StackOverflow: SO-q1, SO-q2, …
  const stem = filename.replace('.json', '');
  const so = stem.match(/^(SO-q\d+)/);
  if (so) {
    const id = so[1];
    const meta = SCENARIO_META[id];
    return { id, title: meta?.title ?? id, meta };
  }
  // Fallback: derive from filename
  const sm = stem.match(/^(S\d+)-(?:rpq-|crpq-|we-|we-diff-|prefix-)?(.+)/);
  if (sm) {
    const derived = sm[2].split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    return { id: sm[1], title: derived };
  }
  return { id: stem, title: stem };
}

/** Label-sequence fingerprint for a sample path (e.g. "KNOWS/KNOWS/HAS_INTEREST") */
function pathFingerprint(p: SamplePath): string {
  return (p.edge_labels ?? []).join('/');
}

/** Binding a sample path assigns to one endpoint of its query edge. */
function endpointBinding(p: SamplePath, endpoint: 'source' | 'target'): number | undefined {
  return endpoint === 'source' ? p.vertices[0] : p.vertices[p.vertices.length - 1];
}

/**
 * Query vertices shared by two edges, as the endpoint pairs whose bindings
 * must be equal for the two witness paths to belong to the SAME match.
 * A same-source pattern yields [['source','source']]; a chain yields
 * [['target','source']]; disjoint edges yield [].
 */
function sharedEndpoints(
  e1: QueryEdge, e2: QueryEdge,
): Array<[('source' | 'target'), ('source' | 'target')]> {
  const out: Array<[('source' | 'target'), ('source' | 'target')]> = [];
  const ends = ['source', 'target'] as const;
  for (const a of ends) for (const b of ends) {
    if (e1[a] === e2[b]) out.push([a, b]);
  }
  return out;
}

/**
 * For CRPQ queries in comparison mode, run each automata-backed edge as a
 * standalone RPQ to recover the per-hop witness paths the CRPQ engine does
 * not report (CRPQ samples carry endpoint bindings only).
 *
 * Two witness paths only describe a real match of the plain query when they
 * agree on every query vertex their edges share, so pairs are formed under
 * that constraint. Among valid pairs we prefer differing label sequences —
 * that contrast is the point of the comparison, since plain CRPQ permits
 * P1 ≢ P2 while ECRPQ enforces P1 ≡ P2 via word equality. When no
 * join-consistent pair exists, the engine's own CRPQ samples are returned
 * unchanged rather than stitching paths from unrelated matches.
 */
async function expandCrpqSamples(
  plainGraph: QueryGraph,
  plainRes: QueryResult,
  datasetId: string,
  retryFn: (qj: Record<string, unknown>, ds: string) => Promise<QueryResult>,
): Promise<QueryResult> {
  // Only expand CRPQ with 2+ automata-backed edges
  if (plainRes.query_type !== 'crpq') return plainRes;

  const automataEdges = plainGraph.edges.filter(
    e => e.originalNFA != null || e.quantifier !== '1' ||
      (e.alternateLabels && e.alternateLabels.length > 0),
  );
  if (automataEdges.length < 2) return plainRes;

  const [edge1, edge2] = automataEdges;
  const joins = sharedEndpoints(edge1, edge2);
  // Disjoint edges share no vertex: any pairing would invent a match.
  if (joins.length === 0) return plainRes;

  try {
    // Run each automata edge as standalone RPQ
    const perEdgeResults: QueryResult[] = [];
    for (const edge of [edge1, edge2]) {
      const singleGraph = buildSingleEdgeGraph(edge, plainGraph.vertices);
      const rpqJson = buildQueryJSON(singleGraph);
      const rpqRes = await retryFn(rpqJson, datasetId);
      perEdgeResults.push(rpqRes);
    }

    const p1Samples = (perEdgeResults[0]?.samples ?? []) as SamplePath[];
    const p2Samples = (perEdgeResults[1]?.samples ?? []) as SamplePath[];
    const maxPairs = Math.min(10, p1Samples.length, p2Samples.length);
    const pairedSamples: WESamplePair[] = [];

    const usedP2 = new Set<number>();
    const joinConsistent = (a: SamplePath, b: SamplePath) =>
      joins.every(([ea, eb]) => {
        const va = endpointBinding(a, ea);
        const vb = endpointBinding(b, eb);
        return va !== undefined && va === vb;
      });

    // Pass 1: join-consistent pairs whose label sequences differ (the contrast
    // the comparison is meant to show). Pass 2: any remaining valid pair.
    for (const requireDifferentLabels of [true, false]) {
      for (let i = 0; i < p1Samples.length && pairedSamples.length < maxPairs; i++) {
        const p1 = p1Samples[i];
        if (pairedSamples.some(pr => pr.path1 === p1)) continue;
        const fp1 = pathFingerprint(p1);
        const j = p2Samples.findIndex((s, k) =>
          !usedP2.has(k) && joinConsistent(p1, s) &&
          (!requireDifferentLabels || pathFingerprint(s) !== fp1));
        if (j >= 0) {
          usedP2.add(j);
          pairedSamples.push({ path1: p1, path2: p2Samples[j], src_vid: p1.vertices[0] });
        }
      }
    }

    // No genuine witness pair — show the engine's real CRPQ bindings instead.
    if (pairedSamples.length === 0) return plainRes;

    return {
      ...plainRes,
      query_type: 'word_equality',
      samples: pairedSamples,
      // Display shape only: these pairs come from two independent RPQ runs, not
      // from an equality the engine checked.
      synthesized_pairs: true,
    };
  } catch {
    return plainRes; // fallback to original CRPQ samples
  }
}

const App: FC = () => {
  // Dataset and schema state
  const [datasets, setDatasets] = useState<Dataset[]>(MOCK_DATASETS);
  // Backend engine mode; "mock" means every answer is a recorded result.
  const [engineMode, setEngineMode] = useState<string | null>(null);
  const [selectedDataset, setSelectedDataset] = useState('');
  const [schema, setSchema] = useState<Schema>(MOCK_SCHEMA);
  const [presets, setPresets] = useState<PresetQuery[]>(MOCK_PRESETS);
  const [catalogGroups, setCatalogGroups] = useState<CatalogGroup[]>([]);

  // Query state
  const queryGraph = useQueryGraph();

  // JSON override from QueryEditor (when in JSON mode)
  const [jsonOverride, setJsonOverride] = useState<Record<string, unknown> | null>(null);

  // Answer source: live engine (default) vs replayed stored results.  Persisted so
  // a reload mid-session does not silently flip the demo back to live.
  const [cacheMode, setCacheModeState] = useState<boolean>(() => {
    return localStorage.getItem('wgd-cache-mode') === '1';
  });
  useEffect(() => {
    setCacheMode(cacheMode);
    localStorage.setItem('wgd-cache-mode', cacheMode ? '1' : '0');
  }, [cacheMode]);

  // Theme state (persisted in localStorage)
  const [isDark, setIsDark] = useState<boolean>(() => {
    const saved = localStorage.getItem('wgd-theme');
    return saved !== null ? saved === 'dark' : false;
  });

  const handleToggleTheme = useCallback(() => {
    setIsDark((prev) => {
      const next = !prev;
      localStorage.setItem('wgd-theme', next ? 'dark' : 'light');
      return next;
    });
  }, []);

  // Result state
  const [result, setResult] = useState<QueryResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);

  // Query context captured at run time (for labeling result graph)
  const [queryContext, setQueryContext] = useState<QueryGraph | null>(null);

  // Comparison slot — pinned "A" result for side-by-side Compare tab
  const [compareResult, setCompareResult] = useState<QueryResult | null>(null);
  const [compareQueryContext, setCompareQueryContext] = useState<QueryGraph | null>(null);
  // Compare tab's independent Slot A — decoupled from main result/queryContext
  const [compareSlotAResult, setCompareSlotAResult] = useState<QueryResult | null>(null);
  const [compareSlotAContext, setCompareSlotAContext] = useState<QueryGraph | null>(null);
  // Independent per-slot loading states for the Compare tab
  const [compareLoadingSlotA, setCompareLoadingSlotA] = useState(false);
  const [compareLoadingSlotB, setCompareLoadingSlotB] = useState(false);

  // Constraint toggle state (for interactive re-runs)
  const [constraintToggles, setConstraintToggles] = useState<ConstraintToggles>(DEFAULT_TOGGLES);
  const [, setToggleRunning] = useState(false);

  // Guided walkthrough state
  const [walkthroughDef, setWalkthroughDef] = useState<WalkthroughDef | null>(null);
  const [walkthroughStep, setWalkthroughStep] = useState(0);
  const [walkthroughResults, setWalkthroughResults] = useState<(StepResult | null)[]>([]);
  const [walkthroughRunning, setWalkthroughRunning] = useState(false);

  // Demo Script state (multi-scenario walkthrough)

  // Welcome screen state
  const [showWelcome, setShowWelcome] = useState(true);

  // Track last selected preset for toolbar display + benchmark comparison
  const [lastPresetFilename, setLastPresetFilename] = useState<string | null>(null);
  const [selectedPresetName, setSelectedPresetName] = useState<string | null>(null);

  // Increment on preset load → triggers auto cose layout in QueryCanvas
  const [layoutKey, setLayoutKey] = useState(0);

  // Sidebar tab: presets or history
  const [sidebarTab, setSidebarTab] = useState<'presets' | 'history'>('presets');

  // Query history (persisted in localStorage)
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    try { return JSON.parse(localStorage.getItem('wgd-history') ?? '[]') as HistoryItem[]; }
    catch { return []; }
  });

  // Preset sidebar resize + collapse + hover tooltip
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarW, setSidebarW] = useState(260);
  const [hoveredPresetFile, setHoveredPresetFile] = useState<string | null>(null);
  const sidebarDragging = useRef(false);
  const sidebarDragStart = useRef({ x: 0, w: 260 });
  const handleSidebarResizeDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    sidebarDragging.current = true;
    sidebarDragStart.current = { x: e.clientX, w: sidebarW };
    const onMove = (mv: MouseEvent) => {
      if (!sidebarDragging.current) return;
      const next = Math.max(120, Math.min(400, sidebarDragStart.current.w + mv.clientX - sidebarDragStart.current.x));
      setSidebarW(next);
    };
    const onUp = () => { sidebarDragging.current = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [sidebarW]);

  // Group presets by catalog group for sidebar (catalog order, natural sort within each group)
  const presetGroups = useMemo(() => {
    type GroupEntry = { label: string; color: string; presets: PresetQuery[] };
    const groupMap = new Map<string, GroupEntry>();

    // Initialize in catalog order
    for (const cg of catalogGroups) {
      groupMap.set(cg.id, { label: cg.label, color: cg.color ?? '#94a3b8', presets: [] });
    }

    // Assign presets to groups (skip uncatalogued — no "Other")
    for (const p of presets) {
      const gid = p.catalog?.group;
      if (gid && groupMap.has(gid)) {
        groupMap.get(gid)!.presets.push(p);
      }
    }

    return Array.from(groupMap.entries())
      .filter(([, v]) => v.presets.length > 0)
      .map(([, v]) => [v.label, natSortPresets(v.presets), v.color] as [string, PresetQuery[], string]);
  }, [presets, catalogGroups]);

  // Refs for center/fit functions exposed by child components
  const queryCanvasFitRef = useRef<(() => void) | null>(null);
  const resultGraphFitRef = useRef<(() => void) | null>(null);

  // Track whether initial load has completed (to avoid double schema fetch)
  const initializedRef = useRef(false);

  // Unified flat navigation — no nested tabs
  const [activeView, setActiveView] = useState<AppView>('query');


  // Load initial data
  useEffect(() => {
    const init = async () => {
      const [ds, pr, mode] = await Promise.all([
        fetchDatasets(),
        fetchPresets(),
        fetchEngineMode(),
      ]);
      setDatasets(ds);
      setEngineMode(mode);
      setCatalogGroups(pr.groups);
      setPresets(pr.presets);
      initializedRef.current = true;
    };
    init();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load schema when dataset changes
  useEffect(() => {
    if (!selectedDataset) return;
    fetchSchema(selectedDataset).then(setSchema);
  }, [selectedDataset]);


  // Handle preset selection (from toolbar dropdown)
  const handleSelectPreset = useCallback(
    (preset: PresetQuery) => {
      queryGraph.loadPreset(preset.content as Record<string, unknown>);
      setResult(null);
      setQueryContext(null);
      setCompareResult(null);
      setCompareQueryContext(null);
      setCompareSlotAResult(null);
      setCompareSlotAContext(null);
      setCompareLoadingSlotA(false);
      setCompareLoadingSlotB(false);
      setConstraintToggles(DEFAULT_TOGGLES);
      setWalkthroughDef(null);
      setLastPresetFilename(preset.filename);
      setSelectedPresetName(preset.name);
      setLayoutKey(k => k + 1);
      setActiveView('query');
    },
    [queryGraph],
  );

  // Handle WelcomeScreen scenario click: load preset, auto-run, auto-compare if has constraints
  const handleContinue = useCallback(
    (datasetId: string, preset: PresetQuery | null) => {
      setSelectedDataset(datasetId);
      setShowWelcome(false);

      if (!preset) return; // custom query — just enter editor

      queryGraph.loadPreset(preset.content as Record<string, unknown>);
      setLastPresetFilename(preset.filename);
      setSelectedPresetName(preset.name);
      setResult(null);
      setQueryContext(null);
      setCompareResult(null);
      setCompareQueryContext(null);
      setCompareSlotAResult(null);
      setCompareSlotAContext(null);
      setCompareLoadingSlotA(false);
      setCompareLoadingSlotB(false);
      setConstraintToggles(DEFAULT_TOGGLES);
      setWalkthroughDef(null);
      setLayoutKey(k => k + 1);

      // Navigate to query editor — user clicks "Run Query" to execute
      setActiveView('query');
    },
    [queryGraph],
  );


  // Handle constraint toggle changes — re-run query with modified constraints
  const handleToggleChange = useCallback(async (next: ConstraintToggles) => {
    setConstraintToggles(next);
    const graph = queryGraph.getQueryGraph();
    if (graph.vertices.length === 0) return;

    const toggledJSON = buildToggledQueryJSON(graph, next);
    setToggleRunning(true);
    try {
      if (next.compareWithPlain) {
        // Sequential: backend only allows one query at a time (_query_lock → 409 if parallel)
        const plainGraph = buildPlainGraph(graph);
        const plainJSON = buildQueryJSON(plainGraph);
        let plainRes = await runQuery(plainJSON, selectedDataset);
        const constrainedRes = await runQuery(toggledJSON, selectedDataset);
        plainRes = await expandCrpqSamples(plainGraph, plainRes, selectedDataset, runQuery);
        setCompareSlotAResult(plainRes);
        setCompareSlotAContext(plainGraph);
        setCompareResult(constrainedRes);
        setCompareQueryContext(graph);
        setActiveView('compare');
      } else {
        // Single run with toggled constraints
        setCompareResult(null);
        setCompareQueryContext(null);
        const res = await runQuery(toggledJSON, selectedDataset);
        setResult(res);
        setQueryContext(graph);
        setActiveView('graph');
      }
    } catch {
      // ignore
    } finally {
      setToggleRunning(false);
    }
  }, [queryGraph, selectedDataset]);

  // Detected constraint types for the current query graph
  const detectedConstraints = useMemo(
    () => detectConstraints(queryGraph.getQueryGraph()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryGraph.vertices, queryGraph.edges, queryGraph.weConstraints],
  );

  // Run comparison from Compare tab empty state
  const handleRunComparison = useCallback(async () => {
    const graph = queryGraph.getQueryGraph();
    if (graph.vertices.length === 0) return;

    const graphHasConstraints = graph.weConstraints.length > 0 ||
      graph.edges.some(e => e.minLength != null || e.maxLength != null);
    const currentResultIsConstrained = !!(queryContext && (
      queryContext.weConstraints.length > 0 ||
      queryContext.edges.some(e => e.minLength != null || e.maxLength != null)
    ));

    setQueryError(null);
    setCompareLoadingSlotA(false);
    setCompareLoadingSlotB(false);

    // Helper: run query with retry on 409 Conflict (daemon busy after crash/respawn)
    const runWithRetry = async (qj: Record<string, unknown>, ds: string): Promise<QueryResult> => {
      try {
        return await runQuery(qj, ds);
      } catch (err) {
        if (err instanceof Error && err.message.includes('409')) {
          await new Promise(r => setTimeout(r, 2000));
          return await runQuery(qj, ds);
        }
        throw err;
      }
    };

    try {
      if (graphHasConstraints && result && currentResultIsConstrained) {
        // Current result is the constrained version → promote to Slot B, load plain for Slot A
        setCompareResult(result);
        setCompareQueryContext(queryContext);
        setActiveView('compare');

        setCompareLoadingSlotA(true);
        const plainGraph = buildPlainGraph(graph);
        let plainRes = await runWithRetry(buildQueryJSON(plainGraph), selectedDataset);
        plainRes = await expandCrpqSamples(plainGraph, plainRes, selectedDataset, runWithRetry);
        setCompareSlotAResult(plainRes);
        setCompareSlotAContext(plainGraph);
        setCompareLoadingSlotA(false);
      } else if (graphHasConstraints && result && !currentResultIsConstrained) {
        // Current result is plain → expand samples for Slot A, then load constrained
        setActiveView('compare');

        setCompareLoadingSlotA(true);
        const plainGraph2 = buildPlainGraph(graph);
        const expandedResult = await expandCrpqSamples(plainGraph2, result, selectedDataset, runWithRetry);
        setCompareSlotAResult(expandedResult);
        setCompareSlotAContext(plainGraph2);
        setCompareLoadingSlotA(false);

        setCompareLoadingSlotB(true);
        const constrainedRes = await runWithRetry(buildQueryJSON(graph), selectedDataset);
        setCompareResult(constrainedRes);
        setCompareQueryContext(graph);
        setCompareLoadingSlotB(false);
      } else {
        // No prior result → load constrained (Slot B) first, then plain (Slot A)
        setActiveView('compare');

        setCompareLoadingSlotB(true);
        const constrainedRes = await runWithRetry(buildQueryJSON(graph), selectedDataset);
        setCompareResult(constrainedRes);
        setCompareQueryContext(graph);
        setCompareLoadingSlotB(false);

        setCompareLoadingSlotA(true);
        const plainGraph = buildPlainGraph(graph);
        let plainRes = await runWithRetry(buildQueryJSON(plainGraph), selectedDataset);
        plainRes = await expandCrpqSamples(plainGraph, plainRes, selectedDataset, runWithRetry);
        setCompareSlotAResult(plainRes);
        setCompareSlotAContext(plainGraph);
        setCompareLoadingSlotA(false);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Comparison failed';
      setQueryError(message);
      // Clear all compare state on error to prevent stale partial results
      setCompareResult(null);
      setCompareQueryContext(null);
      setCompareSlotAResult(null);
      setCompareSlotAContext(null);
      setCompareLoadingSlotA(false);
      setCompareLoadingSlotB(false);
    }
  }, [queryGraph, selectedDataset, result, queryContext]);

  // Run a different preset for a specific compare slot
  const handleRunForSlot = useCallback(async (slot: 'A' | 'B', presetContent: Record<string, unknown>) => {
    try {
      if (slot === 'A') {
        setCompareLoadingSlotA(true);
        const res = await runQuery(presetContent, selectedDataset);
        setCompareSlotAResult(res);
        setCompareLoadingSlotA(false);
      } else {
        setCompareLoadingSlotB(true);
        const res = await runQuery(presetContent, selectedDataset);
        setCompareResult(res);
        setCompareLoadingSlotB(false);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to run query for slot';
      setQueryError(message);
      setCompareLoadingSlotA(false);
      setCompareLoadingSlotB(false);
    }
  }, [selectedDataset]);

  // Start a guided walkthrough for the current preset
  // Run a walkthrough step
  const handleWalkthroughRunStep = useCallback(async (toggles: ConstraintToggles) => {
    const graph = queryGraph.getQueryGraph();
    if (graph.vertices.length === 0) return;

    setWalkthroughRunning(true);
    setConstraintToggles(toggles);

    try {
      if (toggles.compareWithPlain) {
        // Sequential: backend only allows one query at a time
        const plainGraph = buildPlainGraph(graph);
        const plainJSON = buildQueryJSON(plainGraph);
        const toggledJSON = buildToggledQueryJSON(graph, toggles);

        let plainRes = await runQuery(plainJSON, selectedDataset);
        const constrainedRes = await runQuery(toggledJSON, selectedDataset);
        plainRes = await expandCrpqSamples(plainGraph, plainRes, selectedDataset, runQuery);
        setCompareSlotAResult(plainRes);
        setCompareSlotAContext(plainGraph);
        setCompareResult(constrainedRes);
        setCompareQueryContext(graph);

        // Record the constrained result for the walkthrough
        setWalkthroughResults(prev => {
          const next = [...prev];
          next[walkthroughStep] = { count: constrainedRes.total_count, elapsed_ms: constrainedRes.elapsed_ms };
          return next;
        });
      } else {
        // Single run (first step = plain)
        const toggledJSON = buildToggledQueryJSON(graph, toggles);
        const res = await runQuery(toggledJSON, selectedDataset);
        setResult(res);
        setQueryContext(graph);
        setCompareResult(null);
        setCompareQueryContext(null);

        setWalkthroughResults(prev => {
          const next = [...prev];
          next[walkthroughStep] = { count: res.total_count, elapsed_ms: res.elapsed_ms };
          return next;
        });
      }

      setWalkthroughStep(prev => prev + 1);
    } catch {
      // ignore
    } finally {
      setWalkthroughRunning(false);
    }
  }, [queryGraph, selectedDataset, walkthroughStep]);

  // Close walkthrough
  const handleCloseWalkthrough = useCallback(() => {
    setWalkthroughDef(null);
    setWalkthroughStep(0);
    setWalkthroughResults([]);
  }, []);


  // ── What-If chips ──

  const whatIfSuggestions = useMemo(() => {
    const sid = lastPresetFilename?.match(/^(S\d+)/)?.[1] ?? null;
    return generateSuggestions(sid, detectedConstraints, constraintToggles, !!result);
  }, [lastPresetFilename, detectedConstraints, constraintToggles, result]);

  const handleWhatIfConstraint = useCallback((patch: Partial<ConstraintToggles>) => {
    handleToggleChange({ ...constraintToggles, ...patch, compareWithPlain: true });
  }, [constraintToggles, handleToggleChange]);

  // Start a blank new query
  const handleNewQuery = useCallback(() => {
    queryGraph.clearQuery();
    setResult(null);
    setQueryError(null);
    setQueryContext(null);
    setCompareResult(null);
    setCompareQueryContext(null);
    setCompareSlotAResult(null);
    setCompareSlotAContext(null);
    setConstraintToggles(DEFAULT_TOGGLES);
    setWalkthroughDef(null);
    setLastPresetFilename(null);
    setSelectedPresetName(null);
    setJsonOverride(null);
    setActiveView('query');
    setSidebarTab('presets');
  }, [queryGraph]);

  // Restore a history item into the canvas
  const handleRestoreHistory = useCallback((item: HistoryItem) => {
    if (item.datasetId !== selectedDataset) setSelectedDataset(item.datasetId);
    queryGraph.loadPreset(item.queryJSON);
    setLastPresetFilename(item.presetFilename);
    setSelectedPresetName(item.name);
    setResult(null); setQueryError(null); setQueryContext(null);
    setCompareResult(null); setCompareQueryContext(null);
    setCompareSlotAResult(null); setCompareSlotAContext(null);
    setActiveView('query');
    setLayoutKey(k => k + 1);
  }, [queryGraph, selectedDataset]);

  // Handle run query
  const handleRun = useCallback(async () => {
    let queryJson: Record<string, unknown>;
    if (jsonOverride) {
      queryJson = jsonOverride;
    } else {
      const graph = queryGraph.getQueryGraph();
      if (graph.vertices.length === 0) return;
      queryJson = buildQueryJSON(graph);
      setQueryContext({
        vertices: [...graph.vertices],
        edges: [...graph.edges],
        weConstraints: [...graph.weConstraints],
      });
    }

    setIsLoading(true);
    setResult(null);
    setQueryError(null);

    try {
      const res = await runQuery(queryJson, selectedDataset);
      setResult(res);
      setActiveView('graph');
      // Save to history
      const hItem: HistoryItem = {
        id: String(Date.now()),
        timestamp: Date.now(),
        name: selectedPresetName ?? `Query ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
        datasetId: selectedDataset,
        queryJSON: queryJson,
        totalCount: typeof res.total_count === 'number' ? res.total_count : null,
        queryType: res.query_type ?? null,
        presetFilename: lastPresetFilename,
      };
      setHistory(prev => {
        const next = [hItem, ...prev].slice(0, 50);
        localStorage.setItem('wgd-history', JSON.stringify(next));
        return next;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Query failed';
      setQueryError(message);
    } finally {
      setIsLoading(false);
    }
  }, [queryGraph, jsonOverride, selectedDataset]);



  if (showWelcome) {
    return (
      <WelcomeScreen
        datasets={datasets}
        presets={presets}
        catalogGroups={catalogGroups}
        onContinue={handleContinue}
        isDark={isDark}
        onToggleTheme={handleToggleTheme}
      />
    );
  }

  return (
    <div className={`flex flex-col h-screen ${isDark ? 'dark bg-gray-950 text-gray-100' : 'bg-slate-50 text-gray-900'}`}>
      {/* Toolbar */}
      <Toolbar
        datasets={datasets}
        selectedDataset={selectedDataset}
        onSelectDataset={setSelectedDataset}
        onShowWelcome={() => setShowWelcome(true)}
        isMockMode={isMockMode()}
        engineMode={engineMode}
        cacheMode={cacheMode}
        onToggleCacheMode={() => setCacheModeState((v) => !v)}
        isDark={isDark}
        onToggleTheme={handleToggleTheme}
      />

      {/* Main area: Sidebar + Content */}
      <div className="flex flex-1 min-h-0">

        {/* ── Left Sidebar (Presets/History) ── always visible, collapsible */}
        {!sidebarCollapsed ? (
          <div
            className={`shrink-0 flex flex-col ${isDark ? 'bg-gray-950 border-r border-gray-800/60' : 'bg-white border-r border-gray-200'}`}
            style={{ width: sidebarW }}
          >
            {/* Tab header */}
            <div className={`flex items-center shrink-0 border-b ${isDark ? 'border-gray-800/60' : 'border-gray-200'}`}>
              {(['presets', 'history'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setSidebarTab(tab)}
                  className={`flex-1 py-2 text-[14px] font-bold uppercase tracking-wider transition-colors relative ${
                    sidebarTab === tab
                      ? isDark ? 'text-white' : 'text-gray-900'
                      : isDark ? 'text-gray-500 hover:text-gray-300' : 'text-gray-400 hover:text-gray-700'
                  }`}
                >
                  {tab === 'presets' ? 'Presets' : 'History'}
                  {sidebarTab === tab && (
                    <span className={`absolute bottom-0 left-2 right-2 h-0.5 rounded-full ${isDark ? 'bg-cyan-400' : 'bg-cyan-500'}`} />
                  )}
                  {tab === 'history' && history.length > 0 && sidebarTab !== 'history' && (
                    <span className={`ml-1 text-[15px] px-1 py-0.5 rounded-full font-bold ${isDark ? 'bg-cyan-900/60 text-cyan-400' : 'bg-cyan-100 text-cyan-600'}`}>
                      {history.length}
                    </span>
                  )}
                </button>
              ))}
              {/* Collapse button */}
              <button
                onClick={() => setSidebarCollapsed(true)}
                className={`px-2 py-2 transition-colors ${isDark ? 'text-gray-600 hover:text-gray-400' : 'text-gray-300 hover:text-gray-500'}`}
                title="Collapse sidebar"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M10 3L5 8l5 5"/>
                </svg>
              </button>
            </div>

            {/* Presets panel */}
            {sidebarTab === 'presets' && (
              <div className="flex-1 overflow-y-auto py-1">
                {presetGroups.map(([groupLabel, items, groupColor]) => {
                  const clr = groupColor;
                  return (
                    <div key={groupLabel} className="mb-2">
                      <div className="flex items-center gap-1.5 px-3 pt-2 pb-1">
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: clr }} />
                        <span className="text-[14px] font-bold uppercase tracking-wider" style={{ color: clr }}>{groupLabel}</span>
                      </div>
                      {items.map((p) => {
                        const isActive = selectedPresetName === p.name;
                        const { id, title, meta } = parsePresetLabel(p, p.filename, catalogGroups);
                        const isHovered = hoveredPresetFile === p.filename;
                        return (
                          <div key={p.filename} className="relative">
                            <button
                              onClick={() => handleSelectPreset(p)}
                              onMouseEnter={() => setHoveredPresetFile(p.filename)}
                              onMouseLeave={() => setHoveredPresetFile(null)}
                              className={`w-full text-left px-3 py-1.5 flex items-start gap-2 transition-colors ${
                                isActive
                                  ? isDark ? 'bg-cyan-900/25 border-l-2 border-cyan-500 pl-[10px]' : 'bg-cyan-50 border-l-2 border-cyan-500 pl-[10px]'
                                  : isDark ? 'hover:bg-gray-800/50 border-l-2 border-transparent' : 'hover:bg-gray-50 border-l-2 border-transparent'
                              }`}
                            >
                              <span className="text-[14px] font-bold rounded px-1 py-0.5 shrink-0 mt-0.5" style={{ backgroundColor: clr + '22', color: clr }}>
                                {id}
                              </span>
                              <div className="min-w-0">
                                <div className={`text-xs leading-tight truncate ${isActive ? (isDark ? 'text-cyan-300' : 'text-cyan-700') : (isDark ? 'text-gray-300' : 'text-gray-700')}`}>
                                  {title}
                                </div>
                              </div>
                            </button>
                            {/* Hover tooltip — always mounted, fades in/out */}
                            {meta && (
                              <div
                                className="absolute z-50 px-3 py-2.5 rounded-xl pointer-events-none"
                                style={{
                                  left: '100%',
                                  top: '50%',
                                  transform: isHovered
                                    ? 'translateY(-50%) translateX(0px) scale(1)'
                                    : 'translateY(-50%) translateX(-6px) scale(0.96)',
                                  marginLeft: 10,
                                  width: 272,
                                  opacity: isHovered ? 1 : 0,
                                  transition: isHovered
                                    ? 'opacity 110ms ease-out, transform 110ms ease-out'
                                    : 'opacity 80ms ease-in, transform 80ms ease-in',
                                  background: isDark ? 'rgba(10,18,36,0.97)' : 'rgba(255,255,255,0.98)',
                                  border: `1px solid ${clr}50`,
                                  backdropFilter: 'blur(12px)',
                                  boxShadow: isDark
                                    ? `0 8px 24px rgba(0,0,0,0.5), 0 0 0 1px ${clr}25, inset 0 1px 0 rgba(255,255,255,0.04)`
                                    : `0 8px 24px rgba(0,0,0,0.12), 0 0 0 1px ${clr}20`,
                                }}
                              >
                                {/* Color accent bar */}
                                <div className="absolute left-0 top-3 bottom-3 w-[3px] rounded-r-full" style={{ background: clr, opacity: 0.7 }} />
                                <div className="pl-3">
                                  <div className="flex items-center gap-1.5 mb-1.5">
                                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md" style={{ background: `${clr}22`, color: clr }}>{id}</span>
                                    <span className="text-[10px] px-1.5 py-0.5 rounded-md" style={{
                                      background: clr + '18',
                                      color: clr,
                                    }}>{meta.queryType}</span>
                                  </div>
                                  {meta.shortDesc && (
                                    <div className={`text-[11px] font-semibold mb-1 font-mono leading-snug ${isDark ? 'text-cyan-300/90' : 'text-cyan-700/90'}`}>{meta.shortDesc}</div>
                                  )}
                                  {meta.fullDesc && (
                                    <div className={`text-[12px] leading-relaxed ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{meta.fullDesc}</div>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}

            {/* History panel */}
            {sidebarTab === 'history' && (
              <div className="flex-1 overflow-y-auto flex flex-col">
                {history.length === 0 ? (
                  <div className="flex flex-col items-center justify-center flex-1 px-3 gap-2">
                    <svg className={`w-8 h-8 ${isDark ? 'text-gray-700' : 'text-gray-300'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                    </svg>
                    <p className={`text-[15px] text-center ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>No history yet</p>
                    <p className={`text-[14px] text-center ${isDark ? 'text-gray-700' : 'text-gray-300'}`}>Run a query to see it here</p>
                  </div>
                ) : (
                  <>
                    <div className={`flex items-center justify-between px-3 py-1.5 shrink-0 border-b ${isDark ? 'border-gray-800/60' : 'border-gray-200'}`}>
                      <span className={`text-[14px] ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>{history.length} run{history.length !== 1 ? 's' : ''}</span>
                      <button
                        onClick={() => {
                          setHistory([]);
                          localStorage.removeItem('wgd-history');
                        }}
                        className={`text-[14px] transition-colors ${isDark ? 'text-gray-600 hover:text-red-400' : 'text-gray-400 hover:text-red-500'}`}
                      >
                        Clear
                      </button>
                    </div>
                    <div className="flex-1 overflow-y-auto py-1">
                      {history.map(item => {
                        const time = new Date(item.timestamp);
                        const now = new Date();
                        const isToday = time.toDateString() === now.toDateString();
                        const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                        const dateStr = isToday ? timeStr : time.toLocaleDateString([], { month: 'short', day: 'numeric' });
                        const typeColorMap: Record<string, string> = {
                          rpq: '#3182F6', crpq: '#22c55e', word_equality: '#22d3ee',
                        };
                        const tc = item.queryType ? (typeColorMap[item.queryType] ?? '#94a3b8') : '#94a3b8';
                        const typeLabel = item.queryType === 'word_equality' ? 'WE' : item.queryType?.toUpperCase() ?? '?';
                        return (
                          <button
                            key={item.id}
                            onClick={() => handleRestoreHistory(item)}
                            className={`w-full text-left px-3 py-2 transition-colors border-l-2 border-transparent ${
                              isDark ? 'hover:bg-gray-800/60 hover:border-cyan-500/50' : 'hover:bg-gray-50 hover:border-cyan-400/50'
                            }`}
                          >
                            <div className="flex items-center gap-1.5 mb-0.5">
                              <span className="text-[15px] font-bold px-1.5 py-0.5 rounded shrink-0" style={{ backgroundColor: tc + '22', color: tc }}>
                                {typeLabel}
                              </span>
                              <span className={`text-[14px] truncate flex-1 font-medium ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                                {item.name}
                              </span>
                            </div>
                            <div className="flex items-center justify-between gap-1">
                              {item.totalCount != null ? (
                                <span className={`text-[14px] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                                  {item.totalCount >= 1e9
                                    ? `${(item.totalCount / 1e9).toFixed(1)}B`
                                    : item.totalCount >= 1e6
                                    ? `${(item.totalCount / 1e6).toFixed(1)}M`
                                    : item.totalCount.toLocaleString()} results
                                </span>
                              ) : <span />}
                              <span className={`text-[15px] shrink-0 ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>
                                {dateStr}
                              </span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        ) : (
          /* Sidebar collapsed — thin expand strip */
          <div
            className={`shrink-0 flex flex-col items-center pt-2 cursor-pointer transition-colors ${
              isDark ? 'bg-gray-950 border-r border-gray-800/60 hover:bg-gray-900' : 'bg-white border-r border-gray-200 hover:bg-gray-50'
            }`}
            style={{ width: 32 }}
            onClick={() => setSidebarCollapsed(false)}
            title="Expand sidebar"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
              className={isDark ? 'text-gray-600' : 'text-gray-400'}
            >
              <path d="M6 3l5 5-5 5"/>
            </svg>
          </div>
        )}

        {/* Sidebar resize handle */}
        {!sidebarCollapsed && (
          <div
            className={`shrink-0 w-1 cursor-col-resize group relative ${isDark ? 'border-r border-gray-800/60 hover:border-cyan-600/60' : 'border-r border-gray-200 hover:border-cyan-400/60'} transition-colors`}
            onMouseDown={handleSidebarResizeDown}
          >
            <div className={`absolute inset-y-0 -left-0.5 -right-0.5 group-active:bg-cyan-500/30`} />
          </div>
        )}

        {/* ── Main Content Area ── */}
        <div className="flex-1 min-w-0 flex flex-col">

          {/* Tab navigation */}
          <div className={`flex items-center border-b shrink-0 px-1.5 gap-0.5 ${isDark ? 'bg-gray-950 border-gray-800/60' : 'bg-white border-gray-200'}`}>
            {([
              { key: 'query'     as AppView, label: 'Query',
                icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M11 2.5l2.5 2.5-8.5 8.5H2.5V11L11 2.5z"/></svg> },
              { key: 'graph'     as AppView, label: 'Results',
                icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="8" cy="3.5" r="1.8" fill="currentColor" stroke="none"/><circle cx="3" cy="12.5" r="1.8" fill="currentColor" stroke="none"/><circle cx="13" cy="12.5" r="1.8" fill="currentColor" stroke="none"/><path d="M7 5L3.8 10.8M9 5l3.2 5.8M4.8 12.5h6.4"/></svg> },
              { key: 'compare'   as AppView, label: 'Compare',
                icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 1v14M3 4h4M3 8h4M9 6h4M9 10h4"/></svg> },
              { key: 'benchmark' as AppView, label: 'Benchmark',
                icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 14V9M6 14V5M10 14V8M14 14V3"/></svg> },
            ] as Array<{ key: AppView; label: string; icon: React.ReactNode }>).map(({ key, label, icon }) => {
              const isActive = activeView === key;
              const resultBadge = key !== 'query' && !isActive && (isLoading || result || queryError);
              return (
                <button
                  key={key}
                  onClick={() => setActiveView(key)}
                  className={`relative flex items-center gap-1.5 px-3.5 py-2.5 text-sm font-semibold rounded-t transition-all ${
                    isActive
                      ? isDark ? 'text-white bg-gray-900/60' : 'text-gray-900 bg-gray-50'
                      : isDark ? 'text-gray-500 hover:text-gray-300 hover:bg-gray-900/40' : 'text-gray-400 hover:text-gray-700 hover:bg-gray-100/70'
                  }`}
                >
                  {icon}
                  {label}
                  {isActive && (
                    <span className={`absolute bottom-0 left-2 right-2 h-0.5 rounded-full ${isDark ? 'bg-cyan-400' : 'bg-cyan-500'}`} />
                  )}
                  {resultBadge && (
                    <span className={`w-1.5 h-1.5 rounded-full ${
                      isLoading ? 'bg-amber-400' : queryError ? 'bg-red-400' : 'bg-emerald-400'
                    }`} />
                  )}
                </button>
              );
            })}
            {/* Fit button — only on graph/results view */}
            {activeView === 'graph' && result && (
              <button
                className={`ml-auto mr-2 text-xs px-2.5 py-1 rounded-md border transition-colors ${isDark ? 'text-gray-400 border-gray-700 hover:text-gray-200 hover:border-gray-500' : 'text-gray-500 border-gray-200 hover:text-gray-700 hover:border-gray-300'}`}
                onClick={() => resultGraphFitRef.current?.()}
                title="Fit graph to view"
              >
                Fit
              </button>
            )}
          </div>

          {/* Tab content */}
          <div className="flex-1 min-h-0 relative overflow-hidden">

            {/* Query view */}
            <div className={`absolute inset-0 flex flex-col transition-opacity duration-150 ${activeView === 'query' ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}>
              <QueryEditor
                description={(() => {
                  const selectedPreset = presets.find(p => p.filename === lastPresetFilename);
                  const { id, meta } = parsePresetLabel(selectedPreset, lastPresetFilename ?? '', catalogGroups);
                  return meta ? { id, title: meta.title, shortDesc: meta.shortDesc, fullDesc: meta.fullDesc, queryType: meta.queryType } : undefined;
                })()}
                vertices={queryGraph.vertices}
                edges={queryGraph.edges}
                weConstraints={queryGraph.weConstraints}
                schema={schema}
                onAddVertex={queryGraph.addVertex}
                onUpdateVertex={queryGraph.updateVertex}
                onAddEdge={queryGraph.addEdge}
                onUpdateEdge={queryGraph.updateEdge}
                onRemoveElement={queryGraph.removeElement}
                onMoveVertex={queryGraph.moveVertex}
                onRemoveConstraint={queryGraph.removeWEConstraint}
                onAddConstraint={queryGraph.addWEConstraint}
                onFitRef={queryCanvasFitRef}
                onLoadPreset={queryGraph.loadPreset}
                onJSONOverride={setJsonOverride}
                layoutKey={layoutKey}
                isDark={isDark}
                onRun={handleRun}
                onNew={handleNewQuery}
                isLoading={isLoading}
              />
            </div>

            {/* Results / Compare / Benchmark — single ResultPanel, always mounted */}
            <div className={`absolute inset-0 transition-opacity duration-150 ${activeView !== 'query' ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}>
              <ResultPanel
                result={result}
                isLoading={isLoading}
                error={queryError}
                queryContext={queryContext}
                schema={schema}
                onFitRef={resultGraphFitRef}
                isDark={isDark}
                presetFilename={lastPresetFilename}
                onRunQuery={handleRun}
                activeTab={activeView === 'query' ? 'graph' : activeView === 'compare' ? 'compare' : activeView as ResultTab}
                compareResult={compareResult}
                compareQueryContext={compareQueryContext}
                compareSlotAResult={compareSlotAResult}
                compareSlotAContext={compareSlotAContext}
                compareLoadingSlotA={compareLoadingSlotA}
                compareLoadingSlotB={compareLoadingSlotB}
                constraintToggles={constraintToggles}
                detectedConstraints={detectedConstraints}
                walkthroughDef={walkthroughDef}
                walkthroughStep={walkthroughStep}
                walkthroughResults={walkthroughResults}
                walkthroughRunning={walkthroughRunning}
                onWalkthroughRunStep={handleWalkthroughRunStep}
                onWalkthroughClose={handleCloseWalkthrough}
                whatIfSuggestions={whatIfSuggestions}
                onWhatIfConstraint={handleWhatIfConstraint}
                onNavigateQuery={() => setActiveView('query')}
                onRunComparison={handleRunComparison}
                originalQueryContext={compareQueryContext ?? queryContext}
                onRunForSlot={handleRunForSlot}
                presets={presets as Array<{ name: string; filename: string; content: Record<string, unknown> }>}
                datasetId={selectedDataset}
              />

            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;