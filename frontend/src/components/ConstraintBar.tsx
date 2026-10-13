import { useState, useRef, type FC } from 'react';
import type { WEConstraint, QueryEdge } from '../types';

interface ConstraintBarProps {
  constraints: WEConstraint[];
  edges: QueryEdge[];
  onRemoveConstraint: (edge1Id: string, edge2Id: string) => void;
  onAddConstraint: (edge1Id: string, edge2Id: string, type?: 'prefix') => void;
  onUpdateEdge?: (id: string, props: { minLength?: number; maxLength?: number }) => void;
  isDark?: boolean;
}

const WE_COLOR  = '#818cf8'; // indigo
const PRE_COLOR = '#34d399'; // emerald
const LEN_COLOR = '#fb923c'; // orange

const TYPES = {
  we:     { label: 'Word Equality',  color: WE_COLOR,  gradient: 'linear-gradient(135deg,#6366f1,#4f46e5,#3730a3)', hasItemsGradient: 'linear-gradient(135deg,#818cf8,#6366f1,#4f46e5)', notation: 'P₁=P₂',  symbol: '=' as const },
  prefix: { label: 'Prefix',         color: PRE_COLOR, gradient: 'linear-gradient(135deg,#10b981,#059669,#047857)', hasItemsGradient: 'linear-gradient(135deg,#34d399,#10b981,#059669)', notation: 'P₁⊆P₂', symbol: '⊆' as const },
  length: { label: 'Bounded Length', color: LEN_COLOR, gradient: 'linear-gradient(135deg,#f97316,#ea580c,#c2410c)', hasItemsGradient: 'linear-gradient(135deg,#fb923c,#f97316,#ea580c)', notation: '[n..m]',  symbol: null },
} as const;

type ConstraintType = keyof typeof TYPES;

