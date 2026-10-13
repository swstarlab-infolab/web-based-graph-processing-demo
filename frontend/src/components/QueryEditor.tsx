import { useState, useCallback, useRef, type FC, type RefObject } from 'react';
import type { QueryVertex, QueryEdge, WEConstraint, Schema } from '../types';
import QueryCanvas from './QueryCanvas/QueryCanvas';
import ConstraintBar from './ConstraintBar';
import { buildQueryJSON } from '../utils/queryBuilder';

type EditorMode = 'visual' | 'json';

interface DescriptionInfo {
  id: string;
  title: string;
  shortDesc: string;
  fullDesc: string;
  queryType: string;
}

interface QueryEditorProps {
  vertices: QueryVertex[];
  edges: QueryEdge[];
  weConstraints: WEConstraint[];
  schema: Schema;
  onAddVertex: (label: string, pos: { x: number; y: number }) => string;
  onUpdateVertex: (id: string, label: string) => void;
  onAddEdge: (src: string, tgt: string) => string;
  onUpdateEdge: (id: string, props: Partial<Omit<QueryEdge, 'id'>>) => void;
  onRemoveElement: (id: string) => void;
  onMoveVertex: (id: string, position: { x: number; y: number }) => void;
  onRemoveConstraint: (edge1Id: string, edge2Id: string) => void;
  onAddConstraint: (edge1Id: string, edge2Id: string, type?: 'prefix') => void;
  onFitRef: RefObject<(() => void) | null>;
  onLoadPreset: (content: Record<string, unknown>) => void;
  onJSONOverride: (json: Record<string, unknown> | null) => void;
  layoutKey?: number;
  isDark?: boolean;
  description?: DescriptionInfo;
  onRun?: () => void;
  onNew?: () => void;
  isLoading?: boolean;
}

const TEMPLATES: Array<{ label: string; tag: string; tagColor: string; json: Record<string, unknown> }> = [
  {
    label: 'RPQ 1-hop',
    tag: 'RPQ',
    tagColor: '#3182F6',
    json: {
      query_vertices: ['v1:Any', 'v2:Any'],
      query_edges: ['(v1)-[P1]->(v2)'],
      automata: {
        P1: {
          regular_expression: 'KNOWS',
          alphabets: ['KNOWS'],
          initial_states: [{ name: 'q0' }],
          final_states: [{ name: 'q1' }],
          states: [{ name: 'q0' }, { name: 'q1' }],
          transitions: [{ from: 'q0', symbol: 'KNOWS-', to: 'q1' }],
          min_length: 1,
          max_length: null,
          source_constraint: null,
        },
      },
    },
  },
  {
    label: 'RPQ Kleene*',
    tag: 'RPQ',
    tagColor: '#3182F6',
    json: {
      query_vertices: ['v1:Any', 'v2:Any'],
      query_edges: ['(v1)-[P1]->(v2)'],
      automata: {
        P1: {
          regular_expression: 'KNOWS*',
          alphabets: ['KNOWS'],
          initial_states: [{ name: 'q0' }],
          final_states: [{ name: 'q0' }],
          states: [{ name: 'q0' }],
          transitions: [{ from: 'q0', symbol: 'KNOWS-', to: 'q0' }],
          min_length: 0,
          max_length: null,
          source_constraint: null,
        },
      },
    },
  },
];

/** Constraint snippet definitions (merged into current JSON, not replacing it) */
const SNIPPET_DEFS = [
  { label: 'Word Eq', tag: 'WE', tagColor: '#8A55FF', kind: 'we'        as const },
  { label: 'Prefix',  tag: 'WE', tagColor: '#2dd4bf', kind: 'prefix_we' as const },
  { label: 'Length',  tag: 'LC', tagColor: '#f59e0b', kind: 'length'    as const },
];

const FALLBACK_AUTOMATA_ENTRY = {
  regular_expression: 'KNOWS',
  alphabets: ['KNOWS'],
  initial_states: [{ name: 'q0' }],
  final_states: [{ name: 'q1' }],
  states: [{ name: 'q0' }, { name: 'q1' }],
  transitions: [{ from: 'q0', symbol: 'KNOWS-', to: 'q1' }],
  min_length: 1,
  max_length: null,
  source_constraint: null,
};

