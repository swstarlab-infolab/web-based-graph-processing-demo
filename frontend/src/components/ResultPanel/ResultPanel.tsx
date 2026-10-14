import { useState, useCallback, useEffect, useRef, useMemo, type FC, type MutableRefObject } from 'react';
import type { QueryResult, QueryGraph, Schema, WESamplePair } from '../../types';
import type { PathAnnotation } from '../../utils/pathDiff';
import ForceGraph from './ForceGraph';
import PathList from './PathList';
import BenchmarkPanel from './BenchmarkPanel';
import { WalkthroughBanner } from '../GuidedWalkthrough';
import type { ConstraintToggles } from '../../utils/queryToggle';
import type { WalkthroughDef } from '../../data/walkthroughSteps';
import type { StepResult } from '../GuidedWalkthrough';

import WhatIfBar from '../WhatIfBar';
import type { WhatIfChip } from '../../data/whatIfSuggestions';
import QueryCanvas from '../QueryCanvas/QueryCanvas';

export type ResultTab = 'graph' | 'compare' | 'benchmark';

interface ResultPanelProps {
  result: QueryResult | null;
  isLoading: boolean;
  error?: string | null;
  queryContext?: QueryGraph | null;
  schema?: Schema | null;
  onFitRef?: MutableRefObject<(() => void) | null>;
  isDark?: boolean;
  presetFilename?: string | null;
  onRunQuery?: () => void;
  activeTab?: ResultTab;
  compareResult?: QueryResult | null;
  compareQueryContext?: QueryGraph | null;
  compareSlotAResult?: QueryResult | null;
  compareSlotAContext?: QueryGraph | null;
  constraintToggles?: ConstraintToggles;
  detectedConstraints?: { hasWE: boolean; hasPrefixWE: boolean; hasLength: boolean };
  walkthroughDef?: WalkthroughDef | null;
  walkthroughStep?: number;
  walkthroughResults?: (StepResult | null)[];
  walkthroughRunning?: boolean;
  onWalkthroughRunStep?: (toggles: ConstraintToggles) => void;
  onWalkthroughClose?: () => void;
  whatIfSuggestions?: WhatIfChip[];
  onWhatIfConstraint?: (patch: Partial<ConstraintToggles>) => void;
  onNavigateQuery?: () => void;
  onRunComparison?: () => void;
  originalQueryContext?: QueryGraph | null;
  compareLoadingSlotA?: boolean;
  compareLoadingSlotB?: boolean;
  /** Run a different preset for a specific compare slot */
  onRunForSlot?: (slot: 'A' | 'B', presetContent: Record<string, unknown>) => void;
  /** Available presets for compare slot switching */
  presets?: Array<{ name: string; filename: string; content: Record<string, unknown> }>;
  /** Current dataset id for benchmark routing */
  datasetId?: string;
}

