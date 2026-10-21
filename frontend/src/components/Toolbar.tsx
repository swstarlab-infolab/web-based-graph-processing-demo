import { useMemo, type FC } from 'react';
import type { Dataset } from '../types';

const DATASET_FAMILIES = [
  {
    family: 'LDBC SNB',
    paramLabel: 'SF',
    options: [
      { id: 'LDBC_SNB_SF1', label: '1' },
      { id: 'LDBC_SNB_SF10', label: '10' },
    ],
  },
] as const;

interface ToolbarProps {
  datasets: Dataset[];
  selectedDataset: string;
  onSelectDataset: (id: string) => void;
  onShowWelcome?: () => void;
  isMockMode: boolean;
  /** Replay stored results instead of running the engine. */
  cacheMode: boolean;
  onToggleCacheMode: () => void;
  isDark: boolean;
  onToggleTheme: () => void;
}

const Toolbar: FC<ToolbarProps> = ({
  datasets,
  selectedDataset,
  onSelectDataset,
  onShowWelcome,
  isMockMode,
  cacheMode,
  onToggleCacheMode,
  isDark: d,
  onToggleTheme,
}) => {
  const currentFamilyIdx = useMemo(() => {
    for (let i = 0; i < DATASET_FAMILIES.length; i++) {
      if (DATASET_FAMILIES[i].options.some((o) => o.id === selectedDataset)) return i;
    }
    return 0;
  }, [selectedDataset]);

  const currentFamily = DATASET_FAMILIES[currentFamilyIdx];

  const isAvailable = (id: string) => datasets.find((ds) => ds.id === id)?.available !== false;

  return (
    <header className={`flex items-center justify-between px-6 py-3 shrink-0 border-b ${
      d ? 'border-gray-800/80 bg-gray-950' : 'border-gray-200 bg-white/90 backdrop-blur-sm shadow-sm'
    }`}>
      {/* Left: Logo + Dataset */}
      <div className="flex items-center gap-5">
        {/* Logo — clickable → navigate home */}
        <button
          className="flex items-center gap-1.5 shrink-0 group bg-transparent border-none cursor-pointer"
          onClick={onShowWelcome}
          title="Back to home"
        >
          <img src="/logo.png" alt="logo" className="h-8 w-8 object-contain" />
          <span className={`font-extrabold text-base tracking-tight ${d ? 'text-white' : 'text-gray-900'}`}>
            Web Graph Demo
          </span>
        </button>

        <div className={`w-px h-5 ${d ? 'bg-gray-700' : 'bg-gray-200'}`} />

        {/* Dataset selector */}
        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border ${
          d ? 'bg-gray-900/50 border-gray-700/60' : 'bg-gray-50 border-gray-200'
        }`}>
          <span className={`text-xs font-semibold uppercase tracking-wider shrink-0 ${d ? 'text-gray-500' : 'text-gray-400'}`}>
            Dataset
          </span>
          <div className={`w-px h-4 ${d ? 'bg-gray-700' : 'bg-gray-200'}`} />
          <div className="flex items-center gap-1.5">
            {DATASET_FAMILIES.map((f, i) => (
              <button
                key={f.family}
                onClick={() => onSelectDataset(DATASET_FAMILIES[i].options[0].id)}
                className={`text-xs px-2.5 py-1 rounded-md font-semibold transition-all ${
                  currentFamilyIdx === i
                    ? 'bg-cyan-600 text-white'
                    : d ? 'text-gray-500 hover:text-gray-300' : 'text-gray-400 hover:text-gray-600'
                }`}
              >
                {f.family}
              </button>
            ))}
            <div className={`w-px h-4 mx-0.5 ${d ? 'bg-gray-700' : 'bg-gray-200'}`} />
            {currentFamily.options.map((opt) => (
              <button
                key={opt.id}
                onClick={() => onSelectDataset(opt.id)}
                disabled={!isAvailable(opt.id)}
                title={isAvailable(opt.id) ? undefined : 'No recorded results for this dataset in mock mode'}
                className={`text-xs px-2.5 py-1 rounded-md font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                  selectedDataset === opt.id
                    ? d ? 'bg-cyan-900/50 text-cyan-400 border border-cyan-500/50' : 'bg-cyan-50 text-cyan-700 border border-cyan-400'
                    : d ? 'text-gray-500 hover:text-gray-300 border border-transparent' : 'text-gray-400 hover:text-gray-600 border border-transparent'
                }`}
              >
                {currentFamily.paramLabel} {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Right: Mock badge + Live/Cached + Theme */}
      <div className="flex items-center gap-3">
        {/* Where answers come from.  Live is the default and the claim the demo
            makes; Cached is an escape hatch for a slow query or a bad link, and
            it says so loudly rather than quietly looking fast. */}
        <button
          className={`text-xs font-semibold px-2.5 py-1 rounded-lg border flex items-center gap-1.5 transition-colors ${
            cacheMode
              ? (d ? 'text-amber-300 bg-amber-900/30 border-amber-600/60 hover:bg-amber-900/50'
                   : 'text-amber-700 bg-amber-50 border-amber-300 hover:bg-amber-100')
              : (d ? 'text-emerald-300 bg-emerald-900/25 border-emerald-700/50 hover:bg-emerald-900/40'
                   : 'text-emerald-700 bg-emerald-50 border-emerald-300 hover:bg-emerald-100')
          }`}
          onClick={onToggleCacheMode}
          title={cacheMode
            ? 'Serving stored results. Click to run every query on the engine again.'
            : 'Running every query on the engine. Click to replay stored results instead.'}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${
            cacheMode ? (d ? 'bg-amber-400' : 'bg-amber-500')
                      : (d ? 'bg-emerald-400' : 'bg-emerald-500')
          }`} />
          {cacheMode ? 'Cached' : 'Live'}
        </button>

        {isMockMode && (
          <span className={`text-xs font-medium px-2 py-0.5 rounded border ${
            d ? 'text-amber-400 bg-amber-900/20 border-amber-700/50' : 'text-amber-600 bg-amber-50 border-amber-200'
          }`}>
            Mock
          </span>
        )}

        <button
          className={`w-8 h-8 rounded-lg border flex items-center justify-center transition-colors ${
            d ? 'bg-gray-800 border-gray-700 text-gray-500 hover:text-yellow-400'
              : 'bg-white border-gray-200 text-gray-400 hover:text-gray-600'
          }`}
          onClick={onToggleTheme}
          title={d ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {d ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          )}
        </button>
      </div>
    </header>
  );
};

export default Toolbar;
