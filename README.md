# Multi-DB Query Tool

A small web app to query **many client PostgreSQL databases at once** and see results side-by-side. Built for debugging issues that only show up for one/some clients.

## Features

- Register N client databases in `config.yaml`, select any subset per run.
- Run one SQL query across all selected clients **in parallel**.
- Results rendered as one card per client with status, row count, timing.
- **Read-only safety**: only `SELECT / WITH / EXPLAIN / SHOW` allowed; statement timeout + row cap enforced server-side.
- **Saved queries** (`presets.yaml`) with parameter placeholders — pre-loaded with diagnostics for your `object_repository` / `service_registry` / `service_interaction` tables, including orphan-row and missing-reference checks.
- Export per-client CSV / JSON, or a combined CSV with a `_client` column.
- `Ctrl/Cmd+Enter` in the editor to run.

## Setup

```bash
cd multidb-tool
python -m venv .venv
source .venv/bin/activate            # (Windows: .venv\Scripts\activate)
pip install -r requirements.txt
```

Edit `config.yaml` and add one entry per client DB. **Use a read-only PostgreSQL user** for each — the app also enforces read-only at the transaction level, but defence-in-depth is good:

```sql
CREATE USER readonly_user WITH PASSWORD '...';
GRANT CONNECT ON DATABASE client_a_db TO readonly_user;
GRANT USAGE ON SCHEMA public TO readonly_user;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO readonly_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO readonly_user;
```

## Run

```bash
uvicorn app.main:app --reload --port 8000
```

Open http://localhost:8000.

## Adding a saved query

Edit `presets.yaml`:

```yaml
- id: my_check
  title: "Check something"
  description: "What this query finds."
  sql: |
    SELECT * FROM my_table WHERE col = :val LIMIT 100;
  params:
    - name: val
      default: ""
      hint: "what to search for"
```

Use `:name` placeholders; the UI generates input fields automatically. Parameters are passed safely as bind params (no string interpolation, so no SQL injection).

## Customizing safety

In `config.yaml` under `safety:`:

- `read_only: true` — only read queries allowed. Flip to `false` only if you truly need it (e.g. dry-running fixes), and understand every connected client will be writable.
- `statement_timeout_seconds` — kills slow queries.
- `max_rows` — hard cap per client to protect the UI.
- `max_concurrency` — how many DBs queried at once.

## Layout

```
multidb-tool/
├── config.yaml            # client DB connections + safety settings
├── presets.yaml           # saved queries
├── requirements.txt
└── app/
    ├── main.py            # FastAPI routes
    ├── engine.py          # multi-DB query execution
    ├── presets.py         # preset loader
    ├── templates/
    │   └── index.html
    └── static/
        ├── app.js
        └── styles.css
```

## Notes / gotchas

- The `recent_changes` preset assumes an `updated_at` column. Rename if your schema differs.
- Big `TEXT` / `JSONB` values are truncated in the table view for readability — full values go into CSV/JSON export.
- Binary columns render as `<N bytes>` placeholder.
- If a client is unreachable, its card shows the error; the other clients still return normally.
