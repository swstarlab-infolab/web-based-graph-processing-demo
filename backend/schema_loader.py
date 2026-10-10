"""Load graph schema JSON files for the web graph demo."""

from __future__ import annotations

import json
from pathlib import Path


# Map schema name to filename
SCHEMA_FILES: dict[str, str] = {
    "LDBC_SNB": "LDBC_SNB_schema.json",
    "stackoverflow": "stackoverflow_schema.json",
}


def load_schema(schema_name: str, schema_dir: str = "schema") -> dict:
    """Load vertex/edge labels from schema JSON file.

    Args:
        schema_name: Schema identifier (e.g. "LDBC_SNB", "stackoverflow").
        schema_dir: Directory containing schema JSON files.

    Returns:
        Parsed schema dict with "vertices", "edges", and
        "undirected_edge_labels" keys.
    """
    filename = SCHEMA_FILES.get(schema_name, f"{schema_name}_schema.json")
    filepath = Path(schema_dir) / filename
    with open(filepath) as f:
        return json.load(f)


def get_vertex_labels(schema: dict) -> list[str]:
    """Extract vertex label names from schema.

    Handles nested vertex types (e.g. Message -> Comment, Post) by
    collecting both the parent label and all child labels.

    Args:
        schema: Parsed schema dict.

    Returns:
        Sorted list of vertex label strings.
    """
    labels: list[str] = []
    for key, value in schema.get("vertices", {}).items():
        labels.append(key)
        # Nested subtypes: e.g. "Message": {"Comment": "Comment.csv", "Post": "Post.csv"}
        if isinstance(value, dict):
            labels.extend(value.keys())
    return sorted(labels)


def get_edge_labels(schema: dict) -> list[str]:
    """Extract edge label names from schema.

    Args:
        schema: Parsed schema dict.

    Returns:
        Sorted list of edge label strings.
    """
    return sorted(schema.get("edges", {}).keys())


def get_undirected_edge_labels(schema: dict) -> list[str]:
    """Return edge labels declared as undirected.

    Args:
        schema: Parsed schema dict.

    Returns:
        List of undirected edge label strings.
    """
    return list(schema.get("undirected_edge_labels", []))


def get_edge_endpoints(schema: dict) -> dict[str, list[dict[str, str]]]:
    """Extract source/target vertex types for each edge label from CSV filenames.

    CSV filenames follow the pattern: Source_edgeLabel_Target.csv
    e.g. "Person_knows_Person.csv" -> KNOWS: {source: Person, target: Person}

    Args:
        schema: Parsed schema dict.

    Returns:
        Dict mapping edge labels to lists of {source, target} endpoint pairs.
    """
    endpoints: dict[str, list[dict[str, str]]] = {}
    for edge_label, csv_files in schema.get("edges", {}).items():
        if isinstance(csv_files, str):
            csv_files = [csv_files]
        pairs: list[dict[str, str]] = []
        for csv_file in csv_files:
            # Parse "Source_edgeLabel_Target.csv"
            name = csv_file.rsplit(".", 1)[0]  # remove .csv
            parts = name.split("_")
            if len(parts) >= 3:
                pairs.append({"source": parts[0], "target": parts[-1]})
        endpoints[edge_label] = pairs
    return endpoints


def get_schema_summary(schema: dict) -> dict:
    """Build a summary of the schema suitable for API responses.

    Args:
        schema: Parsed schema dict.

    Returns:
        Dict with vertex_labels, edge_labels, undirected_edge_labels,
        and edge_endpoints.
    """
    return {
        "vertex_labels": get_vertex_labels(schema),
        "edge_labels": get_edge_labels(schema),
        "undirected_edge_labels": get_undirected_edge_labels(schema),
        "edge_endpoints": get_edge_endpoints(schema),
    }
