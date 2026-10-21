import { useState, useMemo, type FC } from 'react';
import type { Dataset, PresetQuery, CatalogGroup } from '../types';

/* ---- Dataset families ---- */
interface DatasetOption { id: string; label: string; sub: string; }
interface DatasetFamily { key: string; label: string; desc: string; options: DatasetOption[]; }

const DATASET_FAMILIES: DatasetFamily[] = [
  {
    key: 'ldbc', label: 'LDBC Social Network', desc: 'Person-knows-Person, Comment, Post, Tag, ...',
    options: [
      { id: 'LDBC_SNB_SF1',   label: 'SF 1',   sub: '14.7 M vertices  |  22.4 M edges' },
      { id: 'LDBC_SNB_SF10',  label: 'SF 10',  sub: '~150 M vertices  |  ~220 M edges' },
    ],
  },
];

/* ---- Scenario data ---- */
interface Scenario { id: string; title: string; desc: string; question?: string; tag?: string; }
interface Group { key: string; label: string; tagline: string; color: string; scenarios: Scenario[]; }

/** Render text with **bold** markdown fragments */
function renderBold(text: string, isDark: boolean) {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  if (parts.length === 1) return text;
  return parts.map((p, i) =>
    i % 2 === 1
      ? <strong key={i} className={`font-medium ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{p}</strong>
      : p
  );
}

/* ---- Component ---- */
interface WelcomeScreenProps {
  datasets: Dataset[];
  presets: PresetQuery[];
  catalogGroups: CatalogGroup[];
  onContinue: (datasetId: string, preset: PresetQuery | null) => void;
  isDark: boolean;
  onToggleTheme: () => void;
}

const WelcomeScreen: FC<WelcomeScreenProps> = ({ datasets, presets, catalogGroups, onContinue, isDark: d, onToggleTheme }) => {
  const [familyKey, setFamilyKey] = useState<string>('ldbc');
  const [datasetId, setDatasetId] = useState('LDBC_SNB_SF1');
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const isAvailable = (id: string) => datasets.find(ds => ds.id === id)?.available !== false;

  const family = DATASET_FAMILIES.find(f => f.key === familyKey) ?? DATASET_FAMILIES[0];

  // Build LDBC groups dynamically from catalog
  const ldbcGroups = useMemo<Group[]>(() => {
    return catalogGroups.map(cg => {
      const groupPresets = presets.filter(p => p.catalog?.group === cg.id);
      return {
        key: cg.id,
        label: cg.label,
        tagline: cg.tagline ?? cg.description ?? '',
        color: cg.color ?? '#94a3b8',
        scenarios: groupPresets.map(p => ({
          id: p.catalog!.id,
          title: p.catalog!.title,
          desc: p.catalog!.question ?? '',
          question: p.catalog!.question,
          tag: p.catalog!.tag,
        })),
      };
    }).filter(g => g.scenarios.length > 0);
  }, [catalogGroups, presets]);

  const groups = ldbcGroups;

  function switchFamily(key: string) {
    const f = DATASET_FAMILIES.find(x => x.key === key);
    if (!f) return;
    setFamilyKey(key);
    setDatasetId('');
    setSelectedId(null);
  }

  const presetMap = useMemo(() => {
    const m = new Map<string, PresetQuery>();
    // Map by catalog scenario id
    for (const p of presets) {
      if (p.catalog) m.set(p.catalog.id, p);
    }
    return m;
  }, [presets]);

  function go(preset: PresetQuery | null) {
    onContinue(datasetId, preset);
  }

  /* Find the selected scenario's group color for the Run button */
  const selectedGroup = selectedId
    ? groups.find(g => g.scenarios.some(s => s.id === selectedId))
    : null;
  const runColor = selectedGroup?.color ?? '#06b6d4';

  return (
    <div className={`h-screen flex flex-col ${d ? 'bg-gray-950 text-gray-100' : 'bg-slate-50 text-gray-900'}`}>
      {/* ── Header ── */}
      <header className={`flex items-center justify-between px-8 py-4 shrink-0 border-b ${
        d ? 'border-gray-800/80 bg-gray-950' : 'border-gray-200 bg-white/90 backdrop-blur-sm shadow-sm'
      }`}>
        <div className="flex items-center gap-2.5">
          <div className="flex items-center gap-1.5">
            <img src="/logo.png" alt="logo" className="h-8 w-8 object-contain" />
            <span className={`font-extrabold text-xl tracking-tight ${d ? 'text-white' : 'text-gray-900'}`}>
              Web Graph Demo
            </span>
          </div>
          <span className={`text-sm hidden sm:inline ${d ? 'text-gray-500' : 'text-gray-400'}`}>
            Web-based graph processing demonstration system
          </span>
        </div>
        <button
          className={`w-8 h-8 rounded-lg border flex items-center justify-center transition-colors ${
            d ? 'bg-gray-800 border-gray-700 text-gray-500 hover:text-yellow-400'
              : 'bg-white border-gray-200 text-gray-400 hover:text-gray-600'
          }`}
          onClick={onToggleTheme}
        >
          {d
            ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
            : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          }
        </button>
      </header>

      {/* ── Body ── */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[1400px] mx-auto px-8 py-6 flex flex-col gap-5">

          {/* ── Tagline ── */}
          <p className={`text-center text-lg leading-relaxed ${d ? 'text-gray-500' : 'text-gray-400'}`}>
            Explore <span style={{ color: '#10b981' }}>RPQ/CRPQ</span> with{' '}
            <span style={{ color: '#22d3ee' }}>word equality</span>,{' '}
            <span style={{ color: '#a78bfa' }}>prefix</span>, and{' '}
            <span style={{ color: '#f59e0b' }}>bounded-length</span> constraints.
          </p>

          {/* ── Step 1: Dataset ── */}
          <section>
            <div className="flex items-center gap-2 mb-2">
              <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                d ? 'bg-cyan-900/40 text-cyan-400' : 'bg-cyan-50 text-cyan-600'
              }`}>1</span>
              <h2 className={`text-base font-bold ${d ? 'text-gray-300' : 'text-gray-600'}`}>Select a dataset</h2>
            </div>
            <div className={`rounded-xl border px-5 py-3.5 ${
              d ? 'border-gray-800 bg-gray-900/50' : 'border-gray-200 bg-white shadow-sm'
            }`}>
              <div className="flex items-center gap-3">
                <div className={`flex rounded-lg overflow-hidden border ${d ? 'border-gray-700' : 'border-gray-200'}`}>
                {DATASET_FAMILIES.map(f => (
                  <button
                    key={f.key}
                    onClick={() => switchFamily(f.key)}
                    className={`text-sm px-4 py-2 font-semibold transition-all ${
                      familyKey === f.key
                        ? 'bg-cyan-600 text-white'
                        : d ? 'bg-gray-800/80 text-gray-400 hover:text-gray-200' : 'bg-white text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              {familyKey && (<>
                <div className={`w-px h-7 shrink-0 ${d ? 'bg-gray-700' : 'bg-gray-200'}`} />
                {family.options.map(o => (
                  <button
                    key={o.id}
                    onClick={() => setDatasetId(o.id)}
                    disabled={!isAvailable(o.id)}
                    title={isAvailable(o.id) ? o.sub : 'No recorded results for this dataset in mock mode'}
                    className={`text-sm px-4 py-2 rounded-lg font-semibold transition-all border shrink-0 disabled:opacity-40 disabled:cursor-not-allowed ${
                      datasetId === o.id
                        ? d ? 'border-cyan-500/60 bg-cyan-950/50 text-cyan-400'
                            : 'border-cyan-400 bg-cyan-50 text-cyan-700'
                        : d ? 'border-gray-700 text-gray-500 hover:text-gray-300 hover:border-gray-600'
                            : 'border-gray-200 text-gray-500 hover:text-gray-700 hover:border-gray-300'
                    }`}
                  >
                    {o.label}
                    <span className={`ml-1.5 text-xs font-normal ${
                      datasetId === o.id
                        ? d ? 'text-cyan-500/70' : 'text-cyan-600/70'
                        : d ? 'text-gray-600' : 'text-gray-400'
                    }`}>
                      {o.sub.split('|')[0].trim()}
                    </span>
                  </button>
                ))}
              </>)}
              </div>
            </div>
          </section>

          {/* ── Step 2: Scenario or custom (visible only after dataset selected) ── */}
          {datasetId && <section>
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-2">
                <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                  d ? 'bg-cyan-900/40 text-cyan-400' : 'bg-cyan-50 text-cyan-600'
                }`}>2</span>
                <h2 className={`text-base font-bold ${d ? 'text-gray-300' : 'text-gray-600'}`}>Run a scenario or build your own</h2>
              </div>
              <div className="flex items-center gap-3">
                <button
                  disabled={!selectedId || !datasetId}
                  onClick={() => { const p = selectedId ? presetMap.get(selectedId) : undefined; if (p) go(p); }}
                  className={`px-5 py-2 rounded-lg text-sm font-bold transition-all ${
                    selectedId && datasetId
                      ? 'text-white hover:brightness-110'
                      : d ? 'bg-gray-800 text-gray-600 cursor-not-allowed' : 'bg-gray-200/80 text-gray-400 cursor-not-allowed'
                  }`}
                  style={selectedId && datasetId ? {
                    background: runColor,
                    boxShadow: `0 2px 8px ${runColor}40`,
                  } : undefined}
                >
                  {selectedId ? `Run ${selectedId}` : 'Select a scenario'}
                </button>
                <span className={`text-xs font-medium ${d ? 'text-gray-600' : 'text-gray-400'}`}>or</span>
                <button
                  disabled={!datasetId}
                  onClick={() => go(null)}
                  className={`px-5 py-2 rounded-lg text-sm font-semibold transition-all ${
                    !datasetId
                      ? d ? 'bg-gray-800 text-gray-600 cursor-not-allowed' : 'bg-gray-200/80 text-gray-400 cursor-not-allowed'
                      : d ? 'bg-cyan-800/30 text-cyan-400 hover:bg-cyan-800/50'
                        : 'bg-cyan-600 text-white hover:bg-cyan-700'
                  }`}
                >
                  Build your own query
                </button>
              </div>
            </div>

            <div className="flex gap-3" style={{ alignItems: 'flex-start' }}>
              {groups.map(g => (
                <div
                  key={g.key}
                  className={`flex-1 min-w-0 rounded-xl border overflow-hidden flex flex-col ${
                    d ? 'border-gray-800 bg-gray-900/50' : 'border-gray-200 bg-white shadow-sm'
                  }`}
                >
                  {/* Column header */}
                  <div className="px-4 pt-4 pb-3 shrink-0">
                    <div className="flex items-center gap-2 mb-1.5">
                      <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: g.color }} />
                      <span className="text-lg font-extrabold tracking-tight" style={{ color: g.color }}>
                        {g.label}
                      </span>
                    </div>
                    <div className={`text-sm leading-snug ${d ? 'text-gray-500' : 'text-gray-400'}`}>
                      {renderBold(g.tagline, d)}
                    </div>
                  </div>

                  {/* Divider */}
                  <div className="mx-3" style={{ height: 2, background: `linear-gradient(90deg, ${g.color}, ${g.color}30)`, borderRadius: 1 }} />

                  {/* Scenario list — always visible */}
                  <div className="px-2 py-2 flex flex-col gap-1">
                    {g.scenarios.map(sc => {
                      const available = presetMap.has(sc.id);
                      const selected = selectedId === sc.id;
                      const hovered = hoveredId === sc.id;
                      return (
                        <div key={sc.id} className="relative group/card">
                          <button
                            disabled={!available}
                            onClick={() => { if (available) setSelectedId(selected ? null : sc.id); }}
                            onMouseEnter={() => available && setHoveredId(sc.id)}
                            onMouseLeave={() => setHoveredId(null)}
                            className={`w-full text-left rounded-lg px-3 py-3 transition-all duration-150 ${
                              !available ? 'opacity-25 cursor-not-allowed' : 'cursor-pointer'
                            }`}
                            style={{
                              background: selected
                                ? d ? `${g.color}20` : `${g.color}12`
                                : hovered && available
                                  ? d ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)'
                                  : 'transparent',
                              border: `1.5px solid ${selected ? g.color : 'transparent'}`,
                              borderRadius: 8,
                            }}
                          >
                            <div className="flex items-start gap-2.5">
                              {/* Radio dot */}
                              <div
                                className="w-[18px] h-[18px] rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5 transition-all duration-150"
                                style={{
                                  borderColor: selected ? g.color : d ? 'rgba(75,85,99,0.5)' : 'rgba(209,213,219,0.8)',
                                  background: selected ? g.color : 'transparent',
                                }}
                              >
                                {selected && (
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M5 12l5 5L20 7" />
                                  </svg>
                                )}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span
                                    className="text-xs font-mono font-bold tracking-wider uppercase shrink-0"
                                    style={{ color: selected ? g.color : d ? 'rgba(156,163,175,0.5)' : 'rgba(156,163,175,0.8)' }}
                                  >
                                    {sc.id}
                                  </span>
                                  {sc.tag && (
                                    <span
                                      className={`text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${
                                        d ? 'bg-gray-800 text-gray-400' : 'bg-gray-100 text-gray-500'
                                      }`}
                                    >
                                      {sc.tag}
                                    </span>
                                  )}
                                  <span className={`text-sm font-semibold truncate ${
                                    selected ? (d ? 'text-gray-100' : 'text-gray-900') : d ? 'text-gray-300' : 'text-gray-700'
                                  }`}>
                                    {sc.title}
                                  </span>
                                </div>
                                <div className={`text-[13px] leading-snug mt-1 ${d ? 'text-gray-500' : 'text-gray-400'}`}>
                                  {sc.question || sc.desc}
                                </div>
                              </div>
                            </div>
                          </button>

                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </section>}


        </div>
      </div>
    </div>
  );
};

export default WelcomeScreen;
