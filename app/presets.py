"""Load saved query presets from presets.yaml."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml


@dataclass
class PresetParam:
    name: str
    default: str = ""
    hint: str = ""


@dataclass
class Preset:
    id: str
    title: str
    description: str
    sql: str
    params: list[PresetParam] = field(default_factory=list)


def load_presets(path: str | Path) -> list[Preset]:
    p = Path(path)
    if not p.exists():
        return []
    with open(p, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    out: list[Preset] = []
    for r in raw.get("presets", []):
        params = [PresetParam(**pp) for pp in (r.get("params") or [])]
        out.append(
            Preset(
                id=r["id"],
                title=r.get("title", r["id"]),
                description=r.get("description", ""),
                sql=r["sql"],
                params=params,
            )
        )
    return out
