"""End-to-end API tests against the mock engine."""

from __future__ import annotations

import os

os.environ.setdefault("ENGINE_MODE", "mock")

import pytest
from fastapi.testclient import TestClient

import app as app_module


@pytest.fixture(scope="module")
def client():
    with TestClient(app_module.app) as c:
        yield c


def test_status(client):
    body = client.get("/api/status").json()
    assert body["mode"] == "mock"


def test_datasets(client):
    ids = [d["id"] for d in client.get("/api/datasets").json()]
    assert "LDBC_SNB_SF1" in ids


def test_schema(client):
    body = client.get("/api/schema/LDBC_SNB_SF1").json()
    assert "KNOWS" in body["edge_labels"]
    assert client.get("/api/schema/UNKNOWN").status_code == 404


def test_presets_follow_catalog(client):
    body = client.get("/api/presets").json()
    assert body["groups"]
    assert all(p["catalog"] is not None for p in body["presets"])


def test_every_preset_has_a_recorded_result(client):
    presets = client.get("/api/presets").json()["presets"]
    for p in presets:
        r = client.post("/api/query", json={"query_json": p["content"]})
        assert r.status_code == 200, p["filename"]
        body = r.json()
        assert body["total_count"] > 0
        assert body["samples"]


def test_word_equality_samples_have_two_paths(client):
    presets = client.get("/api/presets").json()["presets"]
    we = next(p for p in presets if p["filename"].startswith("S6-"))
    body = client.post("/api/query", json={"query_json": we["content"]}).json()
    assert body["query_type"] == "word_equality"
    assert "path1" in body["samples"][0] and "path2" in body["samples"][0]


def test_unknown_query_is_rejected(client):
    q = {"query_vertices": ["a:Any", "b:Any"], "query_edges": ["(a)-[X]->(b)"]}
    r = client.post("/api/query", json={"query_json": q})
    assert r.status_code == 500


def test_nfa_endpoint(client):
    r = client.post("/api/nfa", json={"regex": "KNOWS*", "name": "P1"})
    assert r.status_code == 200
    assert r.json()["final_states"] == ["q0"]


def test_neighborhood_validation(client):
    assert client.post("/api/neighborhood", json={"vertex_ids": []}).status_code == 400
    assert client.post("/api/neighborhood", json={"vertex_ids": [1]}).status_code == 200
