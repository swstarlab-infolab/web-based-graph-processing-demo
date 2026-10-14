import type { ConstraintToggles } from '../utils/queryToggle';

export interface WhatIfChip {
  id: string;
  label: string;
  description: string;
  type: 'constraint';
  togglePatch: Partial<ConstraintToggles>;
  color: string;
}

/* ── Suggestion generator ── */

export function generateSuggestions(
  _scenarioId: string | null,
  detected: { hasWE: boolean; hasPrefixWE: boolean; hasLength: boolean },
  toggles: ConstraintToggles,
  hasResult: boolean,
): WhatIfChip[] {
  if (!hasResult) return [];

  const chips: WhatIfChip[] = [];

  // ── Constraint chips (max 3) ──

  if (detected.hasLength) {
    if (toggles.maxLength !== 3) {
      chips.push({
        id: 'len-3',
        label: '\u2264 3 hops',
        description: 'Limit paths to at most 3 hops',
        type: 'constraint',
        togglePatch: { maxLength: 3 },
        color: '#f59e0b',
      });
    }
    if (toggles.maxLength !== 1) {
      chips.push({
        id: 'len-1',
        label: '\u2264 1 hop',
        description: 'Direct connections only',
        type: 'constraint',
        togglePatch: { maxLength: 1 },
        color: '#f59e0b',
      });
    }
    if (toggles.maxLength != null) {
      chips.push({
        id: 'len-inf',
        label: 'Unbounded',
        description: 'Remove length limit',
        type: 'constraint',
        togglePatch: { maxLength: null },
        color: '#f59e0b',
      });
    }
  }

  if (detected.hasWE && !toggles.weEnabled) {
    chips.push({
      id: 'we-on',
      label: 'Enable WE',
      description: 'Require equal label sequences',
      type: 'constraint',
      togglePatch: { weEnabled: true },
      color: '#22d3ee',
    });
  }

  if (detected.hasPrefixWE && !toggles.prefixEnabled) {
    chips.push({
      id: 'pfx-on',
      label: 'Enable Prefix',
      description: 'Require prefix label match',
      type: 'constraint',
      togglePatch: { prefixEnabled: true },
      color: '#a78bfa',
    });
  }

  if (!toggles.compareWithPlain) {
    chips.push({
      id: 'compare',
      label: 'Compare \u25B8',
      description: 'Side-by-side with unconstrained result',
      type: 'constraint',
      togglePatch: { compareWithPlain: true },
      color: '#10b981',
    });
  }

  // Limit to 3 chips
  return chips.slice(0, 3);
}
