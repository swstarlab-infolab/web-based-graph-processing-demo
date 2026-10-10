"""FastAPI application for the web graph demo backend."""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from config import (
    DATASETS,
    SCHEMA_DIR,
)
from schema_loader import get_schema_summary, load_schema


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BACKEND_DIR.parent
SCHEMA_PATH = PROJECT_ROOT / SCHEMA_DIR

app = FastAPI(title="Web Graph Demo")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class DatasetInfo(BaseModel):
    """Information about an available dataset."""

    id: str
    name: str
    schema: str
    loaded: bool


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/api/datasets")
async def get_datasets() -> list[DatasetInfo]:
    """Return available datasets with loading status."""
    result: list[DatasetInfo] = []
    for dataset_id, info in DATASETS.items():
        result.append(
            DatasetInfo(
                id=dataset_id,
                name=info["name"],
                schema=info["schema"],
                loaded=False,
            )
        )
    return result


@app.get("/api/schema/{dataset_id}")
async def get_schema(dataset_id: str) -> dict:
    """Return vertex/edge labels for a dataset.

    Args:
        dataset_id: Dataset identifier (e.g. "LDBC_SNB_SF1").
    """
    if dataset_id not in DATASETS:
        raise HTTPException(status_code=404, detail=f"Unknown dataset: {dataset_id}")

    schema_name = DATASETS[dataset_id]["schema"]
    try:
        schema = load_schema(schema_name, str(SCHEMA_PATH))
    except FileNotFoundError:
        raise HTTPException(
            status_code=404,
            detail=f"Schema file not found for {schema_name}",
        )
    return get_schema_summary(schema)


@app.get("/api/status")
async def get_status() -> dict:
    """Return server status."""
    return {"status": "ok"}
