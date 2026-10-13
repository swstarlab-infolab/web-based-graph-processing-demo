/* ------------------------------------------------------------------ *
 *  Shared sample-path primitives                                       *
 *                                                                      *
 *  ONE vertex circle and ONE edge chip for every place a sample path is *
 *  drawn: the plain RPQ row and the CRPQ chain row (PathDiagram) and the *
 *  hop-aligned WE pair grid (WEPairBlock).                              *
 *                                                                      *
 *  Two rules make this file worth having:                               *
 *   1. Every size is emitted as an INLINE px style, never as a tailwind  *
 *      class, so the geometry is deterministic and can be read straight  *
 *      back out of the rendered markup by the headless geometry checks.  *
 *   2. A vertex is colored by its TYPE, with the same theme-aware pair   *
 *      of palettes the graph canvas uses (graphColors.getNodeColor /     *
 *      getNodeDeepColor). The same vertex therefore has the same color   *
 *      in the path list and in the graph beside it.                      *
 * ------------------------------------------------------------------ */
import type { CSSProperties, FC } from 'react';
import { getNodeColor, getNodeDeepColor } from '../../utils/graphColors';

/** The single token set. Anything that lays out next to a primitive reads its
 *  spacing from here so rings, arrows and grid gaps stay in step. */
export const PATH_TOKENS = {
  /** bound query variable */
  vertex: 26,
  vertexFont: 11,
  /** witness waypoint — a real vertex, but not bound to a query variable */
  vertexSm: 19,
  vertexFontSm: 9,
  vertexBorder: 1.5,
  /** vid caption under a circle (showFullLabels) */
  captionFont: 9,
  captionGap: 2,
  /** arrow glyph, and the breathing room on each side of it. Must stay >=
   *  ringSpread so a ringed circle never paints into a neighbouring glyph. */
  arrowFont: 11,
  hopGap: 4,
  /** hop label ("KNOWS") under / inside an edge chip */
  labelFont: 10,
  /** the two stacked labels of a mismatched hop */
  labelFontSm: 9,
  /** prefix-WE freeze point: 2px ring, 1.5px transparent gap. `outline` +
   *  `outline-offset` shows the real surface through the gap — a box-shadow
   *  "mask" ring has to guess the card color and always gets it wrong on
   *  hover / solo. */
  ringWidth: 2,
  ringOffset: 1.5,
  /** CRPQ chain junction / cycle closure */
  closureRingWidth: 1.5,
  closureRingOffset: 1.5,
  /** WE pair grid: P1 row -> P2 row, and P2 row -> shared-label row. One value
   *  for both gaps and both source modes. */
  weRowGap: 16,
  /** PathDiagram: gap between wrapped lines */
  wrapGap: 6,
} as const;

/** Ink painted outside a circle's border box by each ring style. */
export const RING_SPREAD = PATH_TOKENS.ringWidth + PATH_TOKENS.ringOffset;
export const CLOSURE_RING_SPREAD = PATH_TOKENS.closureRingWidth + PATH_TOKENS.closureRingOffset;

/** Vertex accent — identical to ForceGraphCytoscape's `accentFor`. */
export function vertexAccent(typeName: string, isDark: boolean): string {
  return isDark ? getNodeColor(typeName) : getNodeDeepColor(typeName);
}

/** Muted ink for hop labels, arrows and captions. Theme-aware in every
 *  context (the plain rows used to hard-code slate-500 in both themes). */
export function mutedInk(isDark: boolean): string {
  return isDark ? '#94a3b8' : '#64748b';
}

/** Ink for an element grayed out by a `length_exceeded` annotation. */
export function dimInk(isDark: boolean): string {
  return isDark ? '#4b5563' : '#9ca3af';
}

/** Fill/border color of a circle grayed out by `length_exceeded`. */
export function dimVertexInk(isDark: boolean): string {
  return isDark ? '#4b5563' : '#d1d5db';
}

export const VIOLATION_INK = '#ef4444';

export type VertexRing = 'terminal' | 'closure' | null;

