"""
Multi-DB query engine.

Responsibilities:
  - Load client DB configs from config.yaml
  - Maintain one connection pool per client (lazy)
  - Run the SAME query across selected clients in parallel
  - Enforce read-only + statement timeout + row cap
"""

from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import psycopg
import yaml
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool


# ---------- config ----------

@dataclass
class ClientConfig:
    name: str
    label: str
    host: str
    port: int
    database: str
    user: str
    password: str
    sslmode: str = "prefer"
    schema: str = "public"

    @property
    def conninfo(self) -> str:
        # psycopg conninfo string
        return (
            f"host={self.host} port={self.port} dbname={self.database} "
            f"user={self.user} password={self.password} sslmode={self.sslmode} "
            f"application_name=multidb-tool"
        )


@dataclass
class SafetyConfig:
    read_only: bool = True
    statement_timeout_seconds: int = 30
    max_rows: int = 5000
    max_concurrency: int = 8


@dataclass
class AppConfig:
    clients: list[ClientConfig] = field(default_factory=list)
    safety: SafetyConfig = field(default_factory=SafetyConfig)

    @classmethod
    def load(cls, path: str | Path) -> "AppConfig":
        with open(path, "r", encoding="utf-8") as f:
            raw = yaml.safe_load(f) or {}
        clients = [ClientConfig(**c) for c in raw.get("clients", [])]
        safety = SafetyConfig(**(raw.get("safety") or {}))
        return cls(clients=clients, safety=safety)


# ---------- query safety ----------

_MULTI_STMT = re.compile(r";\s*\S", re.DOTALL)

# DML/DDL keywords forbidden anywhere in the query (even inside CTEs)
_DML_PATTERN = re.compile(
    r"\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|CREATE|ALTER|REPLACE|MERGE"
    r"|GRANT|REVOKE|EXECUTE|CALL|DO|COPY)\b",
    re.IGNORECASE,
)

_READ_ONLY_ALLOWED = re.compile(
    r"^\s*(WITH|SELECT|EXPLAIN|SHOW|TABLE|VALUES)\b",
    re.IGNORECASE | re.DOTALL,
)


def validate_query(sql: str, read_only: bool) -> None:
    stripped = sql.strip().rstrip(";").strip()
    if not stripped:
        raise ValueError("Empty query.")
    if _MULTI_STMT.search(stripped):
        raise ValueError("Multiple statements are not allowed.")
    # Always block DML/DDL regardless of read_only flag
    m = _DML_PATTERN.search(stripped)
    if m:
        raise ValueError(
            f"DML/DDL not allowed: '{m.group().upper()}' is forbidden. "
            "Only SELECT queries are permitted."
        )
    if read_only and not _READ_ONLY_ALLOWED.match(stripped):
        raise ValueError(
            "Read-only mode: only SELECT / WITH / EXPLAIN / SHOW / TABLE / VALUES allowed."
        )


# ---------- result model ----------

@dataclass
class ClientResult:
    client: str          # internal name
    label: str           # display label
    ok: bool
    elapsed_ms: int
    columns: list[str] = field(default_factory=list)
    rows: list[list[Any]] = field(default_factory=list)
    row_count: int = 0
    truncated: bool = False
    error: str | None = None


# ---------- engine ----------

class MultiDBEngine:
    def __init__(self, cfg: AppConfig) -> None:
        self.cfg = cfg
        self._pools: dict[str, AsyncConnectionPool] = {}
        self._pool_lock = asyncio.Lock()

    async def _get_pool(self, client: ClientConfig) -> AsyncConnectionPool:
        async with self._pool_lock:
            pool = self._pools.get(client.name)
            if pool is None:
                pool = AsyncConnectionPool(
                    conninfo=client.conninfo,
                    min_size=0,
                    max_size=4,
                    open=False,
                    kwargs={"row_factory": dict_row},
                )
                await pool.open()
                self._pools[client.name] = pool
            return pool

    async def close(self) -> None:
        for pool in self._pools.values():
            await pool.close()
        self._pools.clear()

    def clients_by_names(self, names: list[str] | None) -> list[ClientConfig]:
        if not names:
            return list(self.cfg.clients)
        lookup = {c.name: c for c in self.cfg.clients}
        missing = [n for n in names if n not in lookup]
        if missing:
            raise ValueError(f"Unknown client(s): {', '.join(missing)}")
        return [lookup[n] for n in names]

    async def run(
        self,
        sql: str,
        params: dict[str, Any] | None,
        client_names: list[str] | None,
    ) -> list[ClientResult]:
        validate_query(sql, self.cfg.safety.read_only)
        targets = self.clients_by_names(client_names)
        sem = asyncio.Semaphore(self.cfg.safety.max_concurrency)

        async def run_one(c: ClientConfig) -> ClientResult:
            async with sem:
                return await self._run_on_client(c, sql, params or {})

        return await asyncio.gather(*(run_one(c) for c in targets))

    async def _run_on_client(
        self,
        client: ClientConfig,
        sql: str,
        params: dict[str, Any],
    ) -> ClientResult:
        start = time.monotonic()
        max_rows = self.cfg.safety.max_rows
        timeout_ms = self.cfg.safety.statement_timeout_seconds * 1000
        try:
            pool = await self._get_pool(client)
            async with pool.connection() as conn:
                # read-only tx + statement timeout + schema
                if self.cfg.safety.read_only:
                    await conn.set_read_only(True)
                async with conn.cursor() as cur:
                    await cur.execute(f"SET statement_timeout = {int(timeout_ms)}")
                    await cur.execute(f"SET search_path = {client.schema}")
                    await cur.execute(sql, params)
                    columns: list[str] = (
                        [d.name for d in cur.description] if cur.description else []
                    )
                    rows_raw: list[list[Any]] = []
                    truncated = False
                    if cur.description is not None:
                        fetched = await cur.fetchmany(max_rows + 1)
                        if len(fetched) > max_rows:
                            truncated = True
                            fetched = fetched[:max_rows]
                        rows_raw = [
                            [_to_jsonable(r.get(col)) for col in columns]
                            for r in fetched
                        ]
            elapsed_ms = int((time.monotonic() - start) * 1000)
            return ClientResult(
                client=client.name,
                label=client.label,
                ok=True,
                elapsed_ms=elapsed_ms,
                columns=columns,
                rows=rows_raw,
                row_count=len(rows_raw),
                truncated=truncated,
            )
        except Exception as e:  # noqa: BLE001 — we want to surface ANY DB error per client
            elapsed_ms = int((time.monotonic() - start) * 1000)
            return ClientResult(
                client=client.name,
                label=client.label,
                ok=False,
                elapsed_ms=elapsed_ms,
                error=f"{type(e).__name__}: {e}",
            )


def _to_jsonable(v: Any) -> Any:
    # psycopg already decodes most types; handle the few that aren't JSON-native.
    import datetime
    import decimal
    import uuid

    if v is None or isinstance(v, (str, int, float, bool, list, dict)):
        return v
    if isinstance(v, (decimal.Decimal,)):
        return str(v)
    if isinstance(v, (datetime.datetime, datetime.date, datetime.time)):
        return v.isoformat()
    if isinstance(v, (bytes, bytearray, memoryview)):
        return f"<{len(bytes(v))} bytes>"
    if isinstance(v, uuid.UUID):
        return str(v)
    return str(v)