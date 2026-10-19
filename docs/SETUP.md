# Setup Guide

## Requirements

- Python 3.10+
- Node.js 18+ and npm

## 1. Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000
```

The server starts in **mock mode** (`ENGINE_MODE=mock`) and answers the demo
scenarios from the recorded results in `backend/samples/`. Queries that are not
recorded return an error in this mode.

Check that it is up:

```bash
curl http://localhost:8000/api/status
```

## 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:9173. The dev server proxies `/api` to port 8000.

To serve everything from the backend instead, build the frontend once:

```bash
cd frontend
npm run build
```

The backend then serves `frontend/dist` at http://localhost:8000.

## 3. Running against a live engine (optional)

Set the following environment variables before starting the backend:

| Variable | Meaning |
|---|---|
| `ENGINE_MODE` | `process` to drive an external engine binary |
| `ENGINE_BINARY` | Path to the engine binary |
| `ENGINE_CUDA_DEVICES` | GPU id(s) for the engine process (default `0`) |
| `DATA_ROOT` | Directory holding one sub-directory per dataset |
| `PRELOAD_DATASETS` | Comma-separated dataset ids to load at startup |
| `DEMO_DISABLE_CACHE` | `1` to always run queries instead of reusing stored results |

## 4. Baseline comparison (optional)

The benchmark tab can run the equivalent SQL on Umbra and DuckDB.

```bash
pip install psycopg2-binary duckdb
```

| Variable | Meaning |
|---|---|
| `UMBRA_HOST`, `UMBRA_PASSWORD` | Umbra connection |
| `UMBRA_PORT_SF1`, `UMBRA_CONTAINER_SF1` | Umbra instance for SF=1 (same for `_SF10`) |
| `DUCKDB_PATH_SF1`, `DUCKDB_PATH_SF10` | DuckDB database files |

## 5. Tests

```bash
cd backend
pip install -r requirements-dev.txt
python -m pytest tests
```
