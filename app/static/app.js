// ---- state ----
let CLIENTS = [];
let PRESETS = [];
let CURRENT_PRESET = null;
let LAST_RESULTS = [];
let ACTIVE_TAB = 0;

// ---- init ----
async function init() {
  const [clients, presets, cfg] = await Promise.all([
    fetch("/api/clients").then(r => r.json()),
    fetch("/api/presets").then(r => r.json()),
    fetch("/api/config").then(r => r.json()),
  ]);
  CLIENTS = clients;
  PRESETS = presets;

  renderClients();
  renderPresets();
  renderSafetyBadge(cfg);

  document.getElementById("runBtn").addEventListener("click", runQuery);
  document.getElementById("selectAll").addEventListener("click", e => {
    e.preventDefault();
    document.querySelectorAll(".client-cb").forEach(cb => cb.checked = true);
  });
  document.getElementById("selectNone").addEventListener("click", e => {
    e.preventDefault();
    document.querySelectorAll(".client-cb").forEach(cb => cb.checked = false);
  });

  document.getElementById("sqlBox").addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      runQuery();
    }
  });
}

function renderSafetyBadge(cfg) {
  const el = document.getElementById("safetyBadge");
  el.innerHTML = `
    ${cfg.read_only ? "🔒 read-only" : "⚠ write-enabled"} ·
    timeout ${cfg.statement_timeout_seconds}s ·
    cap ${cfg.max_rows.toLocaleString()} rows
  `;
}

function renderClients() {
  const host = document.getElementById("clientList");
  if (CLIENTS.length === 0) {
    host.innerHTML = `<div class="muted">No clients configured. Edit <code>config.yaml</code>.</div>`;
    return;
  }
  host.innerHTML = CLIENTS.map(c => `
    <label>
      <input type="checkbox" class="client-cb" value="${c.name}" checked />
      <span class="client-label-row">
        ${escapeHtml(c.label)}
        <span class="client-info-btn" title="${escapeHtml(c.host)} / ${escapeHtml(c.database)}">ℹ</span>
      </span>
    </label>
  `).join("");
}

function renderPresets() {
  const host = document.getElementById("presetList");
  if (PRESETS.length === 0) {
    host.innerHTML = `<div class="muted">No presets. Edit <code>presets.yaml</code>.</div>`;
    return;
  }
  host.innerHTML = PRESETS.map(p => `
    <div class="preset" data-id="${p.id}">
      <div class="preset-title">${escapeHtml(p.title)}</div>
      <div class="preset-desc">${escapeHtml(p.description)}</div>
    </div>
  `).join("");
  host.querySelectorAll(".preset").forEach(el => {
    el.addEventListener("click", () => selectPreset(el.dataset.id));
  });
}

function selectPreset(id) {
  CURRENT_PRESET = PRESETS.find(p => p.id === id) || null;
  document.querySelectorAll(".preset").forEach(el => {
    el.classList.toggle("active", el.dataset.id === id);
  });
  document.getElementById("activePresetLabel").textContent =
    CURRENT_PRESET ? `Preset: ${CURRENT_PRESET.title}` : "Custom query";
  document.getElementById("sqlBox").value = CURRENT_PRESET ? CURRENT_PRESET.sql.trim() : "";
  renderParams(CURRENT_PRESET ? CURRENT_PRESET.params : []);
}

function renderParams(params) {
  const host = document.getElementById("paramsArea");
  host.innerHTML = params.map(p => `
    <div class="param-field">
      <label>:${escapeHtml(p.name)} ${p.hint ? `<span class="muted">— ${escapeHtml(p.hint)}</span>` : ""}</label>
      <input type="text" data-param="${escapeHtml(p.name)}" value="${escapeHtml(p.default ?? "")}" />
    </div>
  `).join("");
}

function collectParams() {
  const out = {};
  document.querySelectorAll("[data-param]").forEach(i => {
    out[i.dataset.param] = i.value;
  });
  return out;
}

function selectedClients() {
  return Array.from(document.querySelectorAll(".client-cb:checked")).map(cb => cb.value);
}

// ---- DML guard ----
const DML_RE = /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|CREATE|ALTER|REPLACE|MERGE|GRANT|REVOKE|EXECUTE|CALL|DO|COPY)\b/i;

function checkDML(sql) {
  const m = sql.match(DML_RE);
  return m ? m[0].toUpperCase() : null;
}

