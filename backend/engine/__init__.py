"""Query engine backends."""

from __future__ import annotations

from .base import EngineTimeout, QueryEngine
from .process import ProcessEngine

__all__ = ["EngineTimeout", "QueryEngine", "ProcessEngine", "create_engine"]


def create_engine(mode: str) -> QueryEngine:
    """Build the engine selected by ENGINE_MODE."""
    if mode == "process":
        return ProcessEngine()
    raise ValueError(f"Unknown ENGINE_MODE: {mode!r} (use 'process')")
