import type { QueryGraph } from '../types';
import { buildQueryJSON } from './queryBuilder';

export interface ConstraintToggles {
  weEnabled: boolean;
  prefixEnabled: boolean;
  maxLength: number | null; // null = unbounded
  compareWithPlain: boolean;
}

export const DEFAULT_TOGGLES: ConstraintToggles = {
  weEnabled: true,
  prefixEnabled: true,
  maxLength: null,
  compareWithPlain: false,
};

/**
 * Detect which constraint types are present in a query graph.
 * Used to show only relevant toggles in the panel.
 */
export function detectConstraints(graph: QueryGraph): {
  hasWE: boolean;
  hasPrefixWE: boolean;
  hasLength: boolean;
} {
  const hasWE = graph.weConstraints.some(c => !c.type);
  const hasPrefixWE = graph.weConstraints.some(c => c.type === 'prefix');
  const hasLength = graph.edges.some(e => e.minLength != null || e.maxLength != null);
  return { hasWE, hasPrefixWE, hasLength };
}

/**
 * Build a query JSON with constraints toggled on/off per the toggle state.
 */
export function buildToggledQueryJSON(
  graph: QueryGraph,
  toggles: ConstraintToggles,
): Record<string, unknown> {
  // Filter WE constraints based on toggles
  const filteredWE = graph.weConstraints.filter(c => {
    if (c.type === 'prefix') return toggles.prefixEnabled;
    return toggles.weEnabled;
  });

  // Apply length override
  const edges = graph.edges.map(e => {
    if (toggles.maxLength != null) {
      return { ...e, minLength: undefined, maxLength: toggles.maxLength };
    }
    return e;
  });

  const modified: QueryGraph = {
    vertices: graph.vertices,
    edges,
    weConstraints: filteredWE,
    inequalities: graph.inequalities,
  };
  return buildQueryJSON(modified);
}

/**
 * Build a "plain" QueryGraph — same structure, only constraints removed.
 * Strips: word equality, prefix WE, and length bounds (min/maxLength).
 * Keeps: all vertices, all edges, all regex patterns.
 */
export function buildPlainGraph(graph: QueryGraph): QueryGraph {
  return {
    vertices: graph.vertices,
    edges: graph.edges.map(e => ({
      ...e,
      minLength: undefined,
      maxLength: undefined,
    })),
    weConstraints: [],
    // Inequalities are structural (not WE/length constraints) — keep them
    inequalities: graph.inequalities,
  };
}

/**
 * Build a "plain" query JSON with ALL constraints stripped.
 */
export function buildPlainQueryJSON(graph: QueryGraph): Record<string, unknown> {
  return buildQueryJSON(buildPlainGraph(graph));
}