export interface VertexCircleProps {
  /** Vertex type name ("Person"); '' falls back to the neutral slate accent. */
  typeName: string;
  /** Vertex id, used for the caption and the default title. */
  vid: string;
  isDark: boolean;
  /** 'sm' = witness waypoint (smaller, dashed, faded). */
  size?: 'md' | 'sm';
  /** length_exceeded → gray + faded */
  dim?: boolean;
  ring?: VertexRing;
  /** Ring color; defaults to the vertex accent. */
  ringColor?: string;
  title?: string;
  /** Render the numeric vid under the circle (showFullLabels). */
  showCaption?: boolean;
  className?: string;
}

/** The one vertex circle. */
export const VertexCircle: FC<VertexCircleProps> = ({
  typeName, vid, isDark, size = 'md', dim = false, ring = null, ringColor,
  title, showCaption = false, className = '',
}) => {
  const sm = size === 'sm';
  const c = dim ? dimVertexInk(isDark) : vertexAccent(typeName, isDark);
  const px = sm ? PATH_TOKENS.vertexSm : PATH_TOKENS.vertex;
  const initial = typeName ? typeName[0].toUpperCase() : 'v';
  const style: CSSProperties = {
    width: px, height: px,
    fontSize: sm ? PATH_TOKENS.vertexFontSm : PATH_TOKENS.vertexFont,
    lineHeight: 1,
    backgroundColor: c + (sm ? '14' : '20'),
    color: c,
    border: `${PATH_TOKENS.vertexBorder}px ${sm ? 'dashed' : 'solid'} ${c}${sm ? '45' : '60'}`,
    opacity: dim ? 0.4 : sm ? 0.72 : 1,
    // Rings paint outside the border box; keep the circle above the WE grid's
    // dotted linking connector and above any neighbouring ring.
    position: 'relative',
    zIndex: 1,
  };
  if (ring === 'terminal') {
    style.outline = `${PATH_TOKENS.ringWidth}px solid ${ringColor ?? c}`;
    style.outlineOffset = PATH_TOKENS.ringOffset;
  } else if (ring === 'closure') {
    style.outline = `${PATH_TOKENS.closureRingWidth}px solid ${ringColor ?? c}55`;
    style.outlineOffset = PATH_TOKENS.closureRingOffset;
  }
  const circle = (
    <span
      className={`path-vertex-dot inline-flex items-center justify-center rounded-full font-bold cursor-default shrink-0${className ? ` ${className}` : ''}`}
      style={style}
      title={title}
    >
      {initial}
    </span>
  );
  if (!showCaption) return circle;
  return (
    <span
      className="path-vertex inline-flex flex-col items-center shrink-0"
      style={{ gap: PATH_TOKENS.captionGap }}
    >
      {circle}
      <span
        className="path-vertex-caption font-mono select-none"
        style={{ fontSize: PATH_TOKENS.captionFont, lineHeight: 1, color: mutedInk(isDark) }}
      >
        {vid}
      </span>
    </span>
  );
};

export type EdgeTone = 'normal' | 'violation' | 'dim' | 'linking';

function edgeInk(tone: EdgeTone, isDark: boolean): string {
  if (tone === 'violation') return VIOLATION_INK;
  if (tone === 'dim') return dimInk(isDark);
  // 'linking' is structure, not one of the compared paths: the edge that joins
  // P1's source to P2's in a different-source word equality. Neutral ink plus
  // the dashed glyph below keeps it legible without competing with P1/P2.
  if (tone === 'linking') return dimInk(isDark);
  return mutedInk(isDark);
}

export interface EdgeChipProps {
  label: string;
  reversed?: boolean;
  isDark: boolean;
  tone?: EdgeTone;
  /** false → arrow glyph only; the label is then named by `badge` + a legend
   *  (WE grid) instead of being written inline. */
  showLabel?: boolean;
  title?: string;
  /** Ink for the normal tone — the per-label colour the graph view uses, so a
   *  KNOWS arrow is the same colour in the list and on the canvas. */
  color?: string;
  /** Legend number drawn above the arrow. Same number ⇒ same label. */
  badge?: number;
}

/** Small numbered ring that names a hop's label via the block legend. One
 *  geometry for the arrow badge and the legend key so they read as the same
 *  mark. */
export const HopBadge: FC<{ n: number; color: string; title?: string }> = ({ n, color, title }) => (
  <span
    className="path-hop-badge inline-flex items-center justify-center shrink-0 font-bold"
    style={{ width: 11, height: 11, borderRadius: 99, border: `1px solid ${color}`, color, fontSize: 7, lineHeight: '9px' }}
    title={title}
  >
    {n}
  </span>
);

