/**
 * Simple NFA builder for preview display.
 * Converts label + quantifier into NFA states/transitions for the engine automaton format.
 * This is a frontend-only preview; the backend is the source of truth.
 */

import type { NFADefinition } from '../types';
export type { NFADefinition };

/**
 * Build an NFA from a single label and quantifier.
 * Label suffix convention: "LABEL-" = APPEND (forward), "-LABEL" = PREPEND (backward).
 */
export function buildSingleLabelNFA(
  label: string,
  quantifier: '1' | '*' | '+' | '?',
  direction: 'forward' | 'reverse' | 'both' = 'forward',
): NFADefinition {
  const transLabel = direction === 'reverse' ? `-${label}` : `${label}-`;

  switch (quantifier) {
    case '1': // exactly once: q0 --label--> q1
      return {
        regular_expression: label,
        states: ['q0', 'q1'],
        alphabets: [label],
        transitions: [['q0', transLabel, 'q1']],
        initial_states: ['q0'],
        final_states: ['q1'],
      };

    case '*': // zero or more: self-loop on q0, initial=final
      return {
        regular_expression: `${label}*`,
        states: ['q0'],
        alphabets: [label],
        transitions: [['q0', transLabel, 'q0']],
        initial_states: ['q0'],
        final_states: ['q0'],
      };

    case '+': // one or more: q0 --label--> q1 with self-loop on q1
      return {
        regular_expression: `${label}+`,
        states: ['q0', 'q1'],
        alphabets: [label],
        transitions: [
          ['q0', transLabel, 'q1'],
          ['q1', transLabel, 'q1'],
        ],
        initial_states: ['q0'],
        final_states: ['q1'],
      };

    case '?': // zero or one: q0 --label--> q1, initial=q0, final=[q0,q1]
      return {
        regular_expression: `${label}?`,
        states: ['q0', 'q1'],
        alphabets: [label],
        transitions: [['q0', transLabel, 'q1']],
        initial_states: ['q0'],
        final_states: ['q0', 'q1'],
      };
  }
}

/**
 * Build an NFA from a sequence of labels (concatenation).
 * e.g., ["KNOWS", "HAS_INTEREST"] with quantifier '1' produces a chain.
 */
export function buildConcatNFA(
  labels: string[],
  quantifier: '1' | '*' | '+' | '?',
): NFADefinition {
  if (labels.length === 0) {
    return {
      regular_expression: '',
      states: ['q0'],
      alphabets: [],
      transitions: [],
      initial_states: ['q0'],
      final_states: ['q0'],
    };
  }

  if (labels.length === 1) {
    return buildSingleLabelNFA(labels[0], quantifier);
  }

  // For multi-label with quantifier on the whole sequence
  const states: string[] = [];
  const transitions: [string, string, string][] = [];

  for (let i = 0; i <= labels.length; i++) {
    states.push(`q${i}`);
  }

  for (let i = 0; i < labels.length; i++) {
    transitions.push([`q${i}`, `${labels[i]}-`, `q${i + 1}`]);
  }

  const regex = labels.join('/');
  const alphabets = [...new Set(labels)];
  const lastState = `q${labels.length}`;

  switch (quantifier) {
    case '1':
      return {
        regular_expression: regex,
        states,
        alphabets,
        transitions,
        initial_states: ['q0'],
        final_states: [lastState],
      };
    case '*':
      // Add epsilon-like loop: last state -> first state
      transitions.push([lastState, `${labels[0]}-`, 'q1']);
      return {
        regular_expression: `(${regex})*`,
        states,
        alphabets,
        transitions: [transitions[0], ...transitions.slice(1)],
        initial_states: ['q0'],
        final_states: ['q0', lastState],
      };
    case '+':
      transitions.push([lastState, `${labels[0]}-`, 'q1']);
      return {
        regular_expression: `(${regex})+`,
        states,
        alphabets,
        transitions,
        initial_states: ['q0'],
        final_states: [lastState],
      };
    case '?':
      return {
        regular_expression: `(${regex})?`,
        states,
        alphabets,
        transitions,
        initial_states: ['q0'],
        final_states: ['q0', lastState],
      };
  }
}

/**
 * Build an NFA for alternation (A|B).
 * Each alternate label gets its own transition from q0.
 */
export function buildAlternationNFA(
  labels: string[],
  quantifier: '1' | '*' | '+' | '?',
  direction: 'forward' | 'reverse' | 'both' = 'forward',
): NFADefinition {
  if (labels.length <= 1) {
    return buildSingleLabelNFA(labels[0] || '', quantifier, direction);
  }

  const regex = labels.join('|');
  const alphabets = [...new Set(labels)];
  const sym = (l: string) => direction === 'reverse' ? `-${l}` : `${l}-`;

  switch (quantifier) {
    case '1': {
      const transitions: [string, string, string][] = labels.map((l) => [
        'q0', sym(l), 'q1',
      ]);
      return {
        regular_expression: `(${regex})`,
        states: ['q0', 'q1'],
        alphabets,
        transitions,
        initial_states: ['q0'],
        final_states: ['q1'],
      };
    }
    case '*': {
      const transitions: [string, string, string][] = labels.map((l) => [
        'q0', sym(l), 'q0',
      ]);
      return {
        regular_expression: `(${regex})*`,
        states: ['q0'],
        alphabets,
        transitions,
        initial_states: ['q0'],
        final_states: ['q0'],
      };
    }
    case '+': {
      const transitions: [string, string, string][] = [
        ...labels.map((l): [string, string, string] => ['q0', sym(l), 'q1']),
        ...labels.map((l): [string, string, string] => ['q1', sym(l), 'q1']),
      ];
      return {
        regular_expression: `(${regex})+`,
        states: ['q0', 'q1'],
        alphabets,
        transitions,
        initial_states: ['q0'],
        final_states: ['q1'],
      };
    }
    case '?': {
      const transitions: [string, string, string][] = labels.map((l) => [
        'q0', sym(l), 'q1',
      ]);
      return {
        regular_expression: `(${regex})?`,
        states: ['q0', 'q1'],
        alphabets,
        transitions,
        initial_states: ['q0'],
        final_states: ['q0', 'q1'],
      };
    }
  }
}
