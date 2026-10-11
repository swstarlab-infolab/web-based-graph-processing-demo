import type { CSSProperties } from 'react';

/** Semantic vertex type colors — shared by ForceGraph, PathList, QueryCanvas.
 *  Pastel tier: tuned for dark canvases (borders, glyphs, glows). */
export const VERTEX_TYPE_COLORS: Record<string, string> = {
  Person:     '#93c5fd',  // blue-300 pastel
  Post:       '#86efac',  // green-300 pastel
  Comment:    '#fdba74',  // orange-300 pastel
  Tag:        '#f9a8d4',  // pink-300 pastel
  Forum:      '#c4b5fd',  // violet-300 pastel
  University: '#fde68a',  // amber-200 pastel
  Company:    '#7dd3fc',  // sky-300 pastel
  City:       '#6ee7b7',  // emerald-300 pastel
  Country:    '#5eead4',  // teal-300 pastel
  Continent:  '#a5b4fc',  // indigo-300 pastel
  TagClass:   '#f0abfc',  // fuchsia-300 pastel
  Place:      '#cbd5e1',  // slate-300 pastel
  Message:    '#d1d5db',  // gray-300 pastel
};

/** Saturated tier: same hues at 500-600 weight, legible on light canvases. */
export const VERTEX_TYPE_COLORS_DEEP: Record<string, string> = {
  Person:     '#2563eb',  // blue-600
  Post:       '#16a34a',  // green-600
  Comment:    '#ea580c',  // orange-600
  Tag:        '#db2777',  // pink-600
  Forum:      '#7c3aed',  // violet-600
  University: '#d97706',  // amber-600
  Company:    '#0284c7',  // sky-600
  City:       '#059669',  // emerald-600
  Country:    '#0d9488',  // teal-600
  Continent:  '#4f46e5',  // indigo-600
  TagClass:   '#c026d3',  // fuchsia-600
  Place:      '#475569',  // slate-600
  Message:    '#4b5563',  // gray-600
};

export const VERTEX_COLOR_FALLBACK = '#94a3b8';
export const VERTEX_COLOR_FALLBACK_DEEP = '#64748b';

/** Pastel color for a vertex type (dark-canvas tier — the historical default). */
export function getNodeColor(type: string): string {
  return VERTEX_TYPE_COLORS[type] ?? VERTEX_COLOR_FALLBACK;
}

/** Saturated color for a vertex type — use for borders/text on light canvases. */
export function getNodeDeepColor(type: string): string {
  return VERTEX_TYPE_COLORS_DEEP[type] ?? VERTEX_COLOR_FALLBACK_DEEP;
}

/* ---- word-equality role colors (P1 blue / P2 pink, everywhere) ---- */

export const WE_P1_COLOR = '#60a5fa';       // blue-400 — dark canvases
export const WE_P1_COLOR_DEEP = '#2563eb';  // blue-600 — light canvases
export const WE_P2_COLOR = '#f472b6';       // pink-400
export const WE_P2_COLOR_DEEP = '#db2777';  // pink-600

export function weRoleColor(role: 'path1' | 'path2', isDark = true): string {
  if (role === 'path1') return isDark ? WE_P1_COLOR : WE_P1_COLOR_DEEP;
  return isDark ? WE_P2_COLOR : WE_P2_COLOR_DEEP;
}

/* ---- edge label colors (same label → same color everywhere) ---- */

const EDGE_LABEL_PALETTE_DARK = [
  '#22d3ee', // cyan
  '#a78bfa', // violet
  '#fbbf24', // amber
  '#34d399', // emerald
  '#fb923c', // orange
  '#60a5fa', // blue
  '#f472b6', // pink
  '#e879f9', // fuchsia
];
const EDGE_LABEL_PALETTE_LIGHT = [
  '#0891b2', // cyan-600
  '#7c3aed', // violet-600
  '#d97706', // amber-600
  '#059669', // emerald-600
  '#ea580c', // orange-600
  '#2563eb', // blue-600
  '#db2777', // pink-600
  '#c026d3', // fuchsia-600
];

export function edgeLabelColor(label: string, isDark = true): string {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = ((h << 5) - h + label.charCodeAt(i)) | 0;
  const palette = isDark ? EDGE_LABEL_PALETTE_DARK : EDGE_LABEL_PALETTE_LIGHT;
  return palette[Math.abs(h) % palette.length];
}

/* ---- shared canvas surface ---- */

/** Base canvas colors — also used to mask label chips over the dot grid. */
export const GRAPH_BG_DARK = '#0b1322';
export const GRAPH_BG_LIGHT = '#f8fafc';

/**
 * Signature surface for every graph canvas: an engineering dot grid under a
 * faint cyan glow, so the query editor and result view read as one instrument.
 */
export function graphCanvasBackground(isDark: boolean): CSSProperties {
  return isDark
    ? {
        backgroundColor: GRAPH_BG_DARK,
        backgroundImage: [
          'radial-gradient(ellipse 80% 50% at 50% -10%, rgba(34,211,238,0.06), transparent 70%)',
          'radial-gradient(circle, rgba(148,163,184,0.13) 1px, transparent 1.5px)',
        ].join(', '),
        backgroundSize: '100% 100%, 24px 24px',
      }
    : {
        backgroundColor: GRAPH_BG_LIGHT,
        backgroundImage: [
          'radial-gradient(ellipse 80% 50% at 50% -10%, rgba(8,145,178,0.05), transparent 70%)',
          'radial-gradient(circle, rgba(100,116,139,0.18) 1px, transparent 1.5px)',
        ].join(', '),
        backgroundSize: '100% 100%, 24px 24px',
      };
}

/** Shared styling for the floating zoom/fit/layout buttons on graph canvases. */
export function graphToolbarButtonClass(isDark: boolean): string {
  return `w-8 h-8 border rounded-lg flex items-center justify-center transition-colors shadow-sm backdrop-blur-sm ${
    isDark
      ? 'bg-gray-900/70 hover:bg-gray-800/90 border-gray-700/70 text-gray-400 hover:text-white'
      : 'bg-white/80 hover:bg-white border-gray-300/80 text-gray-500 hover:text-gray-800'
  }`;
}