// ---- run ----
async function runQuery() {
  const sql = document.getElementById("sqlBox").value.trim();
  if (!sql) return;

  const forbidden = checkDML(sql);
  if (forbidden) {
    showQueryError(`DML/DDL not allowed: '${forbidden}' is forbidden. Only SELECT queries are permitted.`);
    return;
  }

  const clients = selectedClients();
  if (clients.length === 0) { alert("Select at least one client."); return; }

  const btn = document.getElementById("runBtn");
  btn.disabled = true;
  btn.textContent = "Running…";

  // show loading tabs immediately
  LAST_RESULTS = clients.map(name => ({ client: name, label: CLIENTS.find(x => x.name === name)?.label || name, loading: true }));
  ACTIVE_TAB = 0;
  renderTabs();

  try {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ sql, params: collectParams(), clients }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({detail: res.statusText}));
      document.getElementById("resultsPane").innerHTML =
        `<div class="empty-state" style="color:var(--err)">${escapeHtml(err.detail || "Error")}</div>`;
      return;
    }
    LAST_RESULTS = await res.json();
    ACTIVE_TAB = 0;
    renderTabs();
  } catch (e) {
    document.getElementById("resultsPane").innerHTML =
      `<div class="empty-state" style="color:var(--err)">${escapeHtml(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Run ▶";
  }
}

function showQueryError(msg) {
  document.getElementById("resultsPane").innerHTML =
    `<div class="empty-state" style="color:var(--err)">⛔ ${escapeHtml(msg)}</div>`;
}

// ---- tab UI ----
function renderTabs() {
  _JSON_STORE.length = 0;  // clear on each render
  const pane = document.getElementById("resultsPane");
  if (!LAST_RESULTS.length) {
    pane.innerHTML = `<div class="empty-state">Pick clients on the left, write or choose a query, hit <b>Run</b>.</div>`;
    return;
  }

  const tabsHtml = LAST_RESULTS.map((r, i) => {
    const isErr = !r.loading && !r.ok;
    const cls = `tab${i === ACTIVE_TAB ? " active" : ""}${isErr ? " tab-err" : ""}`;
    const badge = r.loading
      ? `<span class="tab-badge loading">…</span>`
      : r.ok
        ? `<span class="tab-badge ok">${r.row_count}</span>`
        : `<span class="tab-badge err">err</span>`;
    return `<div class="${cls}" data-tab="${i}">${escapeHtml(r.label)}${badge}</div>`;
  }).join("");

  const r = LAST_RESULTS[ACTIVE_TAB];
  const contentHtml = r.loading
    ? `<div class="tab-content-inner"><div class="empty-state">Running…</div></div>`
    : renderContent(r);

  pane.innerHTML = `
    <div class="tabs-shell">
      <div class="tab-bar">${tabsHtml}</div>
      <div class="tab-toolbar">${renderToolbar(r)}</div>
      <div class="tab-content">${contentHtml}</div>
    </div>
  `;

  // tab clicks
  pane.querySelectorAll(".tab[data-tab]").forEach(el => {
    el.addEventListener("click", () => {
      ACTIVE_TAB = Number(el.dataset.tab);
      renderTabs();
    });
  });

  // export buttons
  const exportCsvBtn = pane.querySelector("[data-export-csv]");
  if (exportCsvBtn) exportCsvBtn.addEventListener("click", () => exportCSV(LAST_RESULTS[ACTIVE_TAB]));
  const exportJsonBtn = pane.querySelector("[data-export-json]");
  if (exportJsonBtn) exportJsonBtn.addEventListener("click", () => exportJSON(LAST_RESULTS[ACTIVE_TAB]));
  const exportAllBtn = pane.querySelector("[data-export-all]");
  if (exportAllBtn) exportAllBtn.addEventListener("click", () => exportAllCSV(LAST_RESULTS));

  // click cell to expand (both kv-grid and normal table)
  pane.querySelectorAll(".kv-val, table.result td").forEach(td => {
    td.addEventListener("click", e => {
      if (e.target.closest(".json-view-btn, .copy-val-btn")) return;
      td.classList.toggle("expanded");
    });
  });

  // JSON view buttons
  pane.querySelectorAll(".json-view-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      openJsonModal(Number(btn.dataset.jidx));
    });
  });

  // Copy value buttons
  pane.querySelectorAll(".copy-val-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const raw = _JSON_STORE[Number(btn.dataset.jidx)];
      const text = fmt(raw);
      navigator.clipboard.writeText(text).then(() => {
        const orig = btn.textContent;
        btn.textContent = "✓";
        btn.classList.add("copied");
        setTimeout(() => { btn.textContent = orig; btn.classList.remove("copied"); }, 1200);
      });
    });
  });
}

function renderToolbar(r) {
  if (!r || r.loading) return "";
  const allBtn = `<button data-export-all>⬇ all clients CSV</button>`;
  if (!r.ok) return `<div class="tbar">${allBtn}</div>`;
  const trunc = r.truncated ? `<span class="trunc-warn">⚠ truncated</span>` : "";
  return `
    <div class="tbar">
      <span class="tbar-stat">${r.row_count.toLocaleString()} rows · ${r.elapsed_ms} ms · ${r.columns.length} columns</span>
      ${trunc}
      <button data-export-csv>⬇ CSV</button>
      <button data-export-json>⬇ JSON</button>
      ${allBtn}
    </div>
  `;
}

function renderContent(r) {
  if (!r.ok) return `<div class="tab-content-inner"><div class="error-body">${escapeHtml(r.error)}</div></div>`;
  if (!r.columns || r.rows.length === 0) return `<div class="tab-content-inner"><div class="no-rows">No rows returned.</div></div>`;
  return `<div class="tab-content-inner">${renderTable(r)}</div>`;
}

function renderTable(r) {
  // For wide tables (many columns): kv layout — each column is a row, each DB row is a column
  // This way all columns are always visible vertically
  if (r.columns.length > 6) {
    return renderKvGrid(r);
  }
  // Narrow tables: normal horizontal table
  const head = r.columns.map(c => `<th>${escapeHtml(c)}</th>`).join("");
  const rows = r.rows.map(row =>
    `<tr>${row.map(v => {
      const s = fmt(v);
      const cidx = storeJson(v);
      const jsonBtn = isJsonValue(v) ? ` <button class="json-view-btn" data-jidx="${cidx}">{ }</button>` : "";
      const copyBtn = ` <button class="copy-val-btn" data-jidx="${cidx}">⎘</button>`;
      return `<td title="${escapeHtml(s)}">${escapeHtml(s)}${jsonBtn}${copyBtn}</td>`;
    }).join("")}</tr>`
  ).join("");
  return `<table class="result"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

function isJsonValue(raw) {
  if (raw === null || raw === undefined) return false;
  if (typeof raw === "object") return true;
  if (typeof raw !== "string") return false;
  const s = raw.trim();
  if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
    try { JSON.parse(s); return true; } catch (_) { return false; }
  }
  return false;
}

