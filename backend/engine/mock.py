"""Mock engine: replays recorded results so the demo runs without a GPU.

Each file in backend/samples holds one recorded answer:
    {"dataset_id": ..., "query": {...}, "result": {...}}
A query matches a recording when it describes the same pattern, regardless
of vertex names and edge order.
"""

from __future__ import annotations

import itertools
import json
import logging
import re
from pathlib import Path

from .base import QueryEngine

logger = logging.getLogger(__name__)

_EDGE_RE = re.compile(r"^\((\w+)\)(<?)-\[([^\]]+)\]-(>?)\((\w+)\)$")


def _vertex_constraint(c, ren: dict) -> str:
    """Rename the vertices of a "a<>b" style constraint."""
    if not isinstance(c, str):
        return json.dumps(c, sort_keys=True)
    m = re.match(r"^(\w+)\s*([<>=!]+)\s*(\w+)$", c)
    if not m:
        return c
    a, op, b = m.groups()
    ra, rb = ren.get(a, -1), ren.get(b, -1)
    if op in ("<>", "!=", "=="):
        ra, rb = sorted((ra, rb))
    return f"{ra}{op}{rb}"


def _canonical(query: dict) -> str:
    """Return a key that ignores vertex names, edge order and display-only keys.

    The frontend rebuilds a preset from its canvas before sending it, which
    renames vertices and reorders edges; both must still hit the recording.
    """
    automata = query.get("automata") or {}

    def path_repr(name: str) -> str:
        a = automata.get(name)
        if a is None:
            return "L:" + name
        return "A:%s|%s|%s" % (
            a.get("regular_expression", ""), a.get("min_length", 0), a.get("max_length", -1)
        )

    labels: dict[str, str] = {}
    for qv in query.get("query_vertices") or []:
        vid, _, label = qv.partition(":")
        labels[vid.strip()] = label.strip() or "Any"

    edges = []
    for qe in query.get("query_edges") or []:
        m = _EDGE_RE.match(qe.replace(" ", ""))
        if not m:
            edges.append((qe, path_repr(qe), qe))
            continue
        a, back, lbl, _fwd, b = m.groups()
        src, dst = (b, a) if back else (a, b)
        edges.append((src, lbl, dst))

    endpoints = {lbl: (s, d) for s, lbl, d in edges}
    constraints = []
    for c in query.get("word_equality_constraints") or []:
        constraints.append((
            c.get("type", "exact"), c.get("source_constraint", "same"),
            c.get("linking_label", ""), c.get("path1", ""), c.get("path2", ""),
        ))

    vids = sorted(labels) or sorted({v for s, _, d in edges for v in (s, d)})
    best = None
    for perm in itertools.permutations(range(len(vids))):
        ren = {v: perm[i] for i, v in enumerate(vids)}
        key = (
            tuple(sorted((ren.get(s, -1), path_repr(l), ren.get(d, -1)) for s, l, d in edges)),
            tuple(sorted((ren[v], labels.get(v, "Any")) for v in vids)),
            tuple(sorted(
                (t, sc, ll, path_repr(p1), tuple(ren.get(x, -1) for x in endpoints.get(p1, ())),
                 path_repr(p2), tuple(ren.get(x, -1) for x in endpoints.get(p2, ())))
                for t, sc, ll, p1, p2 in constraints
            )),
            tuple(sorted(_vertex_constraint(c, ren) for c in query.get("constraints") or [])),
        )
        if best is None or key < best:
            best = key
    return json.dumps(best)


class MockEngine(QueryEngine):
    """Answers queries from recorded results instead of running them."""

    def __init__(self, samples_dir: Path) -> None:
        self._results: dict[tuple[str, str], dict] = {}
        for path in sorted(samples_dir.glob("*.json")):
            try:
                with open(path) as f:
                    rec = json.load(f)
                key = (rec["dataset_id"], _canonical(rec["query"]))
                self._results[key] = rec["result"]
            except (OSError, KeyError, json.JSONDecodeError) as e:
                logger.warning("Skipping recorded result %s: %s", path.name, e)
        self.current_dataset = None
        logger.info("Mock engine loaded %d recorded results", len(self._results))

    async def run_query(
        self, query_json: str, dataset_id: str, config: dict, timeout: int = 300
    ) -> dict:
        key = (dataset_id, _canonical(json.loads(query_json)))
        result = self._results.get(key)
        if result is None:
            raise RuntimeError(
                "No recorded result for this query in mock mode. "
                "Pick a preset scenario, or set ENGINE_MODE=process to run it live."
            )
        self.current_dataset = dataset_id
        return result

    async def run_neighborhood(
        self, request: dict, dataset_id: str, config: dict, timeout: int = 60
    ) -> dict:
        # The graph itself is not available offline: answer with an empty context.
        return {
            "vertices": [],
            "edges": [],
            "max_per_vertex": request.get("max_per_vertex", 0),
            "truncated": False,
        }
