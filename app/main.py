"""
FastAPI web server exposing:
  GET  /           -> UI
  GET  /api/clients
  GET  /api/presets
  POST /api/run    -> { sql, params, clients } -> per-client results
  POST /api/export -> CSV export of last run (client-side handles this actually)
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field
from starlette.requests import Request

from .engine import AppConfig, MultiDBEngine
from .presets import load_presets

BASE_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = BASE_DIR / "config.yaml"
PRESETS_PATH = BASE_DIR / "presets.yaml"

cfg = AppConfig.load(CONFIG_PATH)
engine = MultiDBEngine(cfg)
presets = load_presets(PRESETS_PATH)


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await engine.close()


app = FastAPI(title="Multi-DB Query Tool", lifespan=lifespan)
templates = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))
app.mount("/static", StaticFiles(directory=str(Path(__file__).parent / "static")), name="static")


class RunRequest(BaseModel):
    sql: str = Field(..., min_length=1)
    params: dict[str, Any] = Field(default_factory=dict)
    clients: list[str] = Field(default_factory=list)  # empty = all


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(request, "index.html")


@app.get("/api/clients")
async def list_clients():
    return [
        {"name": c.name, "label": c.label, "database": c.database, "host": c.host}
        for c in cfg.clients
    ]


@app.get("/api/presets")
async def list_presets():
    return [
        {
            "id": p.id,
            "title": p.title,
            "description": p.description,
            "sql": p.sql,
            "params": [asdict(pp) for pp in p.params],
        }
        for p in presets
    ]


@app.get("/api/config")
async def get_config():
    return {
        "read_only": cfg.safety.read_only,
        "statement_timeout_seconds": cfg.safety.statement_timeout_seconds,
        "max_rows": cfg.safety.max_rows,
    }


@app.post("/api/run")
async def run_query(req: RunRequest):
    try:
        results = await engine.run(req.sql, req.params, req.clients or None)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return [asdict(r) for r in results]