function mergeConstraintSnippet(
  current: string,
  kind: 'length' | 'we' | 'prefix_we',
): { json: Record<string, unknown>; isDuplicate: boolean } {
  let base: Record<string, unknown> = {};
  try { base = JSON.parse(current); } catch { /* start fresh */ }

  if (kind === 'length') {
    const automata = { ...(base.automata as Record<string, unknown> ?? {}) };
    const keys = Object.keys(automata);
    if (keys.length === 0) {
      automata['P1'] = { ...FALLBACK_AUTOMATA_ENTRY, min_length: null, max_length: null };
      if (!base.query_vertices) base.query_vertices = ['v1:Any', 'v2:Any'];
      if (!base.query_edges)    base.query_edges    = ['(v1)-[P1]->(v2)'];
    } else {
      const firstKey = keys[0];
      const existing = automata[firstKey] as Record<string, unknown> | undefined;
      if (existing && existing.min_length != null && existing.max_length != null) {
        return { json: base, isDuplicate: true };
      }
      automata[firstKey] = { ...existing, min_length: null, max_length: null };
    }
    return { json: { ...base, automata }, isDuplicate: false };
  }

  // WE / Prefix / Suffix: ensure two automata exist, then add constraint
  const automata = { ...(base.automata as Record<string, unknown> ?? {}) };
  const keys = Object.keys(automata);
  if (keys.length === 0) {
    automata['P1'] = { ...FALLBACK_AUTOMATA_ENTRY };
    automata['P2'] = { ...FALLBACK_AUTOMATA_ENTRY };
    if (!base.query_vertices) base.query_vertices = ['v1:Any', 'v2:Any', 'v3:Any', 'v4:Any'];
    if (!base.query_edges)    base.query_edges    = ['(v1)-[P1]->(v2)', '(v3)-[P2]->(v4)'];
  }
  const finalKeys = Object.keys(automata);
  const p1 = finalKeys[0] ?? 'P1';
  const p2 = finalKeys[1] ?? finalKeys[0] ?? 'P2';
  const existing = (base.word_equality_constraints as Record<string, string>[]) ?? [];
  const entry: Record<string, string> = { path1: p1, path2: p2, source_constraint: 'same' };
  if (kind === 'prefix_we') entry.type = 'prefix';

  const dup = existing.some(
    (c) => c.path1 === entry.path1 && c.path2 === entry.path2
        && (c.type ?? undefined) === (entry.type ?? undefined),
  );
  if (dup) return { json: base, isDuplicate: true };

  return { json: { ...base, automata, word_equality_constraints: [...existing, entry] }, isDuplicate: false };
}

const FIELD_DOCS = [
  { field: 'min_length / max_length', desc: 'Hop bounds (null = unlimited)', color: '#3182F6' },
  { field: 'source_constraint', desc: 'Fix start vertex ID (int | null)', color: '#3182F6' },
  { field: '"LABEL-"', desc: 'APPEND — forward traversal', color: '#00CC88' },
  { field: '"-LABEL"', desc: 'PREPEND — backward traversal', color: '#00CC88' },
  { field: 'type: "prefix"', desc: 'Prefix constraint', color: '#8A55FF' },
  { field: 'source_constraint: "same"', desc: 'Force same WE source vertex', color: '#8A55FF' },
];

