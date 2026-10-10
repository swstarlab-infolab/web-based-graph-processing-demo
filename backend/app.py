"""FastAPI application for the web graph demo backend."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re as _re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from config import (
    DATASETS,
    DEFAULT_BUFFERS,
    DEFAULT_SAMPLE_K,
    ENGINE_BINARY,
    ENGINE_CUDA_DEVICES,
    ENGINE_MODE,
    PRELOAD_DATASETS,
    QUERY_TIMEOUT,
    SCHEMA_DIR,
)
from engine import create_engine
from schema_loader import get_schema_summary, load_schema


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BACKEND_DIR.parent
SCHEMA_PATH = PROJECT_ROOT / SCHEMA_DIR
CACHE_DIR = BACKEND_DIR / ".result_cache"
SAMPLES_DIR = BACKEND_DIR / "samples"

runner = create_engine(ENGINE_MODE, SAMPLES_DIR)
_query_lock = asyncio.Lock()  # One query at a time (the engine owns the GPU)

@asynccontextmanager
async def lifespan(application: FastAPI):
    """Log startup info."""
    logger.info("Web graph demo backend starting (engine=%s)", ENGINE_MODE)
    logger.info("Project root: %s", PROJECT_ROOT)
    logger.info("Schema dir: %s", SCHEMA_PATH)
    # Pre-load grids so first query is instant
    if PRELOAD_DATASETS:
        logger.info("Pre-loading datasets: %s", PRELOAD_DATASETS)
        await runner.preload(PRELOAD_DATASETS, _runner_config())
        logger.info("Pre-load complete")
        # Fire one trivial query per daemon: the FIRST query pays ~10s of
        # one-time buffer allocation (20GB device visited + ~10GB pinned host
        # IR); absorbing it at startup keeps user queries at engine speed.
        warmup_q = json.dumps({
            "query_vertices": ["v1:Any", "v2:Any"],
            "query_edges": ["(v1)-[KNOWS]->(v2)"],
        })
        for ds in PRELOAD_DATASETS:
            try:
                await runner.run_query(warmup_q, ds, _runner_config(), timeout=120)
                logger.info("Warm-up query done for %s", ds)
            except Exception as e:
                logger.warning("Warm-up query failed for %s: %s", ds, e)
    yield
    # Gracefully shut down engine processes
    await runner.shutdown()


app = FastAPI(title="Web Graph Demo", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class QueryRequest(BaseModel):
    """Request body for query execution."""

    query_json: dict
    dataset_id: str = "LDBC_SNB_SF1"
    # Serve a stored result if one exists, instead of running the engine.  Off
    # by default: a demo claims live GPU execution, so replaying has to be an
    # explicit act by the presenter, never the fallback.
    use_cache: bool = False


class QueryResponse(BaseModel):
    """Response body for query results.

    The engine reports correctness caveats alongside the count (frontier
    overflow, multi-word-class cross-term mixing, witness reconstruction
    budget).  They are part of the answer, not debug noise: a warned count
    may be wrong, so they must reach the UI rather than stop here.
    """

    query_type: str = "rpq"
    total_count: int
    elapsed_ms: float
    samples: list[Any]
    # Human-readable correctness caveats, e.g.
    # "multi_word_class: ... total_count may be incorrect".
    warnings: list[str] | None = None
    # Structured pair-frontier diagnostics (sources_affected, widest_frontier, ...).
    we_pair_frontier_warnings: dict[str, Any] | None = None
    # How many CRPQ witness paths were reconstructed vs skipped.
    witness_stats: dict[str, Any] | None = None
    # True when the engine knows total_count cannot be trusted (currently the
    # accumulation CRPQ+WE path). The `warnings` text says why; this is the
    # machine-readable form so a client can gate on it.
    total_count_unreliable: bool | None = None
    # The engine's live footprint while answering: the serving process's host
    # RSS plus its GPU allocation, measured at response time.
    engine_mem_gb: float | None = None
    mem_host_gb: float | None = None
    mem_gpu_gb: float | None = None
    # True when this answer was replayed from disk rather than computed now.
    # The UI badges it; without this a cached reply is indistinguishable from a
    # fast one, which is exactly the confusion a live demo cannot afford.
    from_cache: bool = False


class DatasetInfo(BaseModel):
    """Information about an available dataset."""

    id: str
    name: str
    schema: str
    loaded: bool


# ---------------------------------------------------------------------------
# Helper to build engine config dict
# ---------------------------------------------------------------------------


def _runner_config() -> dict:
    """Build the config dict passed to every engine call."""
    return {
        "binary": ENGINE_BINARY,
        "cuda_devices": ENGINE_CUDA_DEVICES,
        "project_root": str(PROJECT_ROOT),
        "datasets": DATASETS,
        "buffers": DEFAULT_BUFFERS,
        "sample_k": DEFAULT_SAMPLE_K,
    }


# ---------------------------------------------------------------------------
# Result cache — instant responses for preset queries at conference demos
# ---------------------------------------------------------------------------

# Bump whenever the engine or sample format changes — cached entries have no
# TTL, so stale results would otherwise be served verbatim.
CACHE_VERSION = "1"

# Live-demo switch.  With DEMO_DISABLE_CACHE=1 every query goes through the
# engine, and no result is written back.  Clearing .result_cache is NOT enough
# on its own: the first run would repopulate it, so re-clicking a preset would
# be answered by the cache instead of the engine -- exactly the thing a live demo
# must not do.
DISABLE_CACHE = os.environ.get("DEMO_DISABLE_CACHE", "").strip().lower() not in (
    "", "0", "false", "no",
)


def _cache_key(query_json: dict, dataset_id: str) -> str:
    """Deterministic hash from query JSON + dataset + engine version."""
    canon = json.dumps(query_json, sort_keys=True, separators=(",", ":"))
    raw = f"{CACHE_VERSION}:{dataset_id}:{canon}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _cache_get(query_json: dict, dataset_id: str, requested: bool = False) -> dict | None:
    """Return cached result or None.

    `requested` is the presenter pressing the cache button: it overrides
    DEMO_DISABLE_CACHE, which otherwise only suppresses the *automatic* reuse
    that would silently turn a live demo into a replay.
    """
    if DISABLE_CACHE and not requested:
        return None
    key = _cache_key(query_json, dataset_id)
    path = CACHE_DIR / f"{key}.json"
    if path.exists():
        try:
            with open(path) as f:
                return json.load(f)
        except Exception:
            pass
    return None


def _cache_put(query_json: dict, dataset_id: str, result: dict) -> None:
    """Store result in cache.

    Recording continues even with DEMO_DISABLE_CACHE=1.  The flag governs
    whether a stored answer may be *served*, and the cache button needs
    something to serve; a run that was live when it happened stays a faithful
    record of that run.
    """
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    key = _cache_key(query_json, dataset_id)
    path = CACHE_DIR / f"{key}.json"
    with open(path, "w") as f:
        json.dump(result, f, separators=(",", ":"))


# ---------------------------------------------------------------------------
# Label derivation helpers (mirrors frontend perHopLabel / inferVertexTypeAtPos)
# ---------------------------------------------------------------------------


def _per_hop_label(nfa_label: str, hop_idx: int, total_hops: int) -> str:
    """Return the display label for a single hop of a concatenation regex.

    "/" is the concatenation operator. Non-quantified leading parts anchor to the
    first N hops; non-quantified trailing parts anchor to the last M hops;
    the quantified part in the middle fills all remaining hops.
    Trailing quantifier chars (*+?) are stripped from the returned label.

    Examples:
      "KNOWS" with any hop → "KNOWS"
      "LIKES/REPLY_OF*" with (0, 3) → "LIKES", (1, 3) → "REPLY_OF", (2, 3) → "REPLY_OF"
      "KNOWS*/HAS_INTEREST" with (0, 3) → "KNOWS", (1, 3) → "KNOWS", (2, 3) → "HAS_INTEREST"
    """
    def strip(s: str) -> str:
        return _re.sub(r'([*+?]|\[\d*\.\.\d*\])$', '', s) or s

    if '/' not in nfa_label:
        return strip(nfa_label)

    parts = nfa_label.split('/')
    n = total_hops

    def is_quant(p: str) -> bool:
        return bool(_re.search(r'([*+?]|\[\d*\.\.\d*\])$', p))

    # Count leading fixed (non-quantified) parts → anchor to beginning hops
    fixed_start = 0
    for i in range(len(parts)):
        if is_quant(parts[i]):
            break
        fixed_start += 1

    if hop_idx < fixed_start:
        return strip(parts[hop_idx])

    # Count trailing fixed parts (after the leading fixed section) → anchor to end hops
    fixed_end = 0
    for i in range(len(parts) - 1, fixed_start - 1, -1):
        if is_quant(parts[i]):
            break
        fixed_end += 1

    start_fixed = n - fixed_end
    if hop_idx >= start_fixed:
        part_idx = (len(parts) - fixed_end) + (hop_idx - start_fixed)
        return strip(parts[min(part_idx, len(parts) - 1)])

    # Middle hops belong to the first quantified part. Clamp: when the path is
    # longer than an all-fixed label, fixed_start == len(parts) and indexing
    # would raise IndexError.
    return strip(parts[min(fixed_start, len(parts) - 1)])


def _infer_vertex_type_at_pos(
    in_edge_label: str | None,
    out_edge_label: str | None,
    edge_endpoints: dict,
) -> str | None:
    """Infer vertex type using intersection of incoming.target ∩ outgoing.source."""
    def get_types(lbl: str, role: str) -> set:
        return {p[role] for p in edge_endpoints.get(lbl, [])}

    from_in  = get_types(in_edge_label,  'target') if in_edge_label  else None
    from_out = get_types(out_edge_label, 'source') if out_edge_label else None

    if from_in and from_out:
        inter = from_out & from_in
        candidates = inter if inter else (from_out if from_out else from_in)
    else:
        candidates = from_out or from_in or set()

    return next(iter(candidates)) if len(candidates) == 1 else None


def _augment_samples(
    samples: list[Any],
    query_json: dict,
    query_type: str,
    schema_summary: dict | None,
) -> list[Any]:
    """Add edge_labels and vertex_types to each sample path.

    Uses the query automata regex and schema edge_endpoints to derive labels
    without any inference on the frontend side.
    """
    automata = query_json.get("automata", {})
    edge_endpoints = (schema_summary or {}).get("edge_endpoints", {})

    # Parse "v1:Person" → {"v1": "Person"}
    vertex_type_by_id: dict[str, str] = {}
    for qv in query_json.get("query_vertices", []):
        if ':' in qv:
            vid, vtype = qv.split(':', 1)
            vertex_type_by_id[vid.strip()] = vtype.strip()

    # Parse "(v1)-[P1]->(v2)" → {"P1": {"src": "v1", "tgt": "v2"}}
    path_to_endpoints: dict[str, dict[str, str]] = {}
    for qe in query_json.get("query_edges", []):
        m = _re.match(r'\((\w+)\)-\[(\w+)\]->\((\w+)\)', qe)
        if m:
            path_to_endpoints[m.group(2)] = {"src": m.group(1), "tgt": m.group(3)}

    we_constraints = query_json.get("word_equality_constraints", [])

    def _augment_path(path: dict, automaton_name: str | None) -> dict:
        vertices = path.get("vertices", [])
        path_len = len(vertices) - 1
        if path_len <= 0:
            return {**path, "edge_labels": [], "vertex_types": [vt or "" for vt in [None] * len(vertices)]}

        # Edge labels: prefer kernel-provided labels, fallback to regex inference
        kernel_labels = path.get("edge_labels")
        if kernel_labels and len(kernel_labels) == path_len and all(kernel_labels):
            edge_labels = kernel_labels
        else:
            aut = automata.get(automaton_name) if automaton_name else None
            regex = aut.get("regular_expression", "") if aut else ""
            edge_labels = [_per_hop_label(regex, i, path_len) for i in range(path_len)]

        # Vertex types: prefer kernel-provided vertex_labels, fallback to inference
        kernel_vlabels = path.get("vertex_labels")
        if kernel_vlabels and len(kernel_vlabels) == len(vertices):
            vertex_types = [vl if vl else "" for vl in kernel_vlabels]
        else:
            ep = path_to_endpoints.get(automaton_name, {}) if automaton_name else {}
            src_type = vertex_type_by_id.get(ep.get("src", "")) if ep else None
            tgt_type = vertex_type_by_id.get(ep.get("tgt", "")) if ep else None

            vertex_types = []
            for i in range(len(vertices)):
                vt = None
                if i == 0 and src_type and src_type.lower() != "any":
                    vt = src_type
                elif i == path_len and tgt_type and tgt_type.lower() != "any":
                    vt = tgt_type
                if not vt:
                    in_edge  = edge_labels[i - 1] if i > 0       else None
                    out_edge = edge_labels[i]      if i < path_len else None
                    vt = _infer_vertex_type_at_pos(in_edge, out_edge, edge_endpoints)
                vertex_types.append(vt or "")

        return {**path, "edge_labels": edge_labels, "vertex_types": vertex_types}

    result: list[Any] = []
    for sample in samples:
        if query_type == "word_equality" and "path1" in sample:
            p1_name = we_constraints[0].get("path1", "P1") if we_constraints else "P1"
            p2_name = we_constraints[0].get("path2", "P2") if we_constraints else "P2"
            result.append({
                **sample,
                "path1": _augment_path(sample["path1"], p1_name),
                "path2": _augment_path(sample["path2"], p2_name),
            })
        elif query_type == "crpq":
            # CRPQ samples are N-tuples (match_vids) with no edge path info.
            # Do NOT augment with P1 edge labels — that causes isExpandedCrpq=true
            # in PathList and hides the P2/linking edges from the display.
            # The kernel does provide a per-vertex grid-block label, so pass that
            # through as vertex_types (same field the rpq branch produces).
            #
            # The solver may also attach "edge_paths": one reconstructed witness
            # path per query edge (see CRPQ_solver::exec_query).  Both branches
            # below rebuild the sample with {**sample, ...} / pass it straight
            # through, so edge_paths survives verbatim — it must NOT be rewritten
            # here, its ids and labels come from the grid and are already exact.
            kernel_vlabels = sample.get("vertex_labels")
            vertices = sample.get("vertices", [])
            if kernel_vlabels and len(kernel_vlabels) == len(vertices):
                result.append({
                    **sample,
                    "vertex_types": [vl if vl else "" for vl in kernel_vlabels],
                })
            else:
                result.append(sample)
        else:
            aut_name = next(iter(automata), None) if automata else None
            result.append(_augment_path(sample, aut_name))
    return result


# ---------------------------------------------------------------------------
# Sample diversity: select samples with varied hop counts
# ---------------------------------------------------------------------------


def _diversify_samples(samples: list[Any], query_type: str) -> list[Any]:
    """Re-order samples to maximize hop-length diversity.

    Groups samples by path length, then round-robin picks one from each
    length bucket so the output covers as many distinct hop counts as possible.
    """
    if len(samples) <= 1:
        return samples

    def _path_len(s: Any) -> int:
        if query_type == "word_equality":
            p1 = s.get("path1", {})
            return len(p1.get("vertices", [])) - 1
        return len(s.get("vertices", [])) - 1

    # Group by path length
    buckets: dict[int, list[Any]] = {}
    for s in samples:
        pl = _path_len(s)
        buckets.setdefault(pl, []).append(s)

    # Round-robin across lengths (sorted ascending)
    result: list[Any] = []
    sorted_keys = sorted(buckets.keys())
    idx_per_key = {k: 0 for k in sorted_keys}
    while len(result) < len(samples):
        added = False
        for k in sorted_keys:
            if idx_per_key[k] < len(buckets[k]):
                result.append(buckets[k][idx_per_key[k]])
                idx_per_key[k] += 1
                added = True
        if not added:
            break

    return result


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/api/datasets")
async def get_datasets() -> list[DatasetInfo]:
    """Return available datasets with loading status."""
    result: list[DatasetInfo] = []
    for dataset_id, info in DATASETS.items():
        result.append(
            DatasetInfo(
                id=dataset_id,
                name=info["name"],
                schema=info["schema"],
                loaded=False,
            )
        )
    return result


@app.get("/api/schema/{dataset_id}")
async def get_schema(dataset_id: str) -> dict:
    """Return vertex/edge labels for a dataset.

    Args:
        dataset_id: Dataset identifier (e.g. "LDBC_SNB_SF1").
    """
    if dataset_id not in DATASETS:
        raise HTTPException(status_code=404, detail=f"Unknown dataset: {dataset_id}")

    schema_name = DATASETS[dataset_id]["schema"]
    try:
        schema = load_schema(schema_name, str(SCHEMA_PATH))
    except FileNotFoundError:
        raise HTTPException(
            status_code=404,
            detail=f"Schema file not found for {schema_name}",
        )
    return get_schema_summary(schema)


def _engine_diagnostics(result: dict) -> dict:
    """Pull the engine's correctness caveats out of the raw result document.

    Only keys that are actually present are returned, so a clean run adds
    nothing to the response and cached clean runs stay byte-identical.
    """
    out: dict[str, Any] = {}
    warnings = result.get("warnings")
    if warnings:
        out["warnings"] = list(warnings)
    pf = result.get("we_pair_frontier_warnings")
    if pf:
        out["we_pair_frontier_warnings"] = pf
        # Surface the structured overflow report in the human-readable list too,
        # so a UI that only renders `warnings` still tells the user the count is
        # a lower bound.
        affected = pf.get("sources_affected")
        if affected:
            out.setdefault("warnings", []).append(
                f"pair-frontier overflow: {affected} source(s) affected; "
                f"total_count is a lower bound"
            )
    stats = result.get("witness_stats")
    if stats:
        out["witness_stats"] = stats
    if result.get("total_count_unreliable"):
        out["total_count_unreliable"] = True
    return out


@app.post("/api/query")
async def run_query(req: QueryRequest) -> QueryResponse:
    """Execute a query. Returns cached result instantly if available."""
    if req.dataset_id not in DATASETS:
        raise HTTPException(
            status_code=400, detail=f"Unknown dataset: {req.dataset_id}"
        )

    # Check cache first — instant response for conference demos
    cached = _cache_get(req.query_json, req.dataset_id, requested=req.use_cache)
    if cached:
        logger.info("Cache HIT for dataset=%s (requested=%s)", req.dataset_id, req.use_cache)
        cached = {**cached, "from_cache": True}
        return QueryResponse(**{**cached, **runner.memory_gb(req.dataset_id)})
    if req.use_cache:
        raise HTTPException(
            status_code=404,
            detail="No stored result for this query yet — run it live once first.",
        )

    if _query_lock.locked():
        raise HTTPException(status_code=409, detail="Another query is already running")

    query_str = json.dumps(req.query_json)
    logger.info("Query JSON: %s", query_str[:500])
    try:
        async with _query_lock:
            result = await runner.run_query(
                query_str, req.dataset_id, _runner_config(), timeout=QUERY_TIMEOUT
            )
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

    # The engine reports a failed run as an "error" document with no
    # total_count.  Without this the .get("total_count", 0) below would turn a
    # crashed query into a confident zero.
    engine_error = result.get("error")
    if engine_error:
        logger.error("Engine reported a failed query: %s", engine_error)
        raise HTTPException(status_code=500, detail=f"Engine error: {engine_error}")

    logger.info(
        "Query result: type=%s count=%s elapsed=%.1fms samples=%d",
        result.get("query_type"),
        result.get("total_count"),
        result.get("elapsed_ms", 0),
        len(result.get("samples", [])),
    )

    query_type = result.get("query_type", "rpq")
    samples = _diversify_samples(result.get("samples", []), query_type)

    # Augment samples with per-hop edge_labels and vertex_types
    try:
        schema_name = DATASETS[req.dataset_id]["schema"]
        schema_raw = load_schema(schema_name, str(SCHEMA_PATH))
        schema_summary = get_schema_summary(schema_raw)
    except Exception:
        schema_summary = None
    samples = _augment_samples(samples, req.query_json, query_type, schema_summary)

    response = QueryResponse(
        query_type=query_type,
        total_count=result.get("total_count", 0),
        elapsed_ms=result.get("elapsed_ms", 0.0),
        samples=samples,
        **_engine_diagnostics(result),
        **runner.memory_gb(req.dataset_id),
        # Mock answers are recordings; badge them the same way as cache hits.
        from_cache=ENGINE_MODE == "mock",
    )

    # Store in cache for next time (recordings need no second copy)
    if ENGINE_MODE != "mock":
        _cache_put(req.query_json, req.dataset_id, response.model_dump())

    return response


@app.get("/api/status")
async def get_status() -> dict:
    """Return runner status."""
    return {
        "mode": ENGINE_MODE,
        "last_dataset": runner.current_dataset,
        # Exposed so the demo pre-flight can prove every query really reaches
        # the engine, instead of inferring it from response times.
        "cache_disabled": DISABLE_CACHE,
    }
