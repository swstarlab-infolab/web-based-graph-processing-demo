import {
  useRef, useEffect, useState, useCallback, useMemo,
  type FC, type MutableRefObject,
} from 'react';
import cytoscape from 'cytoscape';
// @ts-ignore — no type declarations for cytoscape-elk
import elk from 'cytoscape-elk';
import type { QueryVertex, QueryEdge, WEConstraint, Schema } from '../../types';
import EdgeLabelPopover from './EdgeLabelPopover';
import VertexLabelDropdown from './VertexLabelDropdown';
import {
  VERTEX_TYPE_COLORS, VERTEX_TYPE_COLORS_DEEP,
  VERTEX_COLOR_FALLBACK, VERTEX_COLOR_FALLBACK_DEEP,
  WE_P1_COLOR, WE_P1_COLOR_DEEP, WE_P2_COLOR, WE_P2_COLOR_DEEP,
  GRAPH_BG_DARK, GRAPH_BG_LIGHT,
  graphCanvasBackground, graphToolbarButtonClass,
} from '../../utils/graphColors';
import { safeDestroyCy, runElkLayout } from '../../utils/cySafeLayout';

cytoscape.use(elk);

/** ELK layout options for QueryCanvas — layered RIGHT with ample between-layer spacing for long edge labels. */
const COLA_LAYOUT_OPTS = {
  name: 'elk',
  elk: {
    algorithm: 'layered',
    'elk.direction': 'RIGHT',
    'elk.spacing.nodeNode': '120',
    'elk.layered.spacing.nodeNodeBetweenLayers': '320',
    'elk.spacing.edgeNode': '60',
    'elk.spacing.edgeEdge': '40',
    'elk.edgeLabels.inline': 'true',
    'elk.layered.edgeLabels.sideSelection': 'SMART_UP',
    'elk.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
    'elk.layered.spacing.edgeEdgeBetweenLayers': '30',
    'elk.layered.spacing.edgeNodeBetweenLayers': '50',
  },
  fit: true,
  padding: 60,
  animate: false,
} as any;

// Constraint highlight colors (dark / light tiers for canvas legibility);
// P1/P2 hues come from the shared theme so canvas, path list, and result
// graph all encode the equality pair the same way.
const EDGE_DEFAULT_LIGHT = '#94a3b8';
const EDGE_DEFAULT_DARK = '#64748b';
const EDGE_P1_COLOR = WE_P1_COLOR;
const EDGE_P1_COLOR_LIGHT = WE_P1_COLOR_DEEP;
const EDGE_P2_COLOR = WE_P2_COLOR;
const EDGE_P2_COLOR_LIGHT = WE_P2_COLOR_DEEP;
const EDGE_LENGTH = '#fbbf24';         // amber — length constraint (dark canvas)
const EDGE_LENGTH_LIGHT = '#d97706';   // amber-600

interface QueryCanvasProps {
  vertices: QueryVertex[];
  edges: QueryEdge[];
  weConstraints: WEConstraint[];
  schema: Schema;
  onAddVertex: (label: string, position: { x: number; y: number }) => string;
  onUpdateVertex: (id: string, label: string) => void;
  onAddEdge: (source: string, target: string) => string;
  onUpdateEdge: (id: string, props: Partial<Omit<QueryEdge, 'id'>>) => void;
  onRemoveElement: (id: string) => void;
  onMoveVertex?: (id: string, position: { x: number; y: number }) => void;
  onFitRef?: MutableRefObject<(() => void) | null>;
  layoutKey?: number;
  isDark?: boolean;
  /** Read-only mode: disables all editing interactions and node dragging */
  readOnly?: boolean;
  /** Compact mode: reduces padding/font for small preview containers */
  compact?: boolean;
}

