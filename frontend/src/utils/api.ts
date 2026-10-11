import type { Dataset, Schema, QueryResult, PresetQuery, PresetsResponse, CatalogGroup } from '../types';
import {
  MOCK_DATASETS,
  MOCK_SCHEMA,
  MOCK_PRESETS,
} from '../data/mockData';

const API_BASE = '/api';

let useMock = false;

// Presenter switch: replay a stored result instead of running the engine.
// Module-level rather than a parameter because runQuery has ten call sites and
// the choice is a mode the presenter sets once, not a per-call decision.
let cacheMode = false;

/** Turn stored-result replay on or off for every subsequent query. */
export function setCacheMode(on: boolean): void { cacheMode = on; }

/** Whether queries are currently being served from stored results. */
export function isCacheMode(): boolean { return cacheMode; }

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

/** Fetch available datasets */
export async function fetchDatasets(): Promise<Dataset[]> {
  try {
    const result = await apiFetch<Dataset[]>('/datasets');
    useMock = false; // Backend is reachable — clear mock flag
    return result;
  } catch {
    useMock = true;
    return MOCK_DATASETS;
  }
}

/** Fetch schema for a dataset */
export async function fetchSchema(datasetId: string): Promise<Schema> {
  try {
    return await apiFetch<Schema>(`/schema/${datasetId}`);
  } catch {
    return MOCK_SCHEMA;
  }
}

/** Run a query against the backend */
export async function runQuery(
  queryJson: object,
  datasetId: string,
): Promise<QueryResult> {
  if (useMock) {
    throw new Error(
      'Backend unavailable (mock mode). Refresh the page after starting the backend.',
    );
  }
  // Guard: reject empty/null query objects to prevent 422 errors
  if (!queryJson || typeof queryJson !== 'object' || Object.keys(queryJson).length === 0) {
    throw new Error('Empty query — cannot send to backend');
  }
  return await apiFetch<QueryResult>('/query', {
    method: 'POST',
    body: JSON.stringify({
      query_json: queryJson, dataset_id: datasetId, use_cache: cacheMode,
    }),
  });
}

/** Fetch preset queries with catalog metadata */
export async function fetchPresets(): Promise<{ groups: CatalogGroup[]; presets: PresetQuery[] }> {
  try {
    const resp = await apiFetch<PresetsResponse>('/presets');
    return { groups: resp.groups ?? [], presets: resp.presets ?? [] };
  } catch {
    return { groups: [], presets: MOCK_PRESETS };
  }
}

/** Ask backend to build NFA from a regex string */
export async function buildNFA(
  regex: string,
  name: string,
): Promise<Record<string, unknown>> {
  try {
    return await apiFetch<Record<string, unknown>>('/nfa', {
      method: 'POST',
      body: JSON.stringify({ regex, name }),
    });
  } catch {
    // Return empty — caller should fall back to frontend NFA builder
    return {};
  }
}

export interface BenchmarkResult {
  supported: boolean;
  total_count: number | null;
  elapsed_ms: number | null;
  peak_rss_gb: number | null;
  error: string | null;
}

/** Run Umbra or DuckDB SQL for the given preset and return live timing */
export async function runBenchmark(
  presetFilename: string,
  system: 'umbra' | 'duckdb',
  timeoutSec?: number,
  datasetId?: string,
): Promise<BenchmarkResult> {
  return await apiFetch<BenchmarkResult>('/benchmark', {
    method: 'POST',
    body: JSON.stringify({ preset_filename: presetFilename, system, timeout_sec: timeoutSec, dataset_id: datasetId }),
  });
}

/** Cancel the currently running benchmark */
export async function cancelBenchmark(): Promise<void> {
  try {
    await apiFetch<{ cancelled: boolean }>('/benchmark', { method: 'DELETE' });
  } catch {
    // ignore — backend may have already finished
  }
}

/* ---- vertex-anchored 1-hop neighbourhood (graph context layer) ---- */

export interface NeighborhoodVertex {
  id: number;
  label?: string;
  /** true for the vertices that were asked for (the match's own vertices) */
  requested?: boolean;
  /** true when this vertex hit the per-vertex cap */
  truncated?: boolean;
}

export interface NeighborhoodEdge {
  source: number;
  target: number;
  label: string;
  /** the exact reverse edge also exists in the grid (e.g. KNOWS) */
  undirected?: boolean;
}

export interface NeighborhoodResponse {
  vertices: NeighborhoodVertex[];
  edges: NeighborhoodEdge[];
  max_per_vertex?: number;
  truncated?: boolean;
}

/** Fetch the 1-hop incident edges of the given (globalized) vertex ids.
 *
 *  Backed by POST /api/neighborhood. Older backends do not have that route and
 *  answer 404 — apiFetch throws, and every caller is expected to degrade
 *  quietly rather than surface an error, since this is a purely additive
 *  visual layer. */
export async function fetchNeighborhood(
  vertexIds: number[],
  datasetId?: string,
  maxPerVertex = 12,
  edgeLabels?: string[],
): Promise<NeighborhoodResponse> {
  if (useMock) throw new Error('Backend unavailable (mock mode)');
  if (!vertexIds || vertexIds.length === 0) throw new Error('No vertex ids given');
  const body: Record<string, unknown> = {
    vertex_ids: vertexIds,
    max_per_vertex: maxPerVertex,
  };
  if (datasetId) body.dataset_id = datasetId;
  if (edgeLabels && edgeLabels.length > 0) body.edge_labels = edgeLabels;

  const res = await apiFetch<NeighborhoodResponse & { error?: string }>('/neighborhood', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  // The solver reports its own failures in-band with a 200 (e.g. unknown edge
  // label); treat that as a failure too so callers only ever see valid data.
  if (res && res.error) throw new Error(String(res.error));
  return { ...res, vertices: res?.vertices ?? [], edges: res?.edges ?? [] };
}

/** Check if we are currently in mock mode */
export function isMockMode(): boolean {
  return useMock;
}