/** Legend for badge-numbered arrows: "① HAS_INTEREST  ② HAS_TYPE", each in
 *  its label colour. */
export const EdgeLegend: FC<{ entries: Array<{ n: number; label: string; color: string }>; isDark: boolean }> = ({ entries }) => (
  <div className="we-hop-legend flex flex-wrap items-center font-mono" style={{ gap: '4px 12px', fontSize: PATH_TOKENS.labelFont, lineHeight: 1, paddingLeft: 6 }}>
    {entries.map((e) => (
      <span key={e.n} className="we-hop-legend-item inline-flex items-center" style={{ gap: 3, color: e.color }} title={e.label}>
        <HopBadge n={e.n} color={e.color} />
        <span className="font-medium">{e.label}</span>
      </span>
    ))}
  </div>
);

/** The one edge form: "→LABEL→", or a bare "→" when the label lives elsewhere.
 *  A `reversed` hop draws "←…←" — the data runs right to left there and a "→"
 *  would assert an edge that does not exist. A violation swaps the closing
 *  arrow for a red "≠". */
export const EdgeChip: FC<EdgeChipProps> = ({
  label, reversed = false, isDark, tone = 'normal', showLabel = true, title, color, badge,
}) => {
  const ink = tone === 'normal' && color ? color : edgeInk(tone, isDark);
  // A dashed arrow for the connective edge, so "not part of either path" is
  // carried by the mark itself rather than by colour alone.
  const arrow = tone === 'linking'
    ? (reversed ? '⇠' : '⇢')
    : (reversed ? '←' : '→');
  const arrowStyle: CSSProperties = { fontSize: PATH_TOKENS.arrowFont, lineHeight: 1 };
  const hoverTitle = title ?? (reversed ? `${label} (reads right to left)` : label);
  if (!showLabel) {
    // Badge stacked ABOVE the arrow: 11 + 1 + 11 = 23px tall, inside the 26px
    // vertex row, so numbering a hop costs no row height and no column width.
    return (
      <span
        className="path-edge-arrow inline-flex flex-col items-center justify-center cursor-default shrink-0"
        style={{
          color: ink,
          opacity: tone === 'dim' ? 0.4 : tone === 'linking' ? 0.7 : 1,
          marginLeft: PATH_TOKENS.hopGap,
          marginRight: PATH_TOKENS.hopGap,
          gap: 1,
        }}
        title={hoverTitle}
      >
        {badge != null && <HopBadge n={badge} color={ink} />}
        <span className="font-bold" style={arrowStyle}>{tone === 'violation' ? '≠' : arrow}</span>
      </span>
    );
  }
  return (
    <span
      className="path-edge-chip inline-flex items-center cursor-default shrink-0"
      style={{ color: ink, opacity: tone === 'dim' ? 0.4 : tone === 'linking' ? 0.7 : 1, lineHeight: 1 }}
      title={hoverTitle}
    >
      <span style={arrowStyle}>{arrow}</span>
      <span
        className="path-edge-label font-medium"
        style={{ fontSize: PATH_TOKENS.labelFont, lineHeight: 1, marginLeft: 1, marginRight: 1 }}
      >
        {label}
      </span>
      <span style={arrowStyle}>{tone === 'violation' ? '≠' : arrow}</span>
    </span>
  );
};

/** A hop label written on its own (the WE grid's shared-label row). Same font
 *  and same ink as the label inside an EdgeChip. */
export const HopLabel: FC<{
  label: string; isDark: boolean; tone?: EdgeTone; faded?: boolean; title?: string;
  className?: string; style?: CSSProperties;
}> = ({ label, isDark, tone = 'normal', faded = false, title, className = '', style }) => (
  <span
    className={`path-hop-label font-medium cursor-default${className ? ` ${className}` : ''}`}
    style={{
      fontSize: PATH_TOKENS.labelFont, lineHeight: 1,
      color: edgeInk(tone, isDark),
      opacity: tone === 'dim' ? 0.4 : faded ? 0.6 : 1,
      ...style,
    }}
    title={title ?? label}
  >
    {label}
  </span>
);
