"""FastAPI application for the web graph demo backend."""

from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from config import (
    DATASETS,
)


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

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


@app.get("/api/status")
async def get_status() -> dict:
    """Return server status."""
    return {"status": "ok"}
