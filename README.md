# Multi-DB Query Tool

A lightweight web app to run one SQL query across **many PostgreSQL databases simultaneously** and compare results side-by-side. Built for debugging issues that only appear on some clients.

## Features

### Query & Results
- Register any number of client databases in `config.yaml`, select any subset per run
- Runs one SQL query across all selected clients **in parallel**
- Tab-based results UI — one tab per client with status badge, row count, and query time
- **Wide-schema display**: queries returning >6 columns are automatically shown in a transposed key-value grid (columns as rows) so all fields are visible without horizontal scrolling
- Click any cell to **expand** its full value in-place
- **JSON viewer**: cells containing JSON objects/arrays get a `{ }` button that opens a formatted modal
- **Copy button** on every cell (⎘) — copies the raw value to clipboard with a ✓ flash confirmation

### Saved Queries (Presets)
- Define reusable queries in `presets.yaml` with `:param` placeholders
- UI auto-generates input fields for each parameter
- Parameters passed as bind variables — no string interpolation, no SQL injection risk

### Export
- Per-client **CSV** or **JSON** export
- **Combined CSV** across all clients with a `_client` column for easy diffing in Excel/Sheets

### Keyboard
- `Ctrl+Enter` / `Cmd+Enter` in the SQL editor to run

---

## Security

Two-layer DML/DDL guard — blocked at both frontend and backend:

**Frontend (instant feedback):**
- Regex check blocks `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `DROP`, `CREATE`, `ALTER`, `REPLACE`, `MERGE`, `GRANT`, `REVOKE`, `EXECUTE`, `CALL`, `DO`, `COPY` before the request is even sent

**Backend (always enforced):**
- Same DML/DDL keyword check applied server-side regardless of client
- Multi-statement queries (`;` followed by more SQL) are blocked
- In `read_only: true` mode, only `SELECT / WITH / EXPLAIN / SHOW / TABLE / VALUES` are accepted
- Queries run inside a **read-only PostgreSQL transaction** (`SET TRANSACTION READ ONLY`)
- Per-query **statement timeout** kills runaway queries at the DB level
- Hard **row cap** per client prevents UI blowup on large result sets
- `config.yaml` is gitignored — credentials never committed

---

## Setup

```bash
git clone <repo>
cd multidb-tool
python -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp config.yaml.example config.yaml
# edit config.yaml with your DB credentials
```

**Use a read-only PostgreSQL user** for each client. The app also enforces read-only at the transaction level, but defence-in-depth matters:

```sql
CREATE USER readonly_user WITH PASSWORD '...';
GRANT CONNECT ON DATABASE your_db TO readonly_user;
GRANT USAGE ON SCHEMA your_schema TO readonly_user;
GRANT SELECT ON ALL TABLES IN SCHEMA your_schema TO readonly_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA your_schema GRANT SELECT ON TABLES TO readonly_user;
```

---

## Run

```bash
.venv/bin/uvicorn app.main:app --port 8000
```

Open [http://localhost:8000](http://localhost:8000).

---

## Configuration

### `config.yaml`

```yaml
clients:
  - name: CLIENT_ONE          # internal ID (used in exports)
    label: "Client One (SB)"  # display name in UI
    host: your-cluster.rds.amazonaws.com
    port: 5432
    database: your_database
    user: readonly_user
    password: "your_password"
    sslmode: prefer
    schema: your_schema        # sets search_path per query

safety:
  read_only: true                 # block all DML/DDL
  statement_timeout_seconds: 30   # kill slow queries
  max_rows: 5000                  # row cap per client
  max_concurrency: 8              # parallel DB connections
```

### `presets.yaml`

```yaml
- id: my_check
  title: "Check something"
  description: "What this query finds."
  sql: |
    SELECT * FROM my_table WHERE col = :val LIMIT 100;
  params:
    - name: val
      default: ""
      hint: "value to search for"
```

---

## Project Layout

```
multidb-tool/
├── config.yaml.example    # template — copy to config.yaml
├── presets.yaml           # saved queries shown in sidebar
├── requirements.txt
└── app/
    ├── main.py            # FastAPI routes
    ├── engine.py          # parallel query execution + safety validation
    ├── presets.py         # preset loader
    ├── templates/
    │   └── index.html
    └── static/
        ├── app.js
        └── styles.css
```

---

## Notes

- Binary columns render as `<N bytes>` placeholder; download JSON for actual bytes
- If a client is unreachable or errors, its tab shows the error — other clients still return normally
- `presets.yaml` queries using `:updated_at` or column names assume your schema matches — adjust as needed
