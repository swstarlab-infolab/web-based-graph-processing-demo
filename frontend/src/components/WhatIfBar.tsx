import { type FC } from 'react';
import type { WhatIfChip } from '../data/whatIfSuggestions';
import type { ConstraintToggles } from '../utils/queryToggle';

interface WhatIfBarProps {
  suggestions: WhatIfChip[];
  onConstraintChip: (patch: Partial<ConstraintToggles>) => void;
  isDark: boolean;
}

const WhatIfBar: FC<WhatIfBarProps> = ({ suggestions, onConstraintChip, isDark: d }) => {
  if (suggestions.length === 0) return null;

  return (
    <div
      className={`shrink-0 flex items-center gap-2 px-3 py-1.5 border-b overflow-x-auto ${
        d ? 'bg-gray-800/40 border-gray-700/60' : 'bg-gray-50/80 border-gray-200'
      }`}
    >
      <span className={`text-[10px] font-bold uppercase tracking-wider shrink-0 ${
        d ? 'text-gray-500' : 'text-gray-400'
      }`}>
        Try
      </span>
      {suggestions.map(chip => (
        <button
          key={chip.id}
          title={chip.description}
          onClick={() => onConstraintChip(chip.togglePatch)}
          className={`shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-all ${
            d
              ? 'border-gray-700 hover:border-gray-500 bg-gray-800/80 hover:bg-gray-700/80'
              : 'border-gray-200 hover:border-gray-300 bg-white hover:bg-gray-50 shadow-sm'
          }`}
          style={{ borderLeftWidth: 3, borderLeftColor: chip.color }}
        >
          <span className={d ? 'text-gray-200' : 'text-gray-700'}>{chip.label}</span>
        </button>
      ))}
    </div>
  );
};

export default WhatIfBar;
