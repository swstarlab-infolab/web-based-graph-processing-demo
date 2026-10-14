import type { ConstraintToggles } from '../utils/queryToggle';

export interface WalkthroughStep {
  title: string;
  description: string;
  /** Which constraint toggles should be active at this step */
  toggles: Partial<ConstraintToggles>;
}

export interface WalkthroughDef {
  scenarioId: string;
  /** Display name for this walkthrough */
  name: string;
  steps: WalkthroughStep[];
}

/**
 * Pre-defined walkthroughs for representative scenarios.
 * Each adds one constraint per step to show progressive narrowing.
 */
export const WALKTHROUGHS: WalkthroughDef[] = [
  {
    scenarioId: 'S6',
    name: 'Friend Equality',
    steps: [
      {
        title: 'Unbounded Word Equality',
        description: 'Count all pairs of equal-label KNOWS paths (any length). This is the full WE universe.',
        toggles: { weEnabled: true, prefixEnabled: false, maxLength: null, compareWithPlain: false },
      },
      {
        title: 'Bounded ≤ 3 hops',
        description: 'Restrict to matching paths of at most 3 hops. Most long-range pairs vanish.',
        toggles: { weEnabled: true, prefixEnabled: false, maxLength: 3, compareWithPlain: true },
      },
      {
        title: 'Bounded ≤ 1 hop',
        description: 'Direct friends only. How many pairs share a single KNOWS edge?',
        toggles: { weEnabled: true, prefixEnabled: false, maxLength: 1, compareWithPlain: true },
      },
    ],
  },
  {
    scenarioId: 'S11',
    name: 'Friend Chain Prefix',
    steps: [
      {
        title: 'Unbounded Prefix',
        description: 'Find all prefix-matching KNOWS path pairs with no hop limit.',
        toggles: { weEnabled: false, prefixEnabled: true, maxLength: null, compareWithPlain: false },
      },
      {
        title: 'Bounded ≤ 3 hops',
        description: 'Keep only short prefix chains (≤ 3 hops). Long friendship distances are pruned.',
        toggles: { weEnabled: false, prefixEnabled: true, maxLength: 3, compareWithPlain: true },
      },
      {
        title: 'Bounded ≤ 1 hop',
        description: 'Direct friendship prefix only — the tightest filter.',
        toggles: { weEnabled: false, prefixEnabled: true, maxLength: 1, compareWithPlain: true },
      },
    ],
  },
  {
    scenarioId: 'S15',
    name: 'Friend Triangle',
    steps: [
      {
        title: 'Unbounded CRPQ',
        description: 'Comment author + post creator connected via KNOWS with no hop limit.',
        toggles: { weEnabled: false, prefixEnabled: false, maxLength: null, compareWithPlain: false },
      },
      {
        title: 'KNOWS ≤ 3',
        description: 'Commenter must know the poster within 3 hops — small-world triangles.',
        toggles: { weEnabled: false, prefixEnabled: false, maxLength: 3, compareWithPlain: true },
      },
      {
        title: 'KNOWS ≤ 1',
        description: 'Direct friends only. How many commenter–poster pairs are direct friends?',
        toggles: { weEnabled: false, prefixEnabled: false, maxLength: 1, compareWithPlain: true },
      },
    ],
  },
];

/** Find walkthrough definition for a scenario ID */
export function getWalkthrough(scenarioId: string): WalkthroughDef | undefined {
  return WALKTHROUGHS.find(w => w.scenarioId === scenarioId);
}

/* ── Demo Script: multi-scenario walkthrough for live presentations ── */

export interface DemoScriptStep {
  scenarioId: string;
  title: string;
  description: string;
  toggles: Partial<ConstraintToggles>;
  /** Short insight shown after the step completes */
  insight: string;
}

export interface DemoScript {
  name: string;
  steps: DemoScriptStep[];
}

export const DEMO_SCRIPTS: DemoScript[] = [
  {
    name: 'Canonical Demo',
    steps: [
      // Word Equality progression
      {
        scenarioId: 'S6',
        title: 'Word Equality — Unbounded',
        description: 'All pairs of equal-label KNOWS paths, any length.',
        toggles: { weEnabled: true, prefixEnabled: false, maxLength: null, compareWithPlain: false },
        insight: 'Trillions of same-sequence friend pairs exist across all hop depths.',
      },
      {
        scenarioId: 'S6',
        title: 'WE — Bounded ≤ 3 hops',
        description: 'Restrict to paths of at most 3 hops.',
        toggles: { weEnabled: true, prefixEnabled: false, maxLength: 3, compareWithPlain: true },
        insight: 'Bounding to 3 hops removes most deep cascade pairs.',
      },
      {
        scenarioId: 'S6',
        title: 'WE — Bounded ≤ 1 hop',
        description: 'Direct friends only.',
        toggles: { weEnabled: true, prefixEnabled: false, maxLength: 1, compareWithPlain: true },
        insight: 'Only direct-friend pairs survive — over 99.99% filtered.',
      },
      // Prefix progression
      {
        scenarioId: 'S11',
        title: 'Prefix — Unbounded',
        description: 'Find all prefix-matching KNOWS path pairs.',
        toggles: { weEnabled: false, prefixEnabled: true, maxLength: null, compareWithPlain: false },
        insight: 'Short traces that start longer chains — nested friendship patterns.',
      },
      {
        scenarioId: 'S11',
        title: 'Prefix — Bounded ≤ 1 hop',
        description: 'Tightest prefix filter.',
        toggles: { weEnabled: false, prefixEnabled: true, maxLength: 1, compareWithPlain: true },
        insight: 'Very close nested friendships only.',
      },
      // CRPQ bounded length progression
      {
        scenarioId: 'S15',
        title: 'CRPQ — Unbounded',
        description: 'Comment author ↔ post creator via KNOWS, no hop limit.',
        toggles: { weEnabled: false, prefixEnabled: false, maxLength: null, compareWithPlain: false },
        insight: 'All commenter–poster triangles in the social graph.',
      },
      {
        scenarioId: 'S15',
        title: 'CRPQ — KNOWS ≤ 3',
        description: 'Commenter knows poster within 3 hops.',
        toggles: { weEnabled: false, prefixEnabled: false, maxLength: 3, compareWithPlain: true },
        insight: 'Small-world triangles — most connections are short.',
      },
      {
        scenarioId: 'S15',
        title: 'CRPQ — KNOWS ≤ 1',
        description: 'Direct friends only.',
        toggles: { weEnabled: false, prefixEnabled: false, maxLength: 1, compareWithPlain: true },
        insight: 'Dramatic drop — few commenter–poster pairs are direct friends.',
      },
    ],
  },
];

export function getDemoScript(name?: string): DemoScript | undefined {
  if (!name) return DEMO_SCRIPTS[0];
  return DEMO_SCRIPTS.find(s => s.name === name);
}