function renderKvGrid(r) {
  const numRows = r.rows.length;
  const rowHeaders = numRows === 1
    ? ""
    : `<th class="kv-col-hdr"></th>` + r.rows.map((_, i) => `<th class="kv-col-hdr">Row ${i + 1}</th>`).join("");

  const bodyRows = r.columns.map((col, ci) => {
    const cells = r.rows.map((row) => {
      const raw = row[ci];
      const v = fmt(raw);
      const cidx = storeJson(raw);
      const jsonBtn = isJsonValue(raw)
        ? ` <button class="json-view-btn" data-jidx="${cidx}">{ }</button>`
        : "";
      const copyBtn = ` <button class="copy-val-btn" data-jidx="${cidx}">⎘</button>`;
      return `<td class="kv-val" title="${escapeHtml(v)}">${escapeHtml(v)}${jsonBtn}${copyBtn}</td>`;
    }).join("");
    return `<tr><th class="kv-key">${escapeHtml(col)}</th>${cells}</tr>`;
  }).join("");

  const thead = numRows > 1 ? `<thead><tr>${rowHeaders}</tr></thead>` : "";
  return `<table class="kv-grid">${thead}<tbody>${bodyRows}</tbody></table>`;
}

function fmt(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// ---- export ----
function exportCSV(r) {
  if (!r || !r.ok) return;
  download(`${r.client}.csv`, toCSV(r.columns, r.rows), "text/csv");
}
function exportJSON(r) {
  if (!r) return;
  const data = r.ok
    ? r.rows.map(row => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])))
    : { error: r.error };
  download(`${r.client}.json`, JSON.stringify(data, null, 2), "application/json");
}
function exportAllCSV(results) {
  const allCols = new Set();
  results.forEach(r => r.ok && r.columns.forEach(c => allCols.add(c)));
  const cols = ["_client", ...allCols];
  const rows = [];
  results.forEach(r => {
    if (!r.ok) return;
    r.rows.forEach(row => {
      const m = Object.fromEntries(r.columns.map((c, i) => [c, row[i]]));
      rows.push(cols.map(c => c === "_client" ? r.client : (m[c] ?? "")));
    });
  });
  download("all_clients.csv", toCSV(cols, rows), "text/csv");
}
function toCSV(cols, rows) {
  const esc = v => {
    const s = fmt(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map(esc).join(","), ...rows.map(r => r.map(esc).join(","))].join("\n");
}
function download(name, data, mime) {
  const blob = new Blob([data], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---- JSON modal ----
// Store pending JSON values by index to avoid attribute encoding issues
const _JSON_STORE = [];

function storeJson(raw) {
  const idx = _JSON_STORE.length;
  _JSON_STORE.push(raw);
  return idx;
}

function openJsonModal(idx) {
  const raw = _JSON_STORE[idx];
  let modal = document.getElementById("jsonModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "jsonModal";
    modal.innerHTML = `
      <div class="json-modal-backdrop"></div>
      <div class="json-modal-box">
        <div class="json-modal-header">
          <span>JSON Viewer</span>
          <button class="json-modal-close">✕</button>
        </div>
        <pre class="json-modal-body"></pre>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector(".json-modal-backdrop").addEventListener("click", closeJsonModal);
    modal.querySelector(".json-modal-close").addEventListener("click", closeJsonModal);
    document.addEventListener("keydown", e => { if (e.key === "Escape") closeJsonModal(); });
  }

  let parsed;
  try {
    parsed = (typeof raw === "string") ? JSON.parse(raw) : raw;
  } catch (_) {
    parsed = raw;
  }
  modal.querySelector(".json-modal-body").textContent = JSON.stringify(parsed, null, 2);
  modal.classList.add("open");
}

function closeJsonModal() {
  const modal = document.getElementById("jsonModal");
  if (modal) modal.classList.remove("open");
}

// ---- util ----
function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

init();
