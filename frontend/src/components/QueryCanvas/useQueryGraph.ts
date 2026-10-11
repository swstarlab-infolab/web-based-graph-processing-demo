import { useState, useCallback, useRef } from 'react';
import type { QueryVertex, QueryEdge, WEConstraint, QueryGraph, VertexInequality } from '../../types';
import { parsePresetToQueryGraph } from '../../utils/queryBuilder';

export function useQueryGraph() {
  const [vertices, setVertices] = useState<QueryVertex[]>([]);
  const [edges, setEdges] = useState<QueryEdge[]>([]);
  const [weConstraints, setWEConstraints] = useState<WEConstraint[]>([]);
  const [inequalities, setInequalities] = useState<VertexInequality[]>([]);

  // Counters scoped to this hook instance, not module-level
  const vertexCounterRef = useRef(0);
  const edgeCounterRef = useRef(0);
  const automataCounterRef = useRef(0);

  const nextVertexId = useCallback((): string => {
    return `v_${++vertexCounterRef.current}`;
  }, []);

  const nextEdgeId = useCallback((): string => {
    return `e_${++edgeCounterRef.current}`;
  }, []);

  const nextAutomataName = useCallback((): string => {
    return `P${++automataCounterRef.current}`;
  }, []);

  const addVertex = useCallback(
    (label: string, position: { x: number; y: number }): string => {
      const id = nextVertexId();
      const vertex: QueryVertex = { id, label, position };
      setVertices((prev) => [...prev, vertex]);
      return id;
    },
    [nextVertexId],
  );

  const updateVertex = useCallback((id: string, label: string) => {
    setVertices((prev) =>
      prev.map((v) => (v.id === id ? { ...v, label } : v)),
    );
  }, []);

  const moveVertex = useCallback((id: string, position: { x: number; y: number }) => {
    setVertices((prev) =>
      prev.map((v) => (v.id === id ? { ...v, position } : v)),
    );
  }, []);

  const addEdge = useCallback(
    (source: string, target: string): string => {
      const id = nextEdgeId();
      const automataName = nextAutomataName();
      const edge: QueryEdge = {
        id,
        source,
        target,
        label: 'KNOWS',
        quantifier: '1',
        direction: 'forward',
        automataName,
      };
      setEdges((prev) => [...prev, edge]);
      return id;
    },
    [nextEdgeId, nextAutomataName],
  );

  const updateEdge = useCallback(
    (id: string, props: Partial<Omit<QueryEdge, 'id'>>) => {
      setEdges((prev) =>
        prev.map((e) => (e.id === id ? { ...e, ...props } : e)),
      );
    },
    [],
  );

  const removeElement = useCallback((id: string) => {
    setVertices((prev) => prev.filter((v) => v.id !== id));
    setEdges((prev) => prev.filter((e) => e.id !== id && e.source !== id && e.target !== id));
    setWEConstraints((prev) =>
      prev.filter((wec) => wec.edge1Id !== id && wec.edge2Id !== id),
    );
    setInequalities((prev) =>
      prev.filter((iq) => iq.v1Id !== id && iq.v2Id !== id),
    );
  }, []);

  const addWEConstraint = useCallback((edge1Id: string, edge2Id: string, type?: 'prefix') => {
    setWEConstraints((prev) => {
      const exists = prev.some(
        (wec) =>
          (wec.edge1Id === edge1Id && wec.edge2Id === edge2Id) ||
          (wec.edge1Id === edge2Id && wec.edge2Id === edge1Id),
      );
      if (exists) return prev;
      return [...prev, { edge1Id, edge2Id, ...(type ? { type } : {}) }];
    });
  }, []);

  const removeWEConstraint = useCallback((edge1Id: string, edge2Id: string) => {
    setWEConstraints((prev) =>
      prev.filter(
        (wec) =>
          !(
            (wec.edge1Id === edge1Id && wec.edge2Id === edge2Id) ||
            (wec.edge1Id === edge2Id && wec.edge2Id === edge1Id)
          ),
      ),
    );
  }, []);

  const loadPreset = useCallback(
    (presetContent: Record<string, unknown>) => {
      // Reset counters
      vertexCounterRef.current = 0;
      edgeCounterRef.current = 0;
      automataCounterRef.current = 0;

      const parsed = parsePresetToQueryGraph(presetContent);

      // Create vertices
      const newVertices: QueryVertex[] = parsed.vertices.map((v) => ({
        id: nextVertexId(),
        label: v.label,
        position: v.position,
      }));

      // Create edges — always assign fresh P-names to avoid collisions
      // with graph edge labels (the engine requires automata names != edge labels)
      const originalToNewAutomata = new Map<string, string>();
      const newEdges: QueryEdge[] = parsed.edges.map((e) => {
        const newPName = nextAutomataName();
        if (e.automataName) {
          originalToNewAutomata.set(e.automataName, newPName);
        }
        return {
          id: nextEdgeId(),
          source: newVertices[e.sourceIdx]?.id || '',
          target: newVertices[e.targetIdx]?.id || '',
          label: e.label,
          quantifier: e.quantifier,
          direction: e.direction,
          automataName: newPName,
          alternateLabels: e.alternateLabels,
          originalNFA: e.originalNFA,
          minLength: e.minLength,
          maxLength: e.maxLength,
        };
      });

      // Create WE constraints using original→new automata name mapping
      const automataToEdgeId = new Map<string, string>();
      for (const e of newEdges) {
        automataToEdgeId.set(e.automataName, e.id);
      }

      const newWEConstraints: WEConstraint[] = [];
      for (const wec of parsed.weConstraints) {
        const newP1 = originalToNewAutomata.get(wec.automata1);
        const newP2 = originalToNewAutomata.get(wec.automata2);
        const e1 = newP1 ? automataToEdgeId.get(newP1) : undefined;
        const e2 = newP2 ? automataToEdgeId.get(newP2) : undefined;
        if (e1 && e2) {
          newWEConstraints.push({
            edge1Id: e1,
            edge2Id: e2,
            ...(wec.type ? { type: wec.type } : {}),
            ...(wec.sourceConstraint === 'different' ? { sourceConstraint: 'different' as const } : {}),
            ...(wec.linkingLabel ? { linkingLabel: wec.linkingLabel } : {}),
          });
        }
      }

      // Carry preset inequality constraints (e.g. person1<>person2)
      const newInequalities: VertexInequality[] = parsed.inequalities
        .map(({ v1Idx, v2Idx }) => ({
          v1Id: newVertices[v1Idx]?.id || '',
          v2Id: newVertices[v2Idx]?.id || '',
        }))
        .filter((iq) => iq.v1Id && iq.v2Id);

      setVertices(newVertices);
      setEdges(newEdges);
      setWEConstraints(newWEConstraints);
      setInequalities(newInequalities);
    },
    [nextVertexId, nextEdgeId, nextAutomataName],
  );

  const clearQuery = useCallback(() => {
    vertexCounterRef.current = 0;
    edgeCounterRef.current = 0;
    automataCounterRef.current = 0;
    setVertices([]);
    setEdges([]);
    setWEConstraints([]);
    setInequalities([]);
  }, []);

  const getQueryGraph = useCallback((): QueryGraph => {
    return { vertices, edges, weConstraints, inequalities };
  }, [vertices, edges, weConstraints, inequalities]);

  return {
    vertices,
    edges,
    weConstraints,
    inequalities,
    addVertex,
    updateVertex,
    moveVertex,
    addEdge,
    updateEdge,
    removeElement,
    addWEConstraint,
    removeWEConstraint,
    loadPreset,
    clearQuery,
    getQueryGraph,
  };
}
