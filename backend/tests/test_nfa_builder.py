"""Unit tests for the regex-to-NFA builder and the schema loader."""

from __future__ import annotations

from pathlib import Path


def test_nfa_builder_knows_star() -> None:
    """Verify that KNOWS* produces the expected single-state self-loop NFA."""
    from nfa_builder import regex_to_automaton

    result = regex_to_automaton("KNOWS*", "P1")
    assert result["states"] == ["q0"], f"Expected ['q0'], got {result['states']}"
    assert result["transitions"] == [["q0", "KNOWS-", "q0"]]
    assert result["initial_states"] == ["q0"]
    assert result["final_states"] == ["q0"]
    assert result["alphabets"] == ["KNOWS"]


def test_nfa_builder_concatenation() -> None:
    """Verify LIKES/REPLY_OF* builds a two-state chain."""
    from nfa_builder import regex_to_automaton

    result = regex_to_automaton("LIKES/REPLY_OF*", "P1")
    assert result["states"] == ["q0", "q1"]
    assert ["q0", "LIKES-", "q1"] in result["transitions"]
    assert ["q1", "REPLY_OF-", "q1"] in result["transitions"]
    assert result["initial_states"] == ["q0"]
    assert result["final_states"] == ["q1"]


def test_nfa_builder_optional() -> None:
    """Verify KNOWS/KNOWS? makes both tail states final."""
    from nfa_builder import regex_to_automaton

    result = regex_to_automaton("KNOWS/KNOWS?", "P1")
    assert result["states"] == ["q0", "q1", "q2"]
    assert result["initial_states"] == ["q0"]
    assert "q1" in result["final_states"]
    assert "q2" in result["final_states"]


def test_nfa_builder_multi_concat() -> None:
    """Verify KNOWS/HAS_INTEREST builds a three-state chain."""
    from nfa_builder import regex_to_automaton

    result = regex_to_automaton("KNOWS/HAS_INTEREST", "P1")
    assert result["states"] == ["q0", "q1", "q2"]
    assert ["q0", "KNOWS-", "q1"] in result["transitions"]
    assert ["q1", "HAS_INTEREST-", "q2"] in result["transitions"]


def test_nfa_builder_reverse() -> None:
    """Verify reverse direction produces -LABEL prefix."""
    from nfa_builder import regex_to_automaton

    result = regex_to_automaton("KNOWS", "P1", direction="reverse")
    assert result["transitions"] == [["q0", "-KNOWS", "q1"]]


def test_nfa_builder_length_constraints() -> None:
    """Verify length constraints are included in output."""
    from nfa_builder import regex_to_automaton

    result = regex_to_automaton("KNOWS*", "P1", min_length=2, max_length=4)
    assert result["min_length"] == 2
    assert result["max_length"] == 4


def test_nfa_builder_build_query() -> None:
    """Verify build_query_json produces the right structure."""
    from nfa_builder import build_query_json, regex_to_automaton

    p1 = regex_to_automaton("KNOWS*", "P1")
    p2 = regex_to_automaton("KNOWS*", "P2")
    query = build_query_json(
        vertices=["v1:Any", "v2:Any", "v3:Any", "v4:Any"],
        edges=["(v1)-[P1]->(v2)", "(v3)-[P2]->(v4)"],
        automata={"P1": p1, "P2": p2},
        we_constraints=[{"path1": "P1", "path2": "P2", "source_constraint": "same"}],
    )
    assert "query_vertices" in query
    assert "query_edges" in query
    assert "automata" in query
    assert "word_equality_constraints" in query


def test_schema_loader() -> None:
    """Verify schema loading from the project schema/ directory."""
    from schema_loader import get_schema_summary, load_schema

    schema_dir = str(Path(__file__).resolve().parents[2] / "schema")
    schema = load_schema("LDBC_SNB", schema_dir)
    assert "vertices" in schema
    assert "edges" in schema
    assert "undirected_edge_labels" in schema

    summary = get_schema_summary(schema)
    assert "Person" in summary["vertex_labels"]
    assert "KNOWS" in summary["edge_labels"]
    assert "KNOWS" in summary["undirected_edge_labels"]
