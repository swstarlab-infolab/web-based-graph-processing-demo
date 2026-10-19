# Web Graph Demo

Web-based Graph Processing Demonstration System.

An interactive web interface for exploring path queries over large property
graphs. Draw a query pattern, attach regular expressions over edge labels to
its edges, run it, and inspect the matching paths as an interactive graph.

## Features

- **Visual query canvas** – draw query vertices and edges, pick labels from the dataset schema
- **Regular path queries** – edge patterns such as `KNOWS*`, `KNOWS{1,3}/LIKES`, compiled to NFAs
- **Conjunctive queries** – combine several path patterns that share vertices
- **Word equality constraints** – require two paths to spell the same (or a prefix-related) label sequence
- **Result exploration** – sample paths rendered with Cytoscape, per-hop labels, neighborhood expansion
- **Guided scenarios** – a catalog of demo questions over the LDBC Social Network Benchmark
- **Baseline comparison** – run the equivalent SQL on Umbra / DuckDB side by side

## Repository layout

```
frontend/   React + TypeScript + Vite single-page app
backend/    FastAPI server, regex-to-NFA builder, engine adapters
queries/    Demo scenario queries and their catalog
schema/     Graph schema (vertex / edge labels) per dataset
```

## Quick start

The backend runs in **mock mode** by default and replays recorded results for
the demo scenarios, so no GPU or dataset is needed.

```bash
# backend (Python 3.10+)
cd backend
pip install -r requirements.txt
uvicorn app:app --port 8000

# frontend
cd frontend
npm install
npm run dev
```

Open http://localhost:9173.

See [docs/SETUP.md](docs/SETUP.md) for live-engine mode, baseline systems and tests.

## License

BSD 2-Clause License. See [LICENSE](LICENSE).