const ConstraintBar: FC<ConstraintBarProps> = ({
  constraints, edges, onRemoveConstraint, onAddConstraint, onUpdateEdge, isDark = true,
}) => {
  const d = isDark;

  const [addType, setAddType]       = useState<ConstraintType | null>(null);
  const [addE1, setAddE1]           = useState('');
  const [addE2, setAddE2]           = useState('');
  const [dupWarning, setDupWarning] = useState(false);
  const [lenEdgeId, setLenEdgeId]   = useState('');
  const [lenMin, setLenMin]         = useState('');
  const [lenMax, setLenMax]         = useState('');
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const firstSelectRef              = useRef<HTMLSelectElement>(null);

  const getEdge      = (id: string) => edges.find((e) => e.id === id);
  const isDuplicate  = (e1: string, e2: string) =>
    constraints.some((c) => (c.edge1Id === e1 && c.edge2Id === e2) || (c.edge1Id === e2 && c.edge2Id === e1));

  const weConstraints     = constraints.filter((c) => !c.type || (c.type as string) === 'we');
  const prefixConstraints = constraints.filter((c) => c.type === 'prefix');
  const edgesWithLength   = edges.filter((e) => e.minLength != null || e.maxLength != null);

  const getCount = (t: ConstraintType) =>
    t === 'length' ? edgesWithLength.length : t === 'we' ? weConstraints.length : prefixConstraints.length;

  const isDisabled = (t: ConstraintType) => (t === 'length' ? edges.length < 1 : edges.length < 2);

  const openForm = (type: ConstraintType) => {
    if (addType === type && editingIdx === null) { closeForm(); return; }
    setAddType(type);
    setAddE1(''); setAddE2(''); setDupWarning(false);
    setLenEdgeId(edges[0]?.id ?? '');
    setLenMin(''); setLenMax('');
    setEditingIdx(null);
    setTimeout(() => firstSelectRef.current?.focus(), 40);
  };

  const closeForm = () => {
    setAddType(null); setAddE1(''); setAddE2(''); setDupWarning(false); setEditingIdx(null);
  };

  const handleAdd = () => {
    if (!addE1 || !addE2 || addE1 === addE2) return;
    if (editingIdx !== null) {
      const old = constraints[editingIdx];
      const others = constraints.filter((_, i) => i !== editingIdx);
      if (others.some((c) => (c.edge1Id === addE1 && c.edge2Id === addE2) || (c.edge1Id === addE2 && c.edge2Id === addE1))) {
        setDupWarning(true); return;
      }
      onRemoveConstraint(old.edge1Id, old.edge2Id);
      onAddConstraint(addE1, addE2, addType === 'prefix' ? 'prefix' : undefined);
    } else {
      if (isDuplicate(addE1, addE2)) { setDupWarning(true); return; }
      onAddConstraint(addE1, addE2, addType === 'prefix' ? 'prefix' : undefined);
    }
    setAddE1(''); setAddE2(''); setDupWarning(false); setEditingIdx(null);
    setTimeout(() => firstSelectRef.current?.focus(), 40);
  };

  const handleApplyLength = () => {
    if (!lenEdgeId || !onUpdateEdge) return;
    const min = lenMin !== '' ? parseInt(lenMin, 10) : undefined;
    const max = lenMax !== '' ? parseInt(lenMax, 10) : undefined;
    if (min == null && max == null) return;
    onUpdateEdge(lenEdgeId, { minLength: min, maxLength: max });
    setLenMin(''); setLenMax('');
  };

  const handleEditConstraint = (idx: number) => {
    const c = constraints[idx];
    setEditingIdx(idx);
    setAddType(c.type === 'prefix' ? 'prefix' : 'we');
    setAddE1(c.edge1Id); setAddE2(c.edge2Id); setDupWarning(false);
    setTimeout(() => firstSelectRef.current?.focus(), 40);
  };

  if (edges.length === 0 && constraints.length === 0) return null;

  /** Short summary text shown inside the pill when constraints exist */
  const getPillSummary = (type: ConstraintType): string | null => {
    if (type === 'length') {
      if (edgesWithLength.length === 0) return null;
      if (edgesWithLength.length === 1) {
        const e = edgesWithLength[0];
        const q = e.quantifier === '1' ? '' : e.quantifier;
        return `${e.label}${q}[${e.minLength ?? 0}..${e.maxLength ?? '∞'}]`;
      }
      return `×${edgesWithLength.length}`;
    }
    const items = type === 'we' ? weConstraints : prefixConstraints;
    if (items.length === 0) return null;
    if (items.length === 1) {
      const cfg = TYPES[type];
      const e1 = getEdge(items[0].edge1Id);
      const e2 = getEdge(items[0].edge2Id);
      return `${e1?.automataName ?? '?'} ${cfg.symbol} ${e2?.automataName ?? '?'}`;
    }
    return `×${items.length}`;
  };

  const selCls = `text-[13px] px-2 py-0.5 rounded-md border focus:outline-none cursor-pointer ${
    d ? 'bg-gray-900/80 border-gray-700 text-gray-300 hover:border-gray-500'
      : 'bg-white border-gray-300 text-gray-700 hover:border-gray-400'
  }`;
  const numCls = `text-[13px] px-2 py-0.5 rounded-md border focus:outline-none w-12 text-center ${
    d ? 'bg-gray-900/80 border-gray-700 text-amber-300 focus:border-amber-500'
      : 'bg-white border-gray-300 text-amber-700 focus:border-amber-400'
  }`;

  // ── Panel: constraint list + form ──────────────────────────────────────────
  const renderPanel = () => {
    if (addType === null) return null;
    const cfg        = TYPES[addType];
    const panelItems = addType === 'we' ? weConstraints : addType === 'prefix' ? prefixConstraints : [];
    const panelEdges = addType === 'length' ? edgesWithLength : [];
    const hasExisting = addType === 'length' ? panelEdges.length > 0 : panelItems.length > 0;

    return (
      <div
        style={{
          borderTop: `1px solid ${d ? 'rgba(30,45,66,0.7)' : 'rgba(226,232,240,1)'}`,
          background: d ? 'rgba(7,11,22,0.5)' : 'rgba(241,245,249,1)',
        }}
      >
        {/* Existing constraint rows */}
        {hasExisting && (
          <div className="px-3 pt-2 flex flex-col gap-1.5">
            {addType === 'length'
              ? panelEdges.map((e) => (
                  <div key={e.id} className="group flex items-center gap-1">
                    <span className="text-base font-bold" style={{ color: LEN_COLOR }}>{e.label}{e.quantifier === '1' ? '' : e.quantifier}</span>
                    <span className="text-sm font-mono opacity-50" style={{ color: LEN_COLOR }}>[</span>
                    <span className="text-base font-bold font-mono" style={{ color: d ? '#fcd34d' : '#92400e' }}>{e.minLength ?? 0}</span>
                    <span className="text-[13px] font-mono opacity-50" style={{ color: LEN_COLOR }}>..</span>
                    <span className="text-base font-bold font-mono" style={{ color: d ? '#fcd34d' : '#92400e' }}>{e.maxLength ?? '∞'}</span>
                    <span className="text-sm font-mono opacity-50" style={{ color: LEN_COLOR }}>]</span>
                    {onUpdateEdge && (
                      <button
                        className="ml-1 opacity-0 group-hover:opacity-70 transition-opacity text-[11px] leading-none"
                        style={{ color: '#f87171' }}
                        onClick={() => onUpdateEdge(e.id, { minLength: undefined, maxLength: undefined })}
                      >✕</button>
                    )}
                  </div>
                ))
              : panelItems.map((wec) => {
                  const e1     = getEdge(wec.edge1Id);
                  const e2     = getEdge(wec.edge2Id);
                  const allIdx = constraints.indexOf(wec);
                  if (editingIdx === allIdx) return null; // shown in form instead
                  return (
                    <div
                      key={allIdx}
                      className="group flex items-center gap-1 cursor-pointer"
                      onClick={() => handleEditConstraint(allIdx)}
                      title="Click to edit"
                    >
                      <span className="text-base font-bold" style={{ color: cfg.color }}>{e1?.automataName ?? '?'}</span>
                      <span className="text-sm font-bold opacity-40" style={{ color: cfg.color }}>{cfg.symbol}</span>
                      <span className="text-base font-bold" style={{ color: cfg.color }}>{e2?.automataName ?? '?'}</span>
                      <button
                        className="ml-1 opacity-0 group-hover:opacity-60 transition-opacity text-[11px] leading-none"
                        style={{ color: '#f87171' }}
                        onClick={(ev) => { ev.stopPropagation(); onRemoveConstraint(wec.edge1Id, wec.edge2Id); }}
                      >✕</button>
                    </div>
                  );
                })
            }
          </div>
        )}

        {/* Form row */}
        <div className="flex items-center gap-2 px-3 py-2 flex-wrap">
          <span
            className="text-[11px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
            style={{ color: cfg.color, background: `${cfg.color}18` }}
          >
            {editingIdx !== null ? 'Edit' : '+'}
          </span>

          {addType !== 'length' ? (
            <>
              <select ref={firstSelectRef} value={addE1} onChange={(e) => { setAddE1(e.target.value); setDupWarning(false); }} className={selCls}>
                <option value="">—</option>
                {edges.map((e) => <option key={e.id} value={e.id}>{e.automataName}</option>)}
              </select>
              <span className="text-base font-bold" style={{ color: cfg.color }}>{cfg.symbol}</span>
              <select value={addE2} onChange={(e) => { setAddE2(e.target.value); setDupWarning(false); }} className={selCls}>
                <option value="">—</option>
                {edges.filter((e) => e.id !== addE1).map((e) => <option key={e.id} value={e.id}>{e.automataName}</option>)}
              </select>
              {dupWarning && <span className="text-[11px]" style={{ color: '#f87171' }}>Already exists!</span>}
              {editingIdx !== null && (
                <button
                  onClick={() => { const old = constraints[editingIdx!]; onRemoveConstraint(old.edge1Id, old.edge2Id); closeForm(); }}
                  className="text-[12px] px-2 py-0.5 rounded border shrink-0"
                  style={{ color: '#f87171', borderColor: 'rgba(248,113,113,0.25)', background: 'rgba(248,113,113,0.08)' }}
                >Delete</button>
              )}
              <button
                disabled={!addE1 || !addE2 || addE1 === addE2}
                onClick={handleAdd}
                className="text-[12px] px-3 py-0.5 rounded border transition-all shrink-0"
                style={addE1 && addE2 && addE1 !== addE2
                  ? { background: `${cfg.color}1e`, border: `1px solid ${cfg.color}50`, color: cfg.color }
                  : { opacity: 0.28, cursor: 'not-allowed', border: '1px solid transparent', background: 'transparent', color: 'gray' }}
              >{editingIdx !== null ? 'Apply' : 'Add'}</button>
            </>
          ) : onUpdateEdge ? (
            <>
              <select value={lenEdgeId} onChange={(e) => setLenEdgeId(e.target.value)} className={selCls}>
                {edges.map((e) => <option key={e.id} value={e.id}>{e.label}{e.quantifier === '1' ? '' : e.quantifier}</option>)}
              </select>
              <span className="text-[13px] font-mono" style={{ color: cfg.color }}>[</span>
              <input type="number" placeholder="min" min={0} value={lenMin} onChange={(e) => setLenMin(e.target.value)} className={numCls} />
              <span className="text-[13px] font-mono" style={{ color: cfg.color }}>..</span>
              <input type="number" placeholder="max" min={0} value={lenMax} onChange={(e) => setLenMax(e.target.value)} className={numCls} />
              <span className="text-[13px] font-mono" style={{ color: cfg.color }}>]</span>
              <button
                disabled={!lenEdgeId || (lenMin === '' && lenMax === '')}
                onClick={handleApplyLength}
                className="text-[12px] px-3 py-0.5 rounded border transition-all shrink-0"
                style={lenEdgeId && (lenMin !== '' || lenMax !== '')
                  ? { background: `${cfg.color}1e`, border: `1px solid ${cfg.color}50`, color: cfg.color }
                  : { opacity: 0.28, cursor: 'not-allowed', border: '1px solid transparent', background: 'transparent', color: 'gray' }}
              >Apply</button>
            </>
          ) : null}

          <button
            onClick={closeForm}
            className="text-[12px] px-2 py-0.5 rounded transition-colors shrink-0"
            style={{ color: d ? '#4b5563' : '#9ca3af' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = d ? '#9ca3af' : '#6b7280')}
            onMouseLeave={(e) => (e.currentTarget.style.color = d ? '#4b5563' : '#9ca3af')}
          >Cancel</button>
        </div>
      </div>
    );
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      className="shrink-0"
      style={{ borderBottom: `1px solid ${d ? 'rgba(55,65,81,0.55)' : 'rgba(229,231,235,1)'}` }}
    >
      {/* ── Segmented pill group ── */}
      <div
        className="px-3 py-1.5 flex items-center"
        style={{ background: d ? 'rgba(10,16,30,0.6)' : 'rgba(248,250,252,1)' }}
      >
        <div
          className="inline-flex items-center p-0.5 rounded-2xl gap-0.5"
          style={{
            background: d ? 'rgba(15,23,42,0.95)' : '#ffffff',
            border:     d ? '1px solid rgba(55,65,81,0.6)' : '1px solid rgba(203,213,225,0.9)',
            boxShadow:  d ? '0 1px 6px rgba(0,0,0,0.4)' : '0 1px 4px rgba(0,0,0,0.08)',
          }}
        >
          {(Object.entries(TYPES) as [ConstraintType, typeof TYPES[ConstraintType]][]).map(([type, cfg]) => {
            const disabled = isDisabled(type);
            const count    = getCount(type);
            const isOpen   = addType === type;
            const hasItems = count > 0;
            const summary  = getPillSummary(type);

            return (
              <button
                key={type}
                onClick={() => !disabled && openForm(type)}
                disabled={disabled}
                title={disabled ? 'Add at least 2 path edges first' : undefined}
                className="relative flex items-center gap-1.5 px-3.5 py-1.5 rounded-[14px] text-sm font-semibold transition-all duration-200 whitespace-nowrap select-none"
                style={
                  isOpen
                    ? {
                        background: cfg.gradient,
                        color:      '#fff',
                        boxShadow:  `0 3px 14px ${cfg.color}90`,
                        fontWeight:  700,
                      }
                    : hasItems
                      ? {
                          background: cfg.hasItemsGradient,
                          color:      '#fff',
                          fontWeight:  700,
                          cursor:     'pointer',
                          boxShadow:  `0 2px 10px ${cfg.color}50`,
                        }
                      : {
                          background: 'transparent',
                          color:      disabled
                            ? (d ? '#374151' : '#d1d5db')
                            : (d ? '#94a3b8' : '#64748b'),
                          cursor:  disabled ? 'not-allowed' : 'pointer',
                          opacity: disabled ? 0.4 : 1,
                        }
                }
              >
                {/* Label */}
                <span>{cfg.label}</span>

                {/* Constraint formula summary — shown when has items */}
                {summary && (
                  <span
                    className="text-sm font-mono font-bold leading-none px-1.5 py-0.5 rounded-md"
                    style={{
                      background: (isOpen || hasItems) ? 'rgba(255,255,255,0.22)' : `${cfg.color}25`,
                      color:      (isOpen || hasItems) ? 'rgba(255,255,255,0.95)' : cfg.color,
                    }}
                  >
                    {summary}
                  </span>
                )}

                {/* "+" hint when empty and not disabled */}
                {!hasItems && !disabled && !isOpen && (
                  <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor"
                    strokeWidth="2.4" strokeLinecap="round" className="opacity-50">
                    <path d="M5 1v8M1 5h8"/>
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Panel (constraints + form) ── */}
      {renderPanel()}
    </div>
  );
};

export default ConstraintBar;