const QueryEditor: FC<QueryEditorProps> = ({
  vertices,
  edges,
  weConstraints,
  schema,
  onAddVertex,
  onUpdateVertex,
  onAddEdge,
  onUpdateEdge,
  onRemoveElement,
  onMoveVertex,
  onRemoveConstraint,
  onAddConstraint,
  onFitRef,
  onLoadPreset,
  onJSONOverride,
  layoutKey,
  isDark = true,
  description,
  onRun,
  onNew,
  isLoading = false,
}) => {
  const [mode, setMode] = useState<EditorMode>('visual');
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [snippetWarning, setSnippetWarning] = useState<string | null>(null);
  const [descExpanded, setDescExpanded] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const snapshotJSON = useCallback((): string => {
    if (vertices.length === 0) return JSON.stringify(TEMPLATES[0].json, null, 2);
    const graph = { vertices, edges, weConstraints };
    return JSON.stringify(buildQueryJSON(graph), null, 2);
  }, [vertices, edges, weConstraints]);

  const handleSwitchToJSON = useCallback(() => {
    const text = snapshotJSON();
    setJsonText(text);
    setJsonError(null);
    try { onJSONOverride(JSON.parse(text)); } catch { /* noop */ }
    setMode('json');
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, [snapshotJSON, onJSONOverride]);

  const handleSwitchToVisual = useCallback(() => {
    try {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      onLoadPreset(parsed);
      onJSONOverride(null);
      setJsonError(null);
      setMode('visual');
    } catch {
      setJsonError('JSON parse failed — fix errors first');
    }
  }, [jsonText, onLoadPreset, onJSONOverride]);

  const handleJSONChange = useCallback((value: string) => {
    setJsonText(value);
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      onJSONOverride(parsed);
      setJsonError(null);
    } catch {
      setJsonError('Invalid JSON');
      onJSONOverride(null);
    }
  }, [onJSONOverride]);

  const handleFormat = useCallback(() => {
    try {
      setJsonText(JSON.stringify(JSON.parse(jsonText), null, 2));
      setJsonError(null);
    } catch {
      setJsonError('Cannot format — fix JSON errors first');
    }
  }, [jsonText]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(jsonText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [jsonText]);

  const handleReset = useCallback(() => {
    const text = snapshotJSON();
    setJsonText(text);
    try { onJSONOverride(JSON.parse(text)); setJsonError(null); } catch { /* noop */ }
  }, [snapshotJSON, onJSONOverride]);

  const handleSnippet = useCallback((kind: 'length' | 'we' | 'prefix_we') => {
    setSnippetWarning(null);
    const { json: merged, isDuplicate } = mergeConstraintSnippet(jsonText, kind);
    if (isDuplicate) {
      setSnippetWarning('Already exists');
      setTimeout(() => setSnippetWarning(null), 2000);
      return;
    }
    const text = JSON.stringify(merged, null, 2);
    setJsonText(text);
    try { onJSONOverride(JSON.parse(text)); setJsonError(null); } catch { /* noop */ }

    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      let selStart = -1;
      let selEnd = -1;
      if (kind === 'length') {
        // Select from "min_length" to end of "max_length": null line
        const idx = text.lastIndexOf('"min_length"');
        if (idx >= 0) {
          selStart = idx;
          const maxIdx = text.indexOf('"max_length"', idx);
          selEnd = maxIdx >= 0 ? text.indexOf('\n', maxIdx + 1) : text.indexOf('\n', idx + 1);
          if (selEnd < 0) selEnd = selStart + 30;
        }
      } else {
        // Select the entire WE constraint object { "path1": ..., "path2": ..., ... }
        const idx = text.lastIndexOf('"path1"');
        if (idx >= 0) {
          // Find enclosing { ... }
          const braceStart = text.lastIndexOf('{', idx);
          const braceEnd = text.indexOf('}', idx);
          if (braceStart >= 0 && braceEnd >= 0) {
            selStart = braceStart;
            selEnd = braceEnd + 1;
          } else {
            selStart = idx;
            selEnd = text.indexOf('\n', idx + 1);
          }
        }
      }
      if (selStart >= 0 && selEnd > selStart) {
        // Scroll to center the selection in the textarea
        const linesBefore = text.substring(0, selStart).split('\n').length;
        const lineHeight = 26; // approximate line height at 15px font
        const visibleLines = Math.floor(ta.clientHeight / lineHeight);
        ta.scrollTop = Math.max(0, (linesBefore - Math.floor(visibleLines / 2)) * lineHeight);
        ta.setSelectionRange(selStart, selEnd);
      }
    });
  }, [jsonText, onJSONOverride]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F') {
      e.preventDefault();
      handleFormat();
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const newVal = ta.value.substring(0, start) + '  ' + ta.value.substring(end);
      handleJSONChange(newVal);
      requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = start + 2; });
    }
  }, [handleFormat, handleJSONChange]);

  const cssVars = isDark ? {
    '--bg-base':    '#0b1120',
    '--bg-surface': '#0f1729',
    '--bg-card':    '#162032',
    '--bg-deep':    '#080f1a',
    '--border':     'rgba(30,45,66,0.9)',
    '--border-md':  'rgba(50,75,110,0.9)',
    '--text-1':     '#e2e8f0',
    '--text-2':     '#8b9fc0',
    '--text-3':     '#5b7095',
    '--text-4':     '#334155',
    '--blue':       '#0891b2',
  } : {
    '--bg-base':    '#f8fafc',
    '--bg-surface': '#f1f5f9',
    '--bg-card':    '#e8eef5',
    '--bg-deep':    '#f0f4f8',
    '--border':     'rgba(203,213,225,0.8)',
    '--border-md':  'rgba(148,163,184,0.8)',
    '--text-1':     '#0f172a',
    '--text-2':     '#334155',
    '--text-3':     '#64748b',
    '--text-4':     '#94a3b8',
    '--blue':       '#0891b2',
  };

  return (
    <div
      className="flex flex-col w-full h-full relative"
      style={{ background: 'var(--bg-base)', ...cssVars } as React.CSSProperties}
    >
      {/* ══════════════════════════════════════════════════════
          Unified Top Action Bar
          [Visual|JSON] · [JSON tools] · ──────── · [New] [Run]
          ══════════════════════════════════════════════════════ */}
      <div
        className="shrink-0 flex items-center gap-2 px-3"
        style={{
          height: 44,
          background: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        {/* ── Mode toggle ── */}
        <div
          className="flex items-center gap-0.5 p-0.5 rounded-lg shrink-0"
          style={{ background: 'var(--bg-card)' }}
        >
          <button
            className="px-3 py-1 text-sm font-semibold rounded-md transition-all duration-150"
            style={
              mode === 'visual'
                ? { background: 'var(--blue)', color: '#fff', boxShadow: '0 1px 6px rgba(8,145,178,0.4)' }
                : { background: 'transparent', color: 'var(--text-3)' }
            }
            onClick={mode === 'json' ? handleSwitchToVisual : undefined}
          >
            Visual
          </button>
          <button
            className="px-3 py-1 text-sm font-semibold rounded-md transition-all duration-150"
            style={
              mode === 'json'
                ? { background: 'var(--blue)', color: '#fff', boxShadow: '0 1px 6px rgba(8,145,178,0.4)' }
                : { background: 'transparent', color: 'var(--text-3)' }
            }
            onClick={mode === 'visual' ? handleSwitchToJSON : undefined}
          >
            JSON
          </button>
        </div>

        {/* ── JSON-mode tools ── */}
        {mode === 'json' && (
          <>
            <div className="w-px h-4 shrink-0" style={{ background: 'var(--border-md)' }} />
            {SNIPPET_DEFS.map((sn) => (
              <button
                key={sn.label}
                className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-lg text-[12px] font-semibold transition-all active:scale-95"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-3)' }}
                onMouseEnter={(e) => {
                  const btn = e.currentTarget as HTMLButtonElement;
                  btn.style.color = sn.tagColor;
                  btn.style.background = `${sn.tagColor}18`;
                  btn.style.borderColor = `${sn.tagColor}40`;
                  btn.style.boxShadow = `0 1px 8px ${sn.tagColor}30`;
                }}
                onMouseLeave={(e) => {
                  const btn = e.currentTarget as HTMLButtonElement;
                  btn.style.color = 'var(--text-3)';
                  btn.style.background = 'var(--bg-card)';
                  btn.style.borderColor = 'var(--border)';
                  btn.style.boxShadow = 'none';
                }}
                onMouseDown={(e) => {
                  const btn = e.currentTarget as HTMLButtonElement;
                  btn.style.background = `${sn.tagColor}30`;
                  btn.style.borderColor = sn.tagColor;
                  btn.style.boxShadow = `0 0 12px ${sn.tagColor}50`;
                }}
                onMouseUp={(e) => {
                  const btn = e.currentTarget as HTMLButtonElement;
                  btn.style.background = `${sn.tagColor}18`;
                  btn.style.borderColor = `${sn.tagColor}40`;
                  btn.style.boxShadow = `0 1px 8px ${sn.tagColor}30`;
                }}
                onClick={() => handleSnippet(sn.kind)}
                title={`Add ${sn.label} constraint to JSON`}
              >
                <span className="text-[10px] font-bold px-1 py-0.5 rounded" style={{ background: `${sn.tagColor}20`, color: sn.tagColor }}>{sn.tag}</span>
                {sn.label}
              </button>
            ))}
            <div className="w-px h-4 shrink-0" style={{ background: 'var(--border-md)' }} />
            {jsonError ? (
              <span className="text-[11px] font-medium px-2 py-0.5 rounded-md shrink-0 truncate max-w-[140px]"
                style={{ color: '#FF4D4F', background: 'rgba(255,77,79,0.1)', border: '1px solid rgba(255,77,79,0.2)' }} title={jsonError}>
                ✕ {jsonError}
              </span>
            ) : (
              <span className="text-[11px] font-semibold flex items-center gap-1 px-2 py-0.5 rounded-md shrink-0"
                style={{ color: '#00CC88', background: 'rgba(0,204,136,0.1)' }}>
                <span className="w-1.5 h-1.5 rounded-full bg-current inline-block" />
                Valid
              </span>
            )}
            {[
              { label: copied ? '✓ Copied' : 'Copy', title: 'Copy JSON', action: handleCopy },
              { label: 'Format', title: 'Format JSON (Ctrl+Shift+F)', action: handleFormat },
              { label: 'Reset',  title: 'Reset to visual state',       action: handleReset },
            ].map(({ label, title, action }) => (
              <button key={label}
                className="px-2.5 py-1 text-[11px] font-semibold rounded-lg transition-all shrink-0"
                style={{ background: 'var(--bg-card)', color: 'var(--text-3)', border: '1px solid var(--border)' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-1)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border-md)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-3)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; }}
                onClick={action} title={title}
              >{label}</button>
            ))}
            {snippetWarning && (
              <span className="text-[11px] font-medium px-2 py-0.5 rounded-md shrink-0 animate-pulse"
                style={{ color: '#f59e0b', background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.25)' }}>
                {snippetWarning}
              </span>
            )}
          </>
        )}

        {/* ── Spacer ── */}
        <div className="flex-1" />

        {/* ── New Query ── */}
        {onNew && (
          <button onClick={onNew}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold border transition-all shrink-0"
            style={{ background: 'var(--bg-card)', color: 'var(--text-3)', border: '1px solid var(--border)' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-1)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border-md)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-3)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; }}
            title="Clear canvas and start a new blank query"
          >
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M6 1v10M1 6h10"/></svg>
            New
          </button>
        )}

        {/* ── Run Query ── */}
        {onRun && (
          <button
            className="flex items-center gap-2 px-5 py-1.5 text-sm font-semibold rounded-lg transition-all shrink-0"
            style={isLoading
              ? { background: 'var(--bg-card)', color: 'var(--text-3)', cursor: 'not-allowed', border: '1px solid var(--border)' }
              : { background: '#0891b2', color: '#fff', boxShadow: '0 2px 10px rgba(8,145,178,0.3)' }}
            onClick={onRun} disabled={isLoading}
          >
            {isLoading ? (
              <><div className="w-3.5 h-3.5 border-2 rounded-full animate-spin shrink-0" style={{ borderColor: 'var(--border-md)', borderTopColor: 'var(--text-2)' }} />Running…</>
            ) : (
              <><svg width="9" height="10" viewBox="0 0 10 12" fill="currentColor"><path d="M1 1l8 5-8 5V1z"/></svg>Run Query</>
            )}
          </button>
        )}
      </div>

      {/* ── Content area ── */}
      {mode === 'visual' ? (
        <div className="flex flex-col flex-1 min-h-0">
          <ConstraintBar
            constraints={weConstraints}
            edges={edges}
            onRemoveConstraint={onRemoveConstraint}
            onAddConstraint={onAddConstraint}
            onUpdateEdge={(id, props) => onUpdateEdge(id, props)}
            isDark={isDark}
          />
          <div className="flex-1 min-h-0 relative">
            {/* Description — floating overlay badge on canvas */}
            {description && (
              <div
                className="absolute bottom-3 left-3 z-10 rounded-xl select-none"
                style={{
                  background: isDark ? 'rgba(11,17,32,0.92)' : 'rgba(255,255,255,0.92)',
                  backdropFilter: 'blur(10px)',
                  border: `1px solid ${isDark ? 'rgba(30,45,66,0.8)' : 'rgba(203,213,225,0.7)'}`,
                  boxShadow: isDark ? '0 4px 16px rgba(0,0,0,0.35)' : '0 4px 16px rgba(0,0,0,0.08)',
                  maxWidth: descExpanded ? 440 : undefined,
                }}
              >
                <div
                  className="flex items-center gap-2 px-3 py-2 cursor-pointer"
                  onClick={() => setDescExpanded(v => !v)}
                >
                  <span
                    className="text-[11px] font-bold px-1.5 py-0.5 rounded-md shrink-0"
                    style={{
                      background: isDark ? 'rgba(6,182,212,0.15)' : 'rgba(6,182,212,0.1)',
                      color: isDark ? '#22d3ee' : '#0891b2',
                    }}
                  >
                    {description.id}
                  </span>
                  <span
                    className="text-[10px] font-semibold uppercase tracking-widest shrink-0"
                    style={{ color: isDark ? '#5b7095' : '#94a3b8' }}
                  >
                    {description.queryType}
                  </span>
                  {!descExpanded && (
                    <span className="text-[12px] font-medium truncate" style={{ color: isDark ? '#8b9fc0' : '#64748b' }}>
                      {description.title}
                    </span>
                  )}
                  <svg
                    width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
                    className={`shrink-0 ml-auto transition-transform ${descExpanded ? '' : 'rotate-180'}`}
                    style={{ color: isDark ? '#334155' : '#94a3b8' }}
                  >
                    <path d="M4 6l4 4 4-4"/>
                  </svg>
                </div>
                {descExpanded && (
                  <div className="px-3 pb-2.5 pointer-events-none">
                    <div className="text-[13px] font-semibold leading-snug" style={{ color: isDark ? '#cbd5e1' : '#1e293b' }}>
                      {description.title}
                    </div>
                    {description.fullDesc && (
                      <div className="text-[11px] leading-relaxed mt-1" style={{ color: isDark ? '#5b7095' : '#94a3b8' }}>
                        {description.fullDesc}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            <QueryCanvas
              vertices={vertices}
              edges={edges}
              weConstraints={weConstraints}
              schema={schema}
              onAddVertex={onAddVertex}
              onUpdateVertex={onUpdateVertex}
              onAddEdge={onAddEdge}
              onUpdateEdge={onUpdateEdge}
              onRemoveElement={onRemoveElement}
              onMoveVertex={onMoveVertex}
              onFitRef={onFitRef}
              layoutKey={layoutKey}
              isDark={isDark}
            />
          </div>
        </div>
      ) : (
        <div className="flex flex-col flex-1 min-h-0" style={{ background: 'var(--bg-deep)' }}>
          {/* JSON textarea */}
          <textarea
            ref={textareaRef}
            className="flex-1 w-full resize-none outline-none px-5 py-4"
            style={{
              background: 'transparent',
              color: 'var(--text-2)',
              caretColor: 'var(--blue)',
              border: 'none',
              fontFamily: '"SF Mono", "JetBrains Mono", "Fira Code", "Consolas", ui-monospace, monospace',
              fontSize: '15px',
              lineHeight: '1.7',
              tabSize: 2,
              letterSpacing: '0.01em',
              ...(jsonError ? { background: 'rgba(255,77,79,0.02)' } : {}),
            }}
            value={jsonText}
            onChange={(e) => handleJSONChange(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
            placeholder={`{\n  "query_vertices": ["v1:Any", "v2:Any"],\n  "query_edges": ["(v1)-[P1]->(v2)"],\n  "automata": { ... }\n}`}
          />

          {/* Field reference */}
          <div
            className="shrink-0 px-4 py-2.5"
            style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-surface)' }}
          >
            <p className="text-[10px] font-semibold uppercase tracking-widest mb-1.5" style={{ color: 'var(--text-4)' }}>
              Field Reference
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-0.5">
              {FIELD_DOCS.map(({ field, desc, color }) => (
                <div key={field} className="flex items-baseline gap-1.5">
                  <code
                    className="text-[11px] font-semibold"
                    style={{ color, fontFamily: '"SF Mono", "JetBrains Mono", ui-monospace, monospace' }}
                  >
                    {field}
                  </code>
                  <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>{desc}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

    </div>
  );
};

export default QueryEditor;
