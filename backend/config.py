"""Dataset table, engine settings and paths for the demo backend.

Everything that depends on the host machine is read from environment
variables so the same code runs on a laptop (mock engine) and on a GPU
server (external engine process).
"""

from __future__ import annotations

import os

# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------

# "mock"    : replay recorded results from backend/samples (no GPU needed)
# "process" : drive an external engine binary over its line protocol
ENGINE_MODE = os.environ.get("ENGINE_MODE", "mock").strip().lower()

# Path to the external engine binary (process mode only).
ENGINE_BINARY = os.environ.get("ENGINE_BINARY", "")

# GPU the engine process is pinned to (process mode only).
ENGINE_CUDA_DEVICES = os.environ.get("ENGINE_CUDA_DEVICES", "0")

# Root directory holding one sub-directory per dataset (process mode only).
DATA_ROOT = os.environ.get("DATA_ROOT", "data")

DATASETS: dict[str, dict[str, str]] = {
    "LDBC_SNB_SF1": {
        "name": "LDBC SNB SF=1",
        "grid_name": "LSQB_sf1S",
        "grid_dir": os.path.join(DATA_ROOT, "sf1"),
        "schema": "LDBC_SNB",
    },
    "LDBC_SNB_SF10": {
        "name": "LDBC SNB SF=10",
        "grid_name": "LSQB_sf10S",
        "grid_dir": os.path.join(DATA_ROOT, "sf10"),
        "schema": "LDBC_SNB",
    },
}

# Engine buffer sizes in bytes (base_shard_size in MiB).
DEFAULT_BUFFERS: dict[str, int] = {
    "host_buf": 2147483648,       # 2GB
    "dev_buf": 2147483648,        # 2GB
    "visited_buf": 21474836480,   # 20GB
    "host_ir_buf": 10074836480,   # ~10GB
    "dev_ir_buf": 2147483648,     # 2GB
    "base_shard_size": 1024,
}

SCHEMA_DIR = "schema"       # Relative to repository root
QUERIES_DIR = "queries"     # Demo scenario queries + catalog.json
DEFAULT_SAMPLE_K = 10
QUERY_TIMEOUT = 300  # seconds

# Datasets to pre-load at server startup (process mode only).
PRELOAD_DATASETS: list[str] = [
    d for d in os.environ.get("PRELOAD_DATASETS", "").split(",") if d.strip()
]

# ---------------------------------------------------------------------------
# Baseline systems for the comparison panel
# ---------------------------------------------------------------------------

UMBRA_HOST = os.environ.get("UMBRA_HOST", "127.0.0.1")
UMBRA_PASSWORD = os.environ.get("UMBRA_PASSWORD", "postgres")
UMBRA_CONFIGS: dict[str, dict] = {
    "LDBC_SNB_SF1":  {"port": int(os.environ.get("UMBRA_PORT_SF1", "5432")),
                      "container": os.environ.get("UMBRA_CONTAINER_SF1", "umbra-sf1")},
    "LDBC_SNB_SF10": {"port": int(os.environ.get("UMBRA_PORT_SF10", "5433")),
                      "container": os.environ.get("UMBRA_CONTAINER_SF10", "umbra-sf10")},
}

DUCKDB_PATHS: dict[str, str] = {
    "LDBC_SNB_SF1":  os.environ.get("DUCKDB_PATH_SF1", "data/duckdb/ldbc_sf1.duckdb"),
    "LDBC_SNB_SF10": os.environ.get("DUCKDB_PATH_SF10", "data/duckdb/ldbc_sf10.duckdb"),
}

BENCHMARK_TIMEOUT = 60  # seconds
