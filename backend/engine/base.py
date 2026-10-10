"""Common interface every query engine backend implements."""

from __future__ import annotations

from abc import ABC, abstractmethod


class EngineTimeout(RuntimeError):
    """The engine did not answer within the request's timeout."""


class QueryEngine(ABC):
    """A graph query engine the API server can send requests to.

    Requests and answers are plain JSON documents:
      - run_query: query JSON in, result JSON
        ({total_count, elapsed_ms, query_type, samples, ...}) out
      - run_neighborhood: {vertex_ids, max_per_vertex, edge_labels} in,
        {vertices, edges, max_per_vertex, truncated} out
    """

    current_dataset: str | None = None

    @abstractmethod
    async def run_query(
        self, query_json: str, dataset_id: str, config: dict, timeout: int = 300
    ) -> dict:
        ...

    @abstractmethod
    async def run_neighborhood(
        self, request: dict, dataset_id: str, config: dict, timeout: int = 60
    ) -> dict:
        ...

    async def preload(self, dataset_ids: list[str], config: dict) -> None:
        """Load datasets ahead of the first query (optional)."""

    async def shutdown(self) -> None:
        """Release engine resources (optional)."""

    def memory_gb(self, dataset_id: str) -> dict:
        """Live memory footprint for the dataset, or {} if unknown."""
        return {}