const ResultPanel: FC<ResultPanelProps> = ({
  result, isLoading, error, queryContext, schema, onFitRef,
  isDark = true, presetFilename, onRunQuery, activeTab = 'graph',
  compareResult, compareQueryContext,
  compareSlotAResult, compareSlotAContext,
  constraintToggles,
  detectedConstraints,
  walkthroughDef, walkthroughStep = 0, walkthroughResults = [],
  walkthroughRunning = false, onWalkthroughRunStep, onWalkthroughClose,
  whatIfSuggestions = [], onWhatIfConstraint,
  onNavigateQuery, onRunComparison, originalQueryContext,
  compareLoadingSlotA = false, compareLoadingSlotB = false,
  onRunForSlot, presets = [], datasetId,
}) => {
  const [hoveredPath, setHoveredPath] = useState<number | null>(null);
  const [soloPath, setSoloPath] = useState<number | null>(null);

  const [showQueryPreview, setShowQueryPreview] = useState(false);
  const [pathListW, setPathListW] = useState(420);
  const draggingSidebar = useRef(false);
  const dragStartRef = useRef({ x: 0, w: 288 });

  const dedupResult = useMemo((): QueryResult | null => {
    if (!result || result.query_type !== 'word_equality') return result;
    const seen = new Set<string>();
    const deduped = (result.samples as WESamplePair[]).filter(s => {
      const key = s.path1.vertices.join(',');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (deduped.length === result.samples.length) return result;
    return { ...result, samples: deduped };
  }, [result]);

  const dedupSlotAResult = useMemo((): QueryResult | null => {
    if (!compareSlotAResult || compareSlotAResult.query_type !== 'word_equality') return compareSlotAResult ?? null;
    const seen = new Set<string>();
    const deduped = (compareSlotAResult.samples as WESamplePair[]).filter(s => {
      const key = s.path1.vertices.join(',');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (deduped.length === compareSlotAResult.samples.length) return compareSlotAResult;
    return { ...compareSlotAResult, samples: deduped };
  }, [compareSlotAResult]);

  useEffect(() => { setSoloPath(null); }, [result]);

  // Auto-trigger comparison when Compare tab is shown with no data (only for constrained queries)
  const autoCompareTriggered = useRef(false);
  const hasConstraints = detectedConstraints && (detectedConstraints.hasWE || detectedConstraints.hasPrefixWE || detectedConstraints.hasLength);
  useEffect(() => {
    if (
      activeTab === 'compare' &&
      hasConstraints &&
      !error &&
      !compareResult && !compareLoadingSlotB &&
      !(dedupSlotAResult || compareLoadingSlotA) &&
      onRunComparison &&
      !autoCompareTriggered.current
    ) {
      autoCompareTriggered.current = true;
      onRunComparison();
    }
    // Reset flag when leaving compare tab so it re-triggers next time
    if (activeTab !== 'compare') {
      autoCompareTriggered.current = false;
    }
  }, [activeTab, hasConstraints, error, compareResult, compareLoadingSlotB, dedupSlotAResult, compareLoadingSlotA, onRunComparison]);

  const handleHoverPath = useCallback((index: number | null) => setHoveredPath(index), []);
  const handleClickPath = useCallback((index: number) => {
    setSoloPath((prev) => (prev === index ? null : index));
  }, []);

  const handleSidebarDragDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingSidebar.current = true;
    dragStartRef.current = { x: e.clientX, w: pathListW };
    const onMove = (mv: MouseEvent) => {
      if (!draggingSidebar.current) return;
      const delta = dragStartRef.current.x - mv.clientX;
      setPathListW(Math.max(180, Math.min(600, dragStartRef.current.w + delta)));
    };
    const onUp = () => {
      draggingSidebar.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [pathListW]);

  const d = isDark;
  const bg = d ? 'bg-gray-900' : 'bg-gray-50';
  /* ── States ── */
  const loadingState = (
    <div className={`flex flex-col h-full ${bg} items-center justify-center`}>
      <div className="flex flex-col items-center gap-4">
        <div className={`w-10 h-10 border-2 rounded-full animate-spin ${d ? 'border-gray-700 border-t-cyan-400' : 'border-gray-300 border-t-cyan-500'}`} />
        <span className={`text-sm ${d ? 'text-gray-400' : 'text-gray-500'}`}>Running query...</span>
      </div>
    </div>
  );

  const errorState = (
    <div className={`flex flex-col h-full ${bg} items-center justify-center`}>
      <div className="text-center max-w-md px-4">
        <div className={`w-12 h-12 mx-auto mb-4 rounded-full flex items-center justify-center ${d ? 'bg-red-900/30' : 'bg-red-100'}`}>
          <span className="text-red-400 text-xl">!</span>
        </div>
        <p className="text-red-400 text-sm font-medium mb-2">Query Error</p>
        <p className={`text-sm ${d ? 'text-gray-400' : 'text-gray-500'}`}>{error}</p>
      </div>
    </div>
  );

  const emptyState = (
    <div className={`flex flex-col h-full ${bg} items-center justify-center`}>
      <div className={`text-center ${d ? 'text-gray-500' : 'text-gray-400'}`}>
        <svg className={`w-16 h-16 mx-auto mb-4 ${d ? 'text-gray-700' : 'text-gray-300'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1}
            d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <p className="text-lg mb-3">No results yet</p>
        {onRunQuery && (
          <button onClick={onRunQuery} className={`px-5 py-2 rounded-lg text-sm font-semibold transition-all shadow-lg ${d ? 'bg-cyan-600 hover:bg-cyan-500 text-white' : 'bg-cyan-500 hover:bg-cyan-400 text-white'}`}>
            ▶ Run Query
          </button>
        )}
      </div>
    </div>
  );

  const compareEmptyState = (
    <div className={`flex flex-col h-full ${bg}`}>
      <div className={`flex flex-col items-center gap-5 px-6 pt-16 ${d ? '' : ''}`}>
        <svg className={`w-12 h-12 ${d ? 'text-gray-700' : 'text-gray-300'}`} fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 1v14M3 4h4M3 8h4M9 6h4M9 10h4"/>
        </svg>
        {!result ? (
          <>
            <p className={`text-base font-medium ${d ? 'text-gray-400' : 'text-gray-500'}`}>No query results yet</p>
            <p className={`text-sm text-center max-w-xs ${d ? 'text-gray-600' : 'text-gray-400'}`}>
              Run a query first, then compare plain vs extended results.
            </p>
          </>
        ) : !hasConstraints ? (
          <>
            <p className={`text-base font-medium ${d ? 'text-gray-400' : 'text-gray-500'}`}>
              This is a plain RPQ/CRPQ query
            </p>
            <p className={`text-sm text-center max-w-xs ${d ? 'text-gray-600' : 'text-gray-400'}`}>
              Add constraints (Word Equality, Prefix, or Length Bound) to see how the result changes.
            </p>
            {onNavigateQuery && (
              <button
                onClick={onNavigateQuery}
                className={`flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-bold transition-all shadow-lg ${
                  d ? 'bg-cyan-600 hover:bg-cyan-500 text-white shadow-cyan-600/30'
                    : 'bg-cyan-500 hover:bg-cyan-400 text-white shadow-cyan-500/30'
                }`}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3v10M3 8h10"/></svg>
                Add constraints
              </button>
            )}
          </>
        ) : (
          <>
            <p className={`text-base font-medium ${d ? 'text-gray-400' : 'text-gray-500'}`}>
              Compare plain vs extended
            </p>
            <p className={`text-sm text-center max-w-xs ${d ? 'text-gray-600' : 'text-gray-400'}`}>
              Run both the plain CRPQ and the extended version side by side to see what the constraints filter out.
            </p>
            <div className="flex items-center gap-3">
              {onNavigateQuery && (
                <button
                  onClick={onNavigateQuery}
                  className={`flex items-center gap-2 px-5 py-3 rounded-xl text-sm font-semibold transition-all ${
                    d ? 'bg-gray-800 border border-gray-600 text-gray-300 hover:bg-gray-700 hover:border-gray-500'
                      : 'bg-white border border-gray-300 text-gray-600 hover:bg-gray-50 hover:border-gray-400 shadow-sm'
                  }`}
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
                  Remove constraints
                </button>
              )}
              {onRunComparison && (
                <button
                  onClick={onRunComparison}
                  className={`flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-bold transition-all shadow-lg ${
                    d ? 'bg-cyan-600 hover:bg-cyan-500 text-white shadow-cyan-600/30'
                      : 'bg-cyan-500 hover:bg-cyan-400 text-white shadow-cyan-500/30'
                  }`}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 1v14M3 4h4M3 8h4M9 6h4M9 10h4"/></svg>
                  Compare with plain CRPQs
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );

  return (
    <div className={`h-full flex flex-col ${bg}`}>
      {activeTab === 'benchmark' ? (
        <BenchmarkPanel isDark={isDark} result={result} presetFilename={presetFilename} datasetId={datasetId} />
      ) : activeTab === 'compare' ? (
        /* No constraints → split view: left=result, right=add constraint */
        !hasConstraints && dedupResult ? (
          <div className={`flex h-full ${bg}`}>
            {/* Left: current result */}
            <div className={`flex-1 min-w-0 flex flex-col border-r ${d ? 'border-gray-700/60' : 'border-gray-200'}`}>
              <div className={`flex items-center gap-3 px-4 py-2.5 border-b shrink-0 ${d ? 'border-gray-700/80 bg-gray-800/40' : 'border-gray-200 bg-gray-50'}`}>
                <span className={`text-sm font-bold ${d ? 'text-gray-300' : 'text-gray-600'}`}>
                  {result?.query_type === 'rpq' ? 'RPQ' : 'CRPQ'} Result
                </span>
                <span className={`text-xs font-mono ${d ? 'text-gray-500' : 'text-gray-400'}`}>
                  {dedupResult.total_count.toLocaleString()} paths
                </span>
              </div>
              <div className="flex-1 flex min-h-0">
                <div className="flex-1 min-w-0">
                  <ForceGraph result={dedupResult} soloPath={soloPath} queryContext={queryContext ?? null} schema={schema ?? null} isDark={isDark} datasetId={datasetId} />
                </div>
                <div className={`shrink-0 border-l ${d ? 'border-gray-700/60' : 'border-gray-200'}`} style={{ width: Math.min(pathListW, 320) }}>
                  <PathList
                    result={dedupResult}
                    hoveredPath={hoveredPath}
                    soloPath={soloPath}
                    onHoverPath={handleHoverPath}
                    onClickPath={handleClickPath}
                    queryContext={queryContext ?? null}
                    schema={schema ?? null}
                    isDark={isDark}
                  />
                </div>
              </div>
            </div>
            {/* Right: add constraint CTA */}
            <div className="flex-1 min-w-0 flex flex-col items-center justify-center gap-5 px-8">
              <div className={`w-16 h-16 rounded-2xl flex items-center justify-center ${d ? 'bg-cyan-900/30 border border-cyan-700/30' : 'bg-cyan-50 border border-cyan-200'}`}>
                <svg width="28" height="28" viewBox="0 0 16 16" fill="none" stroke={d ? '#22d3ee' : '#0891b2'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3v10M3 8h10"/>
                </svg>
              </div>
              <div className="text-center">
                <p className={`text-base font-bold mb-2 ${d ? 'text-gray-200' : 'text-gray-700'}`}>
                  Add constraints to compare
                </p>
                <p className={`text-sm max-w-xs ${d ? 'text-gray-500' : 'text-gray-400'}`}>
                  Add Word Equality, Prefix WE, or Length Bound constraints to see how they filter the result.
                </p>
              </div>
              {onNavigateQuery && (
                <button
                  onClick={onNavigateQuery}
                  className={`flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-bold transition-all shadow-lg ${
                    d ? 'bg-cyan-600 hover:bg-cyan-500 text-white shadow-cyan-600/30'
                      : 'bg-cyan-500 hover:bg-cyan-400 text-white shadow-cyan-500/30'
                  }`}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M11 2l3 3-7 7H4v-3l7-7z"/></svg>
                  Edit Query
                </button>
              )}
            </div>
          </div>
        ) :
        (compareResult || compareLoadingSlotB) && (dedupSlotAResult || compareLoadingSlotA) ? (
          <CompareView
            resultA={dedupSlotAResult ?? null}
            resultB={compareResult ?? null}
            queryContextA={compareSlotAContext ?? null}
            queryContextB={compareQueryContext ?? null}
            schema={schema ?? null}
            isDark={isDark}
            constraintToggles={constraintToggles}
            detectedConstraints={detectedConstraints}
            loadingSlotA={compareLoadingSlotA}
            loadingSlotB={compareLoadingSlotB}
            onRunForSlot={onRunForSlot}
            presets={presets}
            datasetId={datasetId}
          />
        ) : compareEmptyState
      ) : isLoading ? (
        loadingState
      ) : error ? (
        errorState
      ) : !dedupResult ? (
        emptyState
      ) : (
        <>
          {/* ── Walkthrough banner (top, full-width) ── */}
          {walkthroughDef && onWalkthroughRunStep && onWalkthroughClose && (
            <WalkthroughBanner
              walkthrough={walkthroughDef}
              currentStep={walkthroughStep}
              stepResults={walkthroughResults}
              isRunning={walkthroughRunning}
              onRunStep={onWalkthroughRunStep}
              onClose={onWalkthroughClose}
              isDark={isDark}
            />
          )}

          <div className="flex flex-1 min-h-0 relative">
            <div className="flex-1 min-w-0 flex">
              <div className="flex-1 min-w-0 relative">
                <ForceGraph
                  result={dedupResult}
                  soloPath={soloPath}
                  queryContext={queryContext ?? null}
                  schema={schema ?? null}
                  onFitRef={onFitRef}
                  isDark={isDark}
                  onSoloPathChange={setSoloPath}
                  datasetId={datasetId}
                />
                {/* Top-left overlay: Query toggle button + floating preview */}
                {(originalQueryContext ?? queryContext) && (
                  <div className="absolute top-3 left-3 z-10 flex flex-col items-start gap-2">
                    {/* Toggle button */}
                    <button
                      onClick={() => setShowQueryPreview(v => !v)}
                      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition-colors backdrop-blur-md ${
                        showQueryPreview
                          ? d ? 'bg-cyan-900/60 border-cyan-700/60 text-cyan-300' : 'bg-cyan-50 border-cyan-300 text-cyan-700'
                          : d ? 'bg-gray-900/80 border-gray-700/50 text-gray-400 hover:text-gray-200 hover:border-gray-600'
                              : 'bg-white/85 border-gray-200 text-gray-500 hover:text-gray-700 hover:border-gray-300 shadow-sm'
                      }`}
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="8" cy="8" r="6" /><path d="M8 5v3l2 1" />
                      </svg>
                      Query
                    </button>
                    {/* Floating preview */}
                    {showQueryPreview && (
                      <div className={`rounded-xl border shadow-xl overflow-hidden flex flex-col ${
                        d ? 'bg-gray-900/95 border-gray-700/60' : 'bg-white/95 border-gray-200'
                      }`} style={{ width: 240 }}>
                        <div className={`flex items-center justify-between px-2.5 shrink-0 border-b ${
                          d ? 'border-gray-700/50' : 'border-gray-200'
                        }`} style={{ height: 28 }}>
                          <span className={`font-semibold uppercase tracking-wide text-[14px] ${d ? 'text-gray-500' : 'text-gray-400'}`}>
                            Query
                          </span>
                          <div className="flex items-center gap-1">
                            {onNavigateQuery && (
                              <button
                                onClick={onNavigateQuery}
                                className={`text-[14px] px-1 py-0.5 rounded transition-colors ${d ? 'text-cyan-400 hover:bg-cyan-400/10' : 'text-cyan-600 hover:bg-cyan-50'}`}
                              >
                                Edit
                              </button>
                            )}
                            <button
                              onClick={() => setShowQueryPreview(false)}
                              className={`text-[14px] w-5 h-5 flex items-center justify-center rounded transition-colors ${d ? 'text-gray-500 hover:text-gray-300 hover:bg-gray-700/50' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'}`}
                              title="Close"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                        <div className="relative" style={{ width: 240, height: 172 }}>
                          <QueryCanvas
                            vertices={(originalQueryContext ?? queryContext)!.vertices}
                            edges={(originalQueryContext ?? queryContext)!.edges}
                            weConstraints={(originalQueryContext ?? queryContext)!.weConstraints}
                            schema={schema ?? { vertex_labels: [], edge_labels: [] } as Schema}
                            onAddVertex={() => ''}
                            onUpdateVertex={() => {}}
                            onAddEdge={() => ''}
                            onUpdateEdge={() => {}}
                            onRemoveElement={() => {}}
                            isDark={isDark}
                            readOnly
                            compact
                          />
                          {onNavigateQuery && (
                            <div className="absolute inset-0 cursor-pointer" onClick={onNavigateQuery} title="Click to edit query" />
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {/* Bottom-right overlay: Stats + action button */}
                <div className="absolute bottom-3 right-3 z-10 flex flex-col items-end gap-2">
                {/* Stats + action button */}
                <div className="flex flex-col gap-2" style={{ width: 300 }}>
                  <div className={`flex items-center justify-center gap-4 px-3.5 py-2 rounded-lg backdrop-blur-md whitespace-nowrap ${
                    d ? 'bg-gray-900/80 border border-gray-700/50' : 'bg-white/85 border border-gray-200 shadow-sm'
                  }`}>
                    <div className="flex items-baseline gap-1.5">
                      <span className={`text-[10px] font-semibold uppercase tracking-wider ${d ? 'text-gray-500' : 'text-gray-400'}`}>Total</span>
                      <span className={`text-sm font-bold font-mono ${d ? 'text-cyan-400' : 'text-cyan-600'}`}>
                        {fmtCount(dedupResult.total_count)}
                      </span>
                    </div>
                    <div className="flex items-baseline gap-1.5">
                      <span className={`text-[10px] font-semibold uppercase tracking-wider ${d ? 'text-gray-500' : 'text-gray-400'}`}>Time</span>
                      <span className={`text-sm font-bold font-mono ${d ? 'text-emerald-400' : 'text-emerald-600'}`}>
                        {dedupResult.elapsed_ms < 0.1 ? '<0.001' : (dedupResult.elapsed_ms / 1000).toFixed(3)}s
                      </span>
                    </div>
                  </div>
                  {/* Engine correctness caveats: a warned count may be wrong or
                      a lower bound, so it is stated next to the count itself. */}
                  {dedupResult.warnings && dedupResult.warnings.length > 0 && (
                    <div
                      className={`px-3 py-2 rounded-lg text-[11px] leading-snug backdrop-blur-md ${
                        d
                          ? 'bg-amber-950/70 border border-amber-700/50 text-amber-200'
                          : 'bg-amber-50 border border-amber-300 text-amber-900'
                      }`}
                      role="status"
                    >
                      <span className="font-semibold">Count may be inexact</span>
                      <ul className="mt-1 list-disc pl-4 space-y-0.5">
                        {dedupResult.warnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {hasConstraints && onRunComparison ? (
                    <button
                      onClick={onRunComparison}
                      className={`w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all shadow-lg ${
                        d ? 'bg-cyan-600 hover:bg-cyan-500 text-white shadow-cyan-600/30' : 'bg-cyan-500 hover:bg-cyan-400 text-white shadow-cyan-500/30'
                      }`}
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 1v14M3 4h4M3 8h4M9 6h4M9 10h4"/></svg>
                      Compare with plain CRPQs
                    </button>
                  ) : !hasConstraints && onNavigateQuery ? (
                    <button
                      onClick={onNavigateQuery}
                      className={`w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all backdrop-blur-md ${
                        d ? 'bg-gray-800/90 border border-gray-700/50 text-gray-300 hover:bg-gray-700'
                          : 'bg-white/85 border border-gray-200 text-gray-600 hover:bg-gray-50 shadow-sm'
                      }`}
                    >
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3v10M3 8h10"/></svg>
                      Add constraints
                    </button>
                  ) : null}
                </div>
                </div>{/* end right overlay */}
              </div>
              <div
                className={`shrink-0 w-1 cursor-col-resize group relative ${d ? 'border-l border-gray-700/80 hover:border-cyan-600/60' : 'border-l border-gray-200 hover:border-cyan-400/60'} transition-colors`}
                onMouseDown={handleSidebarDragDown}
              >
                <div className="absolute inset-y-0 -left-1 -right-1 group-active:bg-cyan-500/30" />
              </div>
              <div className="shrink-0 overflow-hidden" style={{ width: pathListW }}>
                <PathList
                  result={dedupResult}
                  hoveredPath={hoveredPath}
                  soloPath={soloPath}
                  onHoverPath={handleHoverPath}
                  onClickPath={handleClickPath}
                  queryContext={queryContext ?? null}
                  schema={schema ?? null}
                  isDark={isDark}
                />
              </div>
            </div>

          </div>
        </>
      )}
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════
   CompareView — Side-by-side comparison
   ═══════════════════════════════════════════════════════════════════ */

function fmtCount(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

interface CompareViewProps {
  resultA: QueryResult | null;
  resultB: QueryResult | null;
  queryContextA: QueryGraph | null;
  queryContextB: QueryGraph | null;
  schema: Schema | null;
  isDark: boolean;
  constraintToggles?: ConstraintToggles;
  detectedConstraints?: { hasWE: boolean; hasPrefixWE: boolean; hasLength: boolean };
  loadingSlotA?: boolean;
  loadingSlotB?: boolean;
  /** Callback to run a different query for a specific slot */
  onRunForSlot?: (slot: 'A' | 'B', presetContent: Record<string, unknown>) => void;
  /** Available presets for slot switching */
  presets?: Array<{ name: string; filename: string; content: Record<string, unknown> }>;
  /** Dataset the results came from — forwarded for graph-context lookups */
  datasetId?: string;
}

const CompareView: FC<CompareViewProps> = ({
  resultA, resultB, queryContextA, queryContextB, schema, isDark: d,
  constraintToggles, detectedConstraints, loadingSlotA = false, loadingSlotB = false,
  onRunForSlot, presets = [], datasetId,
}) => {
  const [activeSampleA, setActiveSampleA] = useState<number | null>(null);
  const [activeSampleB, setActiveSampleB] = useState<number | null>(null);
  const [hoveredA, setHoveredA] = useState<number | null>(null);
  const [hoveredB, setHoveredB] = useState<number | null>(null);
  const [showGraphModal, setShowGraphModal] = useState(false);
  const [graphPanelH, setGraphPanelH] = useState(220);
  const graphDragRef = useRef(false);
  const graphDragStartRef = useRef({ y: 0, h: 220 });

  // Plain side: use resultA directly (plain CRPQ without WE/length constraints)
  const diffOnlyResult = useMemo((): QueryResult | null => {
    return resultA ?? null;
  }, [resultA]);

  // The plain side runs the query WITHOUT its word-equality constraint, so its
  // own context has no P1/P2 to read.  Take the roles from the extended side's
  // context -- the two graphs describe the same query edges -- so both columns
  // name the same chain the same way.
  const weRolesForPlain = useMemo((): Map<string, string> | null => {
    const wec = queryContextB?.weConstraints?.[0];
    if (!wec) return null;
    const roles = new Map<string, string>();
    const e1 = queryContextB?.edges.find((e) => e.id === wec.edge1Id);
    const e2 = queryContextB?.edges.find((e) => e.id === wec.edge2Id);
    roles.set(wec.edge1Id, e1?.automataName ?? 'P1');
    roles.set(wec.edge2Id, e2?.automataName ?? 'P2');
    return roles;
  }, [queryContextB]);

  // No edge-label annotations needed for the compare plain side
  const diffOnlyAnnotations = useMemo((): PathAnnotation[][] => {
    return (diffOnlyResult?.samples ?? []).map(() => []);
  }, [diffOnlyResult]);

  // Auto-select first sample when results arrive
  useEffect(() => {
    if (diffOnlyResult?.samples?.length) setActiveSampleA(0);
  }, [diffOnlyResult]);
  useEffect(() => {
    if (resultB?.samples?.length) setActiveSampleB(0);
  }, [resultB]);

  const handleClickA = useCallback((idx: number) => {
    setActiveSampleA(prev => prev === idx ? null : idx);
  }, []);
  const handleClickB = useCallback((idx: number) => {
    setActiveSampleB(prev => prev === idx ? null : idx);
  }, []);

  const handleGraphDragDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    graphDragRef.current = true;
    graphDragStartRef.current = { y: e.clientY, h: graphPanelH };
    const onMove = (mv: MouseEvent) => {
      if (!graphDragRef.current) return;
      const delta = mv.clientY - graphDragStartRef.current.y;
      setGraphPanelH(Math.max(120, Math.min(500, graphDragStartRef.current.h + delta)));
    };
    const onUp = () => {
      graphDragRef.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [graphPanelH]);

  const activeSampleResultA = useMemo((): QueryResult | null => {
    if (activeSampleA === null) return null;
    const src = diffOnlyResult;
    if (!src) return null;
    const s = src.samples[activeSampleA];
    if (!s) return null;
    return { ...src, samples: [s] as QueryResult['samples'], total_count: 1 };
  }, [activeSampleA, diffOnlyResult]);

  const activeSampleResultB = useMemo((): QueryResult | null => {
    if (activeSampleB === null || !resultB) return null;
    const s = resultB.samples[activeSampleB];
    if (!s) return null;
    return { ...resultB, samples: [s] as QueryResult['samples'], total_count: 1 };
  }, [activeSampleB, resultB]);

  const constrainedMaxLength = useMemo(() => {
    if (!queryContextB) return null;
    const e = queryContextB.edges.find(e => e.maxLength != null);
    return e?.maxLength ?? null;
  }, [queryContextB]);

  const constraintLabels = useMemo(() => {
    const labels: { text: string; color: string }[] = [];
    if (detectedConstraints) {
      if (detectedConstraints.hasWE)
        labels.push({ text: 'Word Equality', color: '#22d3ee' });
      if (detectedConstraints.hasPrefixWE)
        labels.push({ text: 'Prefix', color: '#a78bfa' });
      if (detectedConstraints.hasLength)
        labels.push({ text: 'Bounded Length', color: '#f59e0b' });
    }
    return labels;
  }, [detectedConstraints]);

  // Preset selector state
  const [showPresetPicker, setShowPresetPicker] = useState<'A' | 'B' | null>(null);

  // S-series presets only (not SO queries)
  const sPresets = useMemo(() => presets.filter(p => p.filename.startsWith('S')), [presets]);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* ── Hero header: two-column with query preview + metrics ── */}
      <div className={`shrink-0 border-b ${d ? 'bg-gray-800/80 border-gray-700/60' : 'bg-white border-gray-200'}`}>
        {/* Labels row */}
        <div className="flex items-stretch">
          {/* Plain side header */}
          <div className={`flex-1 px-4 py-2 flex items-center gap-2 border-r ${d ? 'border-gray-700/60' : 'border-gray-200'}`}>
            <span className={`text-sm uppercase tracking-wider font-bold ${d ? 'text-gray-400' : 'text-gray-600'}`}>Plain CRPQ</span>
            {resultA && (
              <span className={`text-xs font-mono ml-auto ${d ? 'text-gray-500' : 'text-gray-400'}`}>
                <span className={`font-bold ${d ? 'text-gray-300' : 'text-gray-600'}`}>{fmtCount(resultA.total_count)}</span>
                <span className="mx-1 opacity-40">·</span>
                {resultA.elapsed_ms < 0.1 ? '<0.001' : (resultA.elapsed_ms / 1000).toFixed(3)}s
              </span>
            )}
            {onRunForSlot && sPresets.length > 0 && (
              <div className="relative">
                <button
                  onClick={() => setShowPresetPicker(p => p === 'A' ? null : 'A')}
                  className={`text-[11px] px-2 py-0.5 rounded border transition-colors ${
                    d ? 'border-gray-600 text-gray-400 hover:text-gray-200 hover:border-gray-500'
                      : 'border-gray-300 text-gray-500 hover:text-gray-700 hover:border-gray-400'
                  }`}
                  title="Run a different preset for this slot"
                >
                  Change
                </button>
                {showPresetPicker === 'A' && (
                  <div className={`absolute top-full left-0 mt-1 z-50 w-56 max-h-64 overflow-y-auto rounded-lg border shadow-xl ${
                    d ? 'bg-gray-800 border-gray-600' : 'bg-white border-gray-200'
                  }`}>
                    {sPresets.map((p, i) => (
                      <button
                        key={i}
                        className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                          d ? 'hover:bg-gray-700 text-gray-300' : 'hover:bg-gray-50 text-gray-700'
                        }`}
                        onClick={() => { onRunForSlot('A', p.content); setShowPresetPicker(null); }}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          {/* Extended side header */}
          <div className="flex-1 px-4 py-2 flex items-center gap-2">
            <span className={`text-sm uppercase tracking-wider font-bold ${d ? 'text-cyan-400' : 'text-cyan-600'}`}>Extended CRPQs</span>
            {constraintLabels.map(({ text, color }) => (
              <span
                key={text}
                className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                style={{ backgroundColor: `${color}20`, color, border: `1px solid ${color}40` }}
              >{text}</span>
            ))}
            {resultB && (
              <span className={`text-xs font-mono ml-auto ${d ? 'text-gray-500' : 'text-gray-400'}`}>
                <span className={`font-bold ${d ? 'text-cyan-300' : 'text-cyan-600'}`}>{fmtCount(resultB.total_count)}</span>
                <span className="mx-1 opacity-40">·</span>
                {resultB.elapsed_ms < 0.1 ? '<0.001' : (resultB.elapsed_ms / 1000).toFixed(3)}s
              </span>
            )}
            {onRunForSlot && sPresets.length > 0 && (
              <div className="relative">
                <button
                  onClick={() => setShowPresetPicker(p => p === 'B' ? null : 'B')}
                  className={`text-[11px] px-2 py-0.5 rounded border transition-colors ${
                    d ? 'border-gray-600 text-gray-400 hover:text-gray-200 hover:border-gray-500'
                      : 'border-gray-300 text-gray-500 hover:text-gray-700 hover:border-gray-400'
                  }`}
                  title="Run a different preset for this slot"
                >
                  Change
                </button>
                {showPresetPicker === 'B' && (
                  <div className={`absolute top-full right-0 mt-1 z-50 w-56 max-h-64 overflow-y-auto rounded-lg border shadow-xl ${
                    d ? 'bg-gray-800 border-gray-600' : 'bg-white border-gray-200'
                  }`}>
                    {sPresets.map((p, i) => (
                      <button
                        key={i}
                        className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                          d ? 'hover:bg-gray-700 text-gray-300' : 'hover:bg-gray-50 text-gray-700'
                        }`}
                        onClick={() => { onRunForSlot('B', p.content); setShowPresetPicker(null); }}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        {/* Summary diff bar */}
        {resultA && resultB && (() => {
          const cntA = resultA.total_count, cntB = resultB.total_count;
          const msA = resultA.elapsed_ms, msB = resultB.elapsed_ms;
          const cntRatio = cntA > 0 && cntB > 0
            ? (cntA > cntB ? cntA / cntB : cntB / cntA)
            : 0;
          const cntText = cntA === cntB ? 'same count' : `${cntRatio >= 10 ? Math.round(cntRatio) : cntRatio.toFixed(1)}× ${cntB < cntA ? 'fewer' : 'more'}`;
          const msText = Math.abs(msB - msA) < 1 ? '≈ same time' : `${msB > msA ? '+' : ''}${((msB - msA) / 1000).toFixed(3)}s`;
          return (
            <div className={`px-4 py-1.5 border-t flex items-center gap-4 text-xs font-mono ${d ? 'border-gray-700/40 bg-gray-800/40' : 'border-gray-100 bg-gray-50/50'}`}>
              <span className={d ? 'text-gray-500' : 'text-gray-400'}>Extended vs Plain:</span>
              <span className={`font-bold ${cntB <= cntA ? (d ? 'text-emerald-400' : 'text-emerald-600') : (d ? 'text-amber-400' : 'text-amber-600')}`}>
                {cntText}
              </span>
              <span className={d ? 'text-gray-700' : 'text-gray-300'}>|</span>
              <span className={d ? 'text-gray-400' : 'text-gray-500'}>{msText}</span>
            </div>
          );
        })()}
      </div>


      {/* ── Inline graph preview ── */}
      <div className="shrink-0 relative" style={{ height: graphPanelH }}>
        <div className="flex h-full">
          {/* Plain graph */}
          <div className={`flex-1 min-w-0 border-r ${d ? 'border-gray-700/60' : 'border-gray-200'}`}>
            {loadingSlotA ? (
              <div className={`h-full flex flex-col items-center justify-center gap-2 ${d ? 'bg-gray-900' : 'bg-gray-50'}`}>
                <div className={`w-6 h-6 border-2 rounded-full animate-spin ${d ? 'border-gray-700 border-t-gray-300' : 'border-gray-200 border-t-gray-500'}`} />
                <span className={`text-[11px] ${d ? 'text-gray-600' : 'text-gray-400'}`}>Loading plain…</span>
              </div>
            ) : activeSampleResultA ? (
              <ForceGraph result={activeSampleResultA} soloPath={0} queryContext={queryContextB ?? queryContextA} schema={schema} isDark={d} datasetId={datasetId} />
            ) : (
              <div className={`h-full flex items-center justify-center ${d ? 'bg-gray-900' : 'bg-gray-50'}`}>
                <span className={`text-xs ${d ? 'text-gray-600' : 'text-gray-400'}`}>Click a path below to preview</span>
              </div>
            )}
          </div>
          {/* Extended graph */}
          <div className="flex-1 min-w-0">
            {loadingSlotB ? (
              <div className={`h-full flex flex-col items-center justify-center gap-2 ${d ? 'bg-gray-900' : 'bg-gray-50'}`}>
                <div className={`w-6 h-6 border-2 rounded-full animate-spin ${d ? 'border-cyan-900 border-t-cyan-400' : 'border-cyan-100 border-t-cyan-500'}`} />
                <span className={`text-[11px] ${d ? 'text-cyan-700' : 'text-cyan-500'}`}>Loading extended…</span>
              </div>
            ) : activeSampleResultB ? (
              <ForceGraph result={activeSampleResultB} soloPath={0} queryContext={queryContextB} schema={schema} isDark={d} datasetId={datasetId} />
            ) : (
              <div className={`h-full flex items-center justify-center ${d ? 'bg-gray-900' : 'bg-gray-50'}`}>
                <span className={`text-xs ${d ? 'text-gray-600' : 'text-gray-400'}`}>Click a path below to preview</span>
              </div>
            )}
          </div>
        </div>
        {/* Compare button — top-left corner, clear of the graph overlays */}
        {(activeSampleResultA || activeSampleResultB) && (
          <button
            onClick={() => setShowGraphModal(true)}
            className={`absolute top-2 left-2 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold shadow-sm backdrop-blur-sm transition-colors ${
              d ? 'bg-gray-900/80 hover:bg-gray-800 border-gray-700 text-gray-300 hover:text-white'
                : 'bg-white/90 hover:bg-gray-100 border-gray-300 text-gray-600 hover:text-gray-900'
            }`}
            title="Open side-by-side compare view"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="1.5" y="2.5" width="5.5" height="11" rx="1" />
              <rect x="9" y="2.5" width="5.5" height="11" rx="1" />
            </svg>
            Compare
          </button>
        )}
      </div>

      {/* Resize handle */}
      <div
        className={`shrink-0 h-1 cursor-row-resize group relative ${d ? 'border-b border-gray-700/80 hover:border-cyan-600/60' : 'border-b border-gray-200 hover:border-cyan-400/60'} transition-colors`}
        onMouseDown={handleGraphDragDown}
      >
        <div className="absolute inset-x-0 -top-1 -bottom-1 group-active:bg-cyan-500/30" />
      </div>

      {/* ── Two-column path lists ── */}
      <div className="flex-1 flex min-h-0">
        {/* Plain side */}
        <div className="flex-1 min-w-0 flex flex-col border-r" style={{ borderColor: d ? '#374151' : '#d1d5db' }}>
          <div className="flex-1 overflow-y-auto">
            {loadingSlotA ? (
              <div className="h-full flex flex-col items-center justify-center gap-3">
                <div className={`w-8 h-8 border-2 rounded-full animate-spin ${d ? 'border-gray-700 border-t-gray-300' : 'border-gray-200 border-t-gray-500'}`} />
                <span className={`text-xs ${d ? 'text-gray-500' : 'text-gray-400'}`}>Running plain query…</span>
              </div>
            ) : diffOnlyResult ? (
              <PathList
                result={diffOnlyResult}
                hoveredPath={hoveredA}
                soloPath={activeSampleA}
                onHoverPath={setHoveredA}
                onClickPath={handleClickA}
                // Extended context first: only it names P1/P2 and the linking
                // edge, which is what lets the plain column be laid out in the
                // same two rows as the extended one. The two graphs share
                // vertices and edge ids, so the bindings still line up.
                queryContext={queryContextB ?? queryContextA}
                schema={schema}
                isDark={d}
                annotations={diffOnlyAnnotations}
                showFullLabels
                showVertexIds={false}
                weRoleByEdgeId={weRolesForPlain}
                dotColor={d ? '#6b7280' : '#9ca3af'}
              />
            ) : null}
          </div>
        </div>

        {/* Extended side */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 overflow-y-auto">
            {loadingSlotB ? (
              <div className="h-full flex flex-col items-center justify-center gap-3">
                <div className={`w-8 h-8 border-2 rounded-full animate-spin ${d ? 'border-cyan-900 border-t-cyan-400' : 'border-cyan-100 border-t-cyan-500'}`} />
                <span className={`text-xs ${d ? 'text-cyan-600' : 'text-cyan-500'}`}>Running extended query…</span>
              </div>
            ) : resultB ? (
              <PathList
                result={resultB}
                hoveredPath={hoveredB}
                soloPath={activeSampleB}
                onHoverPath={setHoveredB}
                onClickPath={handleClickB}
                queryContext={queryContextB}
                schema={schema}
                isDark={d}
                showFullLabels
                showVertexIds={false}
                dotColor={d ? '#6b7280' : '#9ca3af'}
              />
            ) : null}
          </div>
        </div>
      </div>

      {/* ── Graph compare modal ── */}
      {showGraphModal && (activeSampleResultA || activeSampleResultB) && (
        <GraphCompareModal
          resultA={activeSampleResultA}
          resultB={activeSampleResultB}
          // The extended context first, exactly as the inline preview does: the
          // plain graph is the same query minus its constraints, and only the
          // extended context knows which chain is P1 and which is P2 — without
          // it the plain pane loses its legend.
          contextA={queryContextB ?? queryContextA}
          contextB={queryContextB}
          schema={schema}
          isDark={d}
          labelA={activeSampleA !== null ? `#${activeSampleA + 1} · Plain` : 'Plain CRPQ'}
          labelB={activeSampleB !== null ? `#${activeSampleB + 1} · Extended` : 'Extended CRPQ'}
          onClose={() => setShowGraphModal(false)}
          datasetId={datasetId}
        />
      )}
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════
   GraphCompareModal — full-screen overlay with side-by-side graphs
   ═══════════════════════════════════════════════════════════════════ */

interface GraphCompareModalProps {
  resultA: QueryResult | null;
  resultB: QueryResult | null;
  contextA: QueryGraph | null;
  contextB: QueryGraph | null;
  schema: Schema | null;
  isDark: boolean;
  labelA: string;
  labelB: string;
  onClose: () => void;
  /** Dataset the results came from — forwarded for graph-context lookups */
  datasetId?: string;
}

const GraphCompareModal: FC<GraphCompareModalProps> = ({
  resultA, resultB, contextA, contextB, schema, isDark: d, labelA, labelB, onClose, datasetId,
}) => {
  // Close on ESC
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const placeholder = (
    <div className="h-full flex items-center justify-center">
      <span className={`text-sm ${d ? 'text-gray-600' : 'text-gray-400'}`}>No sample selected</span>
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.65)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className={`flex flex-col rounded-2xl border shadow-2xl overflow-hidden ${
          d ? 'bg-gray-900 border-gray-700/80' : 'bg-white border-gray-200'
        }`}
        style={{ width: '90vw', height: '80vh', maxWidth: 1400 }}
      >
        {/* Header */}
        <div className={`shrink-0 flex items-center justify-between px-5 border-b ${
          d ? 'border-gray-700/60' : 'border-gray-200'
        }`} style={{ height: 40 }}>
          <div className="flex items-center gap-6">
            <span className={`text-[12px] font-semibold uppercase tracking-wider ${d ? 'text-gray-400' : 'text-gray-600'}`}>
              {labelA}
            </span>
            <span className={`text-[11px] ${d ? 'text-gray-600' : 'text-gray-400'}`}>|</span>
            <span className={`text-[12px] font-semibold uppercase tracking-wider ${d ? 'text-cyan-400/80' : 'text-cyan-600'}`}>
              {labelB}
            </span>
          </div>
          <button
            onClick={onClose}
            className={`w-7 h-7 flex items-center justify-center rounded-lg transition-colors ${
              d ? 'text-gray-500 hover:text-gray-200 hover:bg-gray-700/60' : 'text-gray-400 hover:text-gray-700 hover:bg-gray-100'
            }`}
            title="Close (Esc)"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8"/>
            </svg>
          </button>
        </div>

        {/* Body: two graphs side by side */}
        <div className="flex-1 flex min-h-0">
          {/* Plain graph */}
          <div className={`flex-1 min-w-0 border-r ${d ? 'border-gray-700/60' : 'border-gray-200'}`}>
            {resultA ? (
              <ForceGraph result={resultA} soloPath={0} queryContext={contextA} schema={schema} isDark={d} datasetId={datasetId} />
            ) : placeholder}
          </div>
          {/* Extended graph */}
          <div className="flex-1 min-w-0">
            {resultB ? (
              <ForceGraph result={resultB} soloPath={0} queryContext={contextB} schema={schema} isDark={d} datasetId={datasetId} />
            ) : placeholder}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ResultPanel;
