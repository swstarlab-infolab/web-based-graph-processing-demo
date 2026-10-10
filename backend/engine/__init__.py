"""Query engine backends."""

from __future__ import annotations

from pathlib import Path

from .base import EngineTimeout, QueryEngine
from .mock import MockEngine
from .process import ProcessEngine

__all__ = ["EngineTimeout", "QueryEngine", "MockEngine", "ProcessEngine", "create_engine"]


def create_engine(mode: str, samples_dir: Path) -> QueryEngine:
    """Build the engine selected by ENGINE_MODE."""
    if mode == "process":
        return ProcessEngine()
    if mode == "mock":
        return MockEngine(samples_dir)
    raise ValueError(f"Unknown ENGINE_MODE: {mode!r} (use 'mock' or 'process')")