function edgeDisplayLabel(edge: QueryEdge, showAutomataName: boolean): string {
  const quantSuffix = edge.quantifier === '1' ? '' : edge.quantifier;
  const altText = edge.alternateLabels?.length
    ? `(${edge.label}|${edge.alternateLabels.join('|')})`
    : edge.label.replace(/\//g, '→');
  const dirPrefix = edge.direction === 'reverse' ? '\u2190' : '';
  let lenSuffix = '';
  if (edge.minLength != null || edge.maxLength != null) {
    const min = edge.minLength != null ? String(edge.minLength) : '';
    const max = edge.maxLength != null ? String(edge.maxLength) : '';
    lenSuffix = `[${min}..${max}]`;
  }
  const body = `${dirPrefix}${altText}${quantSuffix}${lenSuffix}`;
  return showAutomataName && edge.automataName ? `${edge.automataName}: ${body}` : body;
}

const QueryCanvas: FC<QueryCanvasProps> = ({
  vertices,
  edges,
  weConstraints,
  schema,
  onAddVertex,
  onUpdateVertex,
  onAddEdge,
  onUpdateEdge,
  onRemoveElement,
  onMoveVertex,
  onFitRef,
  isDark = true,
  readOnly = false,
  compact = false,
  layoutKey,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const localPosRef = useRef<Record<string, { x: number; y: number }>>({});

  const [editingEdge, setEditingEdge] = useState<{
    edge: QueryEdge; position: { x: number; y: number };
  } | null>(null);
  const [editingVertex, setEditingVertex] = useState<{
    vertexId: string; currentLabel: string; position: { x: number; y: number };
  } | null>(null);

  // Edge draw mode: click handle on node → click target node, or drag handle to target
  const [drawingFrom, setDrawingFrom] = useState<string | null>(null);
  const drawingFromRef = useRef<string | null>(null);
  drawingFromRef.current = drawingFrom;

  // Drag line for visual feedback during edge drag
  const [dragLine, setDragLine] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const dragLineRef = useRef<typeof dragLine>(null);
  dragLineRef.current = dragLine;

  // Hover info for edge handle overlay
  const [hoveredNodeHandle, setHoveredNodeHandle] = useState<{
    nodeId: string; x: number; y: number;
  } | null>(null);

  const d = isDark;
  const bg = d ? GRAPH_BG_DARK : GRAPH_BG_LIGHT;

  // Edges involved in word-equality constraints — maps edge ID → { role, type }
  const weRole = useMemo(() => {
    const m = new Map<string, { role: 'p1' | 'p2'; type: 'we' | 'prefix' }>();
    weConstraints.forEach(wec => {
      const t = (wec.type ?? 'we') as 'we' | 'prefix';
      m.set(wec.edge1Id, { role: 'p1', type: t });
      m.set(wec.edge2Id, { role: 'p2', type: t });
    });
    return m;
  }, [weConstraints]);

  // Edges with length constraints
  const hasLenConstraint = useMemo(() => {
    const s = new Set<string>();
    edges.forEach(e => { if (e.minLength != null || e.maxLength != null) s.add(e.id); });
    return s;
  }, [edges]);

  // Structural key for rebuild detection (positions excluded)
  const structureKey = [
    vertices.map(v => `${v.id}:${v.label}`).join('|'),
    edges.map(e => `${e.id}:${e.source}->${e.target}:${e.label}:${e.quantifier}:${e.direction}:${e.alternateLabels?.join(',') ?? ''}:${e.minLength ?? ''}:${e.maxLength ?? ''}`).join('|'),
    weConstraints.map(wec => `${wec.edge1Id}=${wec.edge2Id}:${wec.type ?? ''}`).join('|'),
  ].join(';;');

  // Keep localPos in sync when vertex set changes (new vertex added / removed)
  const prevStructureKey = useRef('');
  useEffect(() => {
    if (prevStructureKey.current === structureKey) return;
    prevStructureKey.current = structureKey;
    const cur = localPosRef.current;
    const next: Record<string, { x: number; y: number }> = {};
    vertices.forEach(v => { next[v.id] = cur[v.id] ?? { ...v.position }; });
    localPosRef.current = next;
  }, [structureKey, vertices]);

  // Build and mount Cytoscape
  useEffect(() => {
    if (!containerRef.current) return;
    safeDestroyCy(cyRef.current);

    const cyNodes: cytoscape.ElementDefinition[] = vertices.map(v => {
      const label = v.label || 'Any';
      // Type-colored vertices, matching the result graph ('Any' stays neutral)
      const color = d
        ? (VERTEX_TYPE_COLORS[label] ?? VERTEX_COLOR_FALLBACK)
        : (VERTEX_TYPE_COLORS_DEEP[label] ?? VERTEX_COLOR_FALLBACK_DEEP);
      const pos = localPosRef.current[v.id] ?? v.position;
      return {
        group: 'nodes',
        data: { id: v.id, typeLabel: label, color },
        position: { x: pos.x, y: pos.y },
      };
    });

    const cyEdges: cytoscape.ElementDefinition[] = edges.map(edge => {
      const info = weRole.get(edge.id);
      const hasLen = hasLenConstraint.has(edge.id);
      const neutral = d ? EDGE_DEFAULT_DARK : EDGE_DEFAULT_LIGHT;
      const color = info
        ? (info.role === 'p1'
            ? (d ? EDGE_P1_COLOR : EDGE_P1_COLOR_LIGHT)
            : (d ? EDGE_P2_COLOR : EDGE_P2_COLOR_LIGHT))
        : hasLen ? (d ? EDGE_LENGTH : EDGE_LENGTH_LIGHT)
        : neutral;
      const lineDash = info?.role === 'p2' ? 'dashed' : 'solid';
      const isWe = !!info;
      // Prefix WE edges with P1/P2 (or P1₁/P2₁ for multi-constraint)
      const baseLabel = edgeDisplayLabel(edge, false);
      const wePrefix = info
        ? (() => {
            const role = info.role === 'p1' ? 'P1' : 'P2';
            // Find which constraint index this edge belongs to
            const cIdx = weConstraints.findIndex(wec =>
              (info.role === 'p1' ? wec.edge1Id : wec.edge2Id) === edge.id
            );
            return weConstraints.length > 1 ? `${role}${String.fromCharCode(0x2081 + cIdx)}: ` : `${role}: `;
          })()
        : '';
      const label = `${wePrefix}${baseLabel}`;
      const isSelf = edge.source === edge.target;
      return {
        group: 'edges',
        data: { id: edge.id, source: edge.source, target: edge.target, label, color, selfLoop: isSelf ? 'true' : 'false', lineDash, isWe: isWe ? 'true' : 'false' },
      };
    });

    const cy = cytoscape({
      container: containerRef.current,
      elements: [...cyNodes, ...cyEdges],
      autoungrabify: readOnly,
      autounselectify: readOnly,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'data(color)',
            'background-opacity': d ? 0.16 : 0.12,
            'border-color': 'data(color)',
            'border-width': compact ? 1.5 : 2.5,
            'color': 'data(color)',
            'label': 'data(typeLabel)',
            'text-valign': 'bottom' as any,
            'text-halign': 'center' as any,
            'text-margin-y': compact ? 2 : 5,
            'font-size': compact ? '11px' : '15px',
            'font-family': 'ui-sans-serif, system-ui, sans-serif',
            'font-weight': 600 as any,
            'text-wrap': 'wrap' as any,
            'text-max-width': compact ? '80px' : '140px',
            'text-background-color': bg,
            'text-background-opacity': 0.9,
            'text-background-shape': 'round-rectangle' as any,
            'text-background-padding': compact ? '1px' : '3px',
            'width': compact ? 22 : 44,
            'height': compact ? 22 : 44,
            'underlay-color': 'data(color)' as any,
            'underlay-opacity': (d ? 0.08 : 0.06) as any,
            'underlay-padding': 0 as any,
            'underlay-shape': 'ellipse' as any,
            'overlay-opacity': 0,
          },
        },
        {
          selector: 'node.selected',
          style: {
            'border-width': 3.5,
            'background-opacity': d ? 0.35 : 0.25,
            'underlay-opacity': 0.22,
            'underlay-padding': 0,
            'width': 48,
            'height': 48,
          } as any,
        },
        {
          selector: 'node.draw-target',
          style: {
            'border-width': 3.5,
            'background-opacity': 0.5,
            'border-style': 'dashed' as any,
            'underlay-opacity': 0.2 as any,
          },
        },
        {
          selector: 'edge',
          style: {
            'line-color': 'data(color)',
            'line-cap': 'round' as any,
            'target-arrow-color': 'data(color)',
            'target-arrow-shape': 'triangle-backcurve' as any,
            'arrow-scale': compact ? 0.7 : 1.0,
            'curve-style': 'bezier' as any,
            'control-point-step-size': 70,
            'line-style': 'data(lineDash)' as any,
            'line-dash-pattern': [6, 4] as any,
            'width': compact ? 1.5 : 2,
            'label': 'data(label)',
            'font-size': compact ? '10px' : '14px',
            'font-family': 'ui-monospace, monospace',
            'color': 'data(color)',
            'text-rotation': 'autorotate' as any,
            'text-wrap': 'wrap' as any,
            'text-max-width': compact ? '80px' : '240px',
            'text-background-color': bg,
            'text-background-opacity': 0.92,
            'text-background-shape': 'round-rectangle' as any,
            'text-background-padding': compact ? '1px' : '4px',
            'overlay-opacity': 0,
          },
        },
        {
          selector: 'edge[isWe = "true"]',
          style: {
            'width': compact ? 2.5 : 3,
            'underlay-color': 'data(color)',
            'underlay-opacity': d ? 0.14 : 0.1,
            'underlay-padding': compact ? 2 : 4,
            'font-weight': 700 as any,
          } as any,
        },
        {
          selector: 'edge[selfLoop = "true"]',
          style: { 'curve-style': 'bezier' as any },
        },
        {
          selector: 'edge.selected',
          style: { width: 3.5, 'line-style': 'solid' } as any,
        },
      ],
      layout: { name: 'preset', fit: true, padding: compact ? 5 : 80 } as any,
      userZoomingEnabled: !compact,
      userPanningEnabled: !compact,
    });

    // Cap initial zoom so small queries don't appear overly zoomed-in
    if (!compact && cy.zoom() > 0.9) {
      cy.zoom(0.9);
      cy.center();
    }
    // Compact: fit tightly (container has fixed dimensions, no delayed refit needed)
    if (compact) {
      cy.fit(undefined, 5);
      cy.center();
      cyRef.current = cy;
      if (readOnly) return () => { safeDestroyCy(cy); cyRef.current = null; };
    }

    cyRef.current = cy;

    if (readOnly) {
      return () => { safeDestroyCy(cy); cyRef.current = null; };
    }

    // ── Debounce tap to distinguish single tap from dblclick
    let tapTimer: ReturnType<typeof setTimeout> | null = null;
    const clearTapTimer = () => { if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; } };

    // Node single tap → start or complete edge draw
    cy.on('tap', 'node', (evt) => {
      clearTapTimer();
      const n = evt.target;
      const nodeId = n.id() as string;
      if (drawingFromRef.current) {
        // In draw mode: complete edge to this node
        const from = drawingFromRef.current;
        if (from !== nodeId) {
          const edgeId = onAddEdge(from, nodeId);
          const rp = evt.renderedPosition;
          const qEdge: QueryEdge = { id: edgeId, source: from, target: nodeId, label: 'KNOWS', quantifier: '1', direction: 'forward', automataName: '' };
          setEditingEdge({ edge: qEdge, position: { x: rp.x + 10, y: rp.y - 20 } });
          setEditingVertex(null);
        }
        setDrawingFrom(null);
        cy.nodes().removeClass('draw-target');
        return;
      }
      // Start edge draw from this node
      tapTimer = setTimeout(() => {
        setDrawingFrom(nodeId);
        setEditingEdge(null);
        setEditingVertex(null);
        cy.elements().removeClass('selected');
        n.addClass('selected');
        tapTimer = null;
      }, 180);
    });

    // Node double tap → edit vertex label
    cy.on('dbltap', 'node', (evt) => {
      clearTapTimer();
      const rp = evt.renderedPosition;
      const n = evt.target;
      cy.elements().removeClass('selected');
      n.addClass('selected');
      setDrawingFrom(null);
      cy.nodes().removeClass('draw-target');
      setEditingVertex({ vertexId: n.id(), currentLabel: n.data('typeLabel') as string, position: { x: rp.x + 10, y: rp.y - 20 } });
      setEditingEdge(null);
    });

    // Edge tap → edit edge
    cy.on('tap', 'edge', (evt) => {
      if (drawingFromRef.current) { setDrawingFrom(null); cy.nodes().removeClass('draw-target'); return; }
      clearTapTimer();
      const rp = evt.renderedPosition;
      const eId = evt.target.id() as string;
      const qEdge = edges.find(e => e.id === eId);
      if (!qEdge) return;
      cy.elements().removeClass('selected');
      evt.target.addClass('selected');
      setEditingEdge({ edge: qEdge, position: { x: rp.x + 10, y: rp.y - 20 } });
      setEditingVertex(null);
    });

    // Background tap → clear selection / cancel draw
    cy.on('tap', (evt) => {
      if (evt.target !== cy) return;
      clearTapTimer();
      if (drawingFromRef.current) {
        setDrawingFrom(null);
        cy.nodes().removeClass('draw-target');
        return;
      }
      cy.elements().removeClass('selected');
      setEditingEdge(null);
      setEditingVertex(null);
    });

    // Background double-tap → add vertex
    cy.on('dbltap', (evt) => {
      if (evt.target !== cy) return;
      clearTapTimer();
      const pos = evt.position;
      const rp = evt.renderedPosition;
      const id = onAddVertex('Any', { x: pos.x, y: pos.y });
      localPosRef.current[id] = { x: pos.x, y: pos.y };
      setEditingVertex({ vertexId: id, currentLabel: 'Any', position: { x: rp.x + 10, y: rp.y - 20 } });
      setEditingEdge(null);
    });

    // Node hover → show edge handle
    cy.on('mouseover', 'node', (evt) => {
      if (drawingFromRef.current) return;
      const n = evt.target;
      const bb = n.renderedBoundingBox();
      setHoveredNodeHandle({
        nodeId: n.id() as string,
        x: bb.x2 + 2,
        y: (bb.y1 + bb.y2) / 2,
      });
    });
    cy.on('mouseout', 'node', () => {
      if (!drawingFromRef.current) setHoveredNodeHandle(null);
    });

    // Save position on grab so we can restore if dropped on another node
    cy.on('grab', 'node', (evt) => {
      const n = evt.target;
      const p = n.position();
      n.data('_grabX', p.x);
      n.data('_grabY', p.y);
    });

    // During drag: highlight target node when dragged node overlaps it
    cy.on('drag', 'node', (evt) => {
      const n = evt.target;
      const pos = n.position();
      const id = n.id() as string;
      cy.nodes().forEach((other: cytoscape.NodeSingular) => {
        if (other.id() === id) return;
        const bb = other.boundingBox();
        if (pos.x >= bb.x1 && pos.x <= bb.x2 && pos.y >= bb.y1 && pos.y <= bb.y2) {
          other.addClass('draw-target');
        } else {
          other.removeClass('draw-target');
        }
      });
    });

    // Node dragend → create edge if dropped on another node, else update position
    cy.on('dragend', 'node', (evt) => {
      const n = evt.target;
      const pos = n.position();
      const id = n.id() as string;

      // Check if dropped on another node
      let targetNode: cytoscape.NodeSingular | null = null;
      cy.nodes().forEach((other: cytoscape.NodeSingular) => {
        if (other.id() === id) return;
        const bb = other.boundingBox();
        if (pos.x >= bb.x1 && pos.x <= bb.x2 && pos.y >= bb.y1 && pos.y <= bb.y2) {
          targetNode = other;
        }
      });
      cy.nodes().removeClass('draw-target');

      if (targetNode) {
        // Restore original position
        const gx = n.data('_grabX') as number;
        const gy = n.data('_grabY') as number;
        n.position({ x: gx, y: gy });
        localPosRef.current[id] = { x: gx, y: gy };
        // Create edge
        const targetId = (targetNode as cytoscape.NodeSingular).id();
        const edgeId = onAddEdge(id, targetId);
        const rp = evt.renderedPosition;
        const qEdge: QueryEdge = { id: edgeId, source: id, target: targetId, label: 'KNOWS', quantifier: '1', direction: 'forward', automataName: '' };
        setEditingEdge({ edge: qEdge, position: { x: rp.x + 10, y: rp.y - 20 } });
        setEditingVertex(null);
      } else {
        localPosRef.current[id] = { x: pos.x, y: pos.y };
        onMoveVertex?.(id, { x: pos.x, y: pos.y });
      }
    });

    // During draw mode: highlight potential targets on node hover
    cy.on('mouseover', 'node', (evt) => {
      if (drawingFromRef.current && drawingFromRef.current !== evt.target.id()) {
        evt.target.addClass('draw-target');
      }
    });
    cy.on('mouseout', 'node', (evt) => {
      evt.target.removeClass('draw-target');
    });

    return () => {
      clearTapTimer();
      safeDestroyCy(cy);
      cyRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey, bg, d, compact]);

  // Fit ref
  useEffect(() => {
    if (onFitRef) onFitRef.current = () => cyRef.current?.fit(undefined, 40);
  }, [onFitRef]);

  // Auto layout when a preset is loaded (layoutKey increments).
  // Uses ELK (Eclipse Layout Kernel) for proper edge label placement.
  useEffect(() => {
    if (compact) return;
    const cy = cyRef.current;
    if (!cy || cy.nodes().length === 0) return;
    runElkLayout(cy, COLA_LAYOUT_OPTS, () => {
      if (cy.destroyed()) return;
      cy.fit(undefined, 50);
      const z = cy.zoom();
      const target = Math.min(Math.max(z, 0.6), 1.0);
      cy.zoom(target);
      cy.center();
    });
  }, [layoutKey, compact]);


  // Keyboard: Delete/Backspace removes; Escape cancels draw/editing
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (editingVertex) { onRemoveElement(editingVertex.vertexId); setEditingVertex(null); }
        else if (editingEdge) { onRemoveElement(editingEdge.edge.id); setEditingEdge(null); }
      }
      if (e.key === 'Escape') {
        setEditingEdge(null); setEditingVertex(null);
        setDrawingFrom(null);
        cyRef.current?.nodes().removeClass('draw-target');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editingVertex, editingEdge, onRemoveElement]);

  // Start edge draw mode from handle click / drag
  const startEdgeDraw = useCallback((fromId: string, startEvent?: React.MouseEvent) => {
    setDrawingFrom(fromId);
    setHoveredNodeHandle(null);
    setEditingEdge(null);
    setEditingVertex(null);
    cyRef.current?.nodes().removeClass('draw-target');

    // If initiated via mousedown, start drag line tracking
    if (startEvent && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const x = startEvent.clientX - rect.left;
      const y = startEvent.clientY - rect.top;
      setDragLine({ x1: x, y1: y, x2: x, y2: y });

      const onMouseMove = (e: MouseEvent) => {
        const r = containerRef.current?.getBoundingClientRect();
        if (!r) return;
        setDragLine(prev => prev ? { ...prev, x2: e.clientX - r.left, y2: e.clientY - r.top } : null);
        // Highlight node under cursor
        const cy = cyRef.current;
        if (!cy) return;
        const rx = e.clientX - r.left;
        const ry = e.clientY - r.top;
        cy.nodes().removeClass('draw-target');
        cy.nodes().forEach(n => {
          const bb = n.renderedBoundingBox();
          if (n.id() !== fromId && rx >= bb.x1 && rx <= bb.x2 && ry >= bb.y1 && ry <= bb.y2) {
            n.addClass('draw-target');
          }
        });
      };

      const onMouseUp = (e: MouseEvent) => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        setDragLine(null);

        // Find node under cursor
        const cy = cyRef.current;
        const r = containerRef.current?.getBoundingClientRect();
        if (!cy || !r) { setDrawingFrom(null); cy?.nodes().removeClass('draw-target'); return; }
        const rx = e.clientX - r.left;
        const ry = e.clientY - r.top;
        let targetId: string | null = null;
        cy.nodes().forEach(n => {
          const bb = n.renderedBoundingBox();
          if (n.id() !== fromId && rx >= bb.x1 && rx <= bb.x2 && ry >= bb.y1 && ry <= bb.y2) {
            targetId = n.id();
          }
        });
        cy.nodes().removeClass('draw-target');

        if (targetId) {
          const edgeId = onAddEdge(fromId, targetId);
          const qEdge: QueryEdge = { id: edgeId, source: fromId, target: targetId, label: 'KNOWS', quantifier: '1', direction: 'forward', automataName: '' };
          setEditingEdge({ edge: qEdge, position: { x: rx + 10, y: ry - 20 } });
          setDrawingFrom(null);
        }
        // If no target found, keep drawingFrom active so click-mode still works
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    }
  }, [onAddEdge]);

  return (
    <div className="relative w-full h-full overflow-hidden" style={graphCanvasBackground(d)}>
      {/* Empty state */}
      {vertices.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
          <div className={`text-center ${d ? 'text-gray-500' : 'text-gray-400'}`}>
            <svg
              width="120" height="64" viewBox="0 0 120 64" fill="none"
              className="mx-auto mb-3 opacity-50"
              stroke={d ? '#475569' : '#94a3b8'} strokeWidth="1.5"
            >
              <circle cx="16" cy="46" r="9" fill={d ? '#1e293b' : '#e2e8f0'} />
              <circle cx="62" cy="14" r="9" fill={d ? '#1e293b' : '#e2e8f0'} />
              <circle cx="104" cy="46" r="9" fill={d ? '#1e293b' : '#e2e8f0'} />
              <path d="M23 41 L54 19" strokeDasharray="4 3" />
              <path d="M70 19 L97 41" strokeDasharray="4 3" />
              <path d="M96 43 L99 39 M96 43 L92 41" strokeLinecap="round" />
              <path d="M55 21 L54 19 L57 18" strokeLinecap="round" />
            </svg>
            <p className="text-base mb-1.5">Double-click to add a vertex</p>
            <p className="text-sm">Click a vertex, then click another to connect them</p>
            <p className="text-sm mt-1 opacity-70">Double-click a vertex to change its label</p>
          </div>
        </div>
      )}

      {/* Cytoscape container */}
      <div ref={containerRef} className="w-full h-full" />

      {/* Drag line overlay */}
      {dragLine && (
        <svg className="absolute inset-0 w-full h-full pointer-events-none z-20">
          <line
            x1={dragLine.x1} y1={dragLine.y1}
            x2={dragLine.x2} y2={dragLine.y2}
            stroke="#06b6d4" strokeWidth={2} strokeDasharray="6 4" opacity={0.8}
          />
          <circle cx={dragLine.x2} cy={dragLine.y2} r={4} fill="#06b6d4" opacity={0.6} />
        </svg>
      )}


      {/* WE constraint annotation — top center for visibility */}
      {weConstraints.length > 0 && !compact && (
        <div className={`absolute top-2.5 left-1/2 -translate-x-1/2 z-10 flex items-center gap-3 px-4 py-2 rounded-xl border-2 backdrop-blur-sm shadow-lg ${
          d ? 'bg-gray-900/90 border-violet-500/40' : 'bg-white/90 border-violet-400/50'
        }`}>
          {weConstraints.map((wec, idx) => {
            const suffix = weConstraints.length > 1 ? String.fromCharCode(0x2081 + idx) : '';
            const typeLabel = (wec.type ?? 'we') === 'prefix' ? 'prefix' : '';
            return (
              <div key={idx} className="flex items-center gap-2 text-sm font-bold" style={{ fontFamily: 'ui-monospace, monospace' }}>
                <span style={{ color: d ? EDGE_P1_COLOR : EDGE_P1_COLOR_LIGHT }}>P1{suffix}</span>
                <span className={d ? 'text-violet-400' : 'text-violet-500'} style={{ fontSize: '16px' }}>=</span>
                <span style={{ color: d ? EDGE_P2_COLOR : EDGE_P2_COLOR_LIGHT }}>P2{suffix}</span>
                {typeLabel && <span className={`text-[11px] font-medium ${d ? 'text-gray-400' : 'text-gray-500'}`}>({typeLabel})</span>}
              </div>
            );
          })}
        </div>
      )}

      {/* Draw mode indicator */}
      {drawingFrom && (
        <div className={`absolute top-2 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-lg border text-xs z-40 backdrop-blur-sm ${
          d ? 'bg-cyan-900/80 border-cyan-700/60 text-cyan-300' : 'bg-cyan-50 border-cyan-200 text-cyan-700'
        }`}>
          Click a target vertex to create edge &nbsp;
          <button
            className="underline opacity-70 hover:opacity-100"
            onClick={() => { setDrawingFrom(null); cyRef.current?.nodes().removeClass('draw-target'); }}
          >
            cancel
          </button>
        </div>
      )}

      {/* Edge handle — shown on node hover (not in draw mode) */}
      {hoveredNodeHandle && !drawingFrom && (
        <button
          className="absolute z-30 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-transform hover:scale-110"
          style={{
            left: hoveredNodeHandle.x,
            top: hoveredNodeHandle.y,
            transform: 'translate(0, -50%)',
            backgroundColor: '#06b6d4',
            borderColor: bg,
            color: bg,
            fontSize: 11,
            fontWeight: 900,
            lineHeight: 1,
          }}
          title="Draw edge from this node"
          onMouseDown={e => { e.stopPropagation(); e.preventDefault(); startEdgeDraw(hoveredNodeHandle.nodeId, e); }}
        >
          +
        </button>
      )}

      {/* Toolbar: Layout + Fit + Center buttons (vertical stack) */}
      <div className={`absolute top-2 right-2 z-10 flex flex-col gap-1`}>
        <button
          className={graphToolbarButtonClass(d)}
          onClick={() => {
            const cy = cyRef.current;
            if (!cy || cy.nodes().length === 0) return;
            runElkLayout(cy, COLA_LAYOUT_OPTS, () => {
              if (cy.destroyed()) return;
              cy.fit(undefined, 50);
              const z = cy.zoom();
              const t = Math.min(Math.max(z, 0.6), 1.0);
              cy.zoom(t);
              cy.center();
            });
          }}
          title="Auto-layout (spread overlapping nodes)"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="3" cy="3" r="2"/><circle cx="13" cy="3" r="2"/>
            <circle cx="3" cy="13" r="2"/><circle cx="13" cy="13" r="2"/>
            <circle cx="8" cy="8" r="2"/>
            <line x1="3" y1="5" x2="3" y2="11"/><line x1="13" y1="5" x2="13" y2="11"/>
            <line x1="5" y1="3" x2="11" y2="3"/><line x1="5" y1="13" x2="11" y2="13"/>
          </svg>
        </button>
        <button
          className={graphToolbarButtonClass(d)}
          onClick={() => cyRef.current?.fit(undefined, 40)}
          title="Fit to view"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" />
          </svg>
        </button>
        <button
          className={graphToolbarButtonClass(d)}
          onClick={() => cyRef.current?.center()}
          title="Re-center view"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="8" cy="8" r="3"/>
            <line x1="8" y1="1" x2="8" y2="5"/><line x1="8" y1="11" x2="8" y2="15"/>
            <line x1="1" y1="8" x2="5" y2="8"/><line x1="11" y1="8" x2="15" y2="8"/>
          </svg>
        </button>
      </div>

      {/* Vertex label dropdown */}
      {editingVertex && (
        <VertexLabelDropdown
          position={editingVertex.position}
          currentLabel={editingVertex.currentLabel}
          vertexLabels={schema.vertex_labels}
          onSelect={label => onUpdateVertex(editingVertex.vertexId, label)}
          onDelete={() => { onRemoveElement(editingVertex.vertexId); setEditingVertex(null); }}
          onClose={() => setEditingVertex(null)}
        />
      )}

      {/* Edge label popover */}
      {editingEdge && (
        <EdgeLabelPopover
          position={editingEdge.position}
          edge={editingEdge.edge}
          edgeLabels={schema.edge_labels}
          onUpdate={props => onUpdateEdge(editingEdge.edge.id, props)}
          onDelete={() => { onRemoveElement(editingEdge.edge.id); setEditingEdge(null); }}
          onClose={() => setEditingEdge(null)}
        />
      )}
    </div>
  );
};

export default QueryCanvas;
