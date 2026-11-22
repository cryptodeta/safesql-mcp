/**
 * Source of the worker thread that owns the SQLite connections. It is plain JavaScript in a string so the
 * same code runs from TypeScript tests and from the bundled CLI without a separate file. Running SQLite in a
 * worker lets the main thread enforce a hard query timeout by terminating the worker.
 */
export const SQLITE_WORKER_SOURCE = String.raw`
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const originalEmit = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const text = String(warning && warning.message ? warning.message : warning);
  if (text.includes("SQLite")) return;
  return originalEmit.call(process, warning, ...rest);
};
const { DatabaseSync } = require("node:sqlite");

let ro = null;
let rw = null;

function openAll() {
  ro = new DatabaseSync(workerData.path, { readOnly: true });
  ro.exec("PRAGMA query_only = ON");
  try { ro.exec("PRAGMA trusted_schema = OFF"); } catch {}
  if (workerData.writable) {
    rw = new DatabaseSync(workerData.path);
    rw.exec("PRAGMA busy_timeout = 5000");
    try { rw.exec("PRAGMA trusted_schema = OFF"); } catch {}
  }
}

function norm(v) {
  if (typeof v === "bigint") {
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
  }
  if (v instanceof Uint8Array) return { $blob: v.length };
  return v;
}

function prep(db, sql) {
  const st = db.prepare(sql);
  if (typeof st.setReadBigInts === "function") st.setReadBigInts(true);
  let arrays = false;
  if (typeof st.setReturnArrays === "function") { st.setReturnArrays(true); arrays = true; }
  return { st, arrays };
}

function fieldsOf(st) {
  if (typeof st.columns !== "function") return null;
  return st.columns().map((c) => ({ name: c.name, table: c.table || undefined, column: c.column || undefined, schema: c.database || undefined, type: c.type || undefined }));
}

function rowToArray(row, arrays, names) {
  if (arrays) return row.map(norm);
  return names.map((n) => norm(row[n]));
}

function approxSize(row) {
  let n = 2;
  for (const v of row) n += v === null || v === undefined ? 5 : typeof v === "string" ? v.length + 3 : typeof v === "object" ? 24 : String(v).length + 1;
  return n;
}

function collect(st, arrays, params, offset, maxRows, maxBytes) {
  let fields = fieldsOf(st);
  const rows = [];
  let skipped = 0;
  let bytes = 0;
  let hasMore = false;
  let byteCapped = false;
  let names = fields ? fields.map((f) => f.name) : null;
  for (const row of st.iterate(...params)) {
    if (!names) { names = Object.keys(row); fields = names.map((n) => ({ name: n })); }
    if (skipped < offset) { skipped++; continue; }
    if (rows.length >= maxRows) { hasMore = true; break; }
    const arr = rowToArray(row, arrays, names);
    bytes += approxSize(arr);
    if (bytes > maxBytes && rows.length > 0) { hasMore = true; byteCapped = true; break; }
    rows.push(arr);
  }
  return { fields: fields || [], rows, hasMore, byteCapped };
}

function schema() {
  const db = ro;
  const objects = db.prepare("SELECT type, name, tbl_name, sql, rootpage FROM main.sqlite_schema ORDER BY name").all();
  let stats = new Map();
  try {
    for (const r of db.prepare("SELECT tbl, stat FROM main.sqlite_stat1").all()) {
      const n = Number(String(r.stat).split(" ")[0]);
      if (!stats.has(r.tbl) || n > stats.get(r.tbl)) stats.set(r.tbl, n);
    }
  } catch {}
  const tables = [];
  for (const o of objects) {
    if (o.type !== "table" && o.type !== "view") continue;
    if (o.name.startsWith("sqlite_")) continue;
    const sql = String(o.sql || "");
    const virtual = /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(sql);
    const q = (s) => s.replace(/"/g, '""');
    let cols = [];
    try { cols = db.prepare('PRAGMA main.table_xinfo("' + q(o.name) + '")').all(); } catch {}
    const columns = cols.filter((c) => Number(c.hidden) === 0 || Number(c.hidden) >= 2).map((c) => ({
      name: c.name, type: c.type || "", nullable: !Number(c.notnull) && !Number(c.pk), default: c.dflt_value, pk: Number(c.pk) > 0, pkOrder: Number(c.pk),
    }));
    const indexes = [];
    if (o.type === "table") {
      for (const ix of db.prepare('PRAGMA main.index_list("' + q(o.name) + '")').all()) {
        const info = db.prepare('PRAGMA main.index_xinfo("' + q(ix.name) + '")').all();
        indexes.push({ name: ix.name, unique: !!Number(ix.unique), primary: ix.origin === "pk", columns: info.filter((c) => Number(c.key) === 1).map((c) => c.name === null ? (Number(c.cid) === -2 ? "<expr>" : "rowid") : c.name) });
      }
    }
    const fkRows = o.type === "table" ? db.prepare('PRAGMA main.foreign_key_list("' + q(o.name) + '")').all() : [];
    const byId = new Map();
    for (const f of fkRows) {
      if (!byId.has(f.id)) byId.set(f.id, { columns: [], refSchema: "main", refTable: f.table, refColumns: [] });
      const fk = byId.get(f.id);
      fk.columns.push(f.from);
      fk.refColumns.push(f.to);
    }
    for (const fk of byId.values()) {
      if (fk.refColumns.some((c) => c === null)) {
        // references the primary key implicitly
        try {
          const pk = db.prepare('PRAGMA main.table_info("' + q(fk.refTable) + '")').all().filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((c) => c.name);
          fk.refColumns = fk.refColumns.map((c, i) => c === null ? (pk[i] || "rowid") : c);
        } catch {}
      }
    }
    tables.push({
      schema: "main", name: o.name, kind: o.type === "view" ? "view" : virtual ? "virtual table" : "table",
      rowEstimate: stats.has(o.name) ? stats.get(o.name) : null,
      columns: columns.map(({ pkOrder, ...c }) => c), indexes, foreignKeys: [...byId.values()],
      withoutRowid: /WITHOUT\s+ROWID\s*$/i.test(sql.trim()),
    });
  }
  return { engine: "sqlite", defaultSchema: "main", tables, loadedAt: Date.now() };
}

function access(sql, params) {
  const db = ro;
  const rows = db.prepare("EXPLAIN " + sql).all(...params);
  const objs = new Map();
  for (const o of db.prepare("SELECT type, name, tbl_name, rootpage, sql FROM main.sqlite_schema").all()) {
    objs.set(Number(o.rootpage), o);
  }
  const cursors = new Map();
  const tables = new Set();
  const columns = new Set();
  let partial = false;
  const colCache = new Map();
  const tableCols = (t) => {
    const key = "t:" + t;
    if (!colCache.has(key)) colCache.set(key, db.prepare('PRAGMA main.table_xinfo("' + t.replace(/"/g, '""') + '")').all());
    return colCache.get(key);
  };
  const indexCols = (i) => {
    const key = "i:" + i;
    if (!colCache.has(key)) colCache.set(key, db.prepare('PRAGMA main.index_xinfo("' + i.replace(/"/g, '""') + '")').all());
    return colCache.get(key);
  };
  for (const r of rows) {
    const op = r.opcode;
    if (op === "OpenRead" || op === "OpenWrite" || op === "ReopenIdx") {
      if (Number(r.p3) !== 0) { partial = true; continue; }
      const o = objs.get(Number(r.p2));
      if (r.p2 === 1 || Number(r.p2) === 1) { tables.add("sqlite_schema"); cursors.set(r.p1, { kind: "table", table: "sqlite_schema" }); continue; }
      if (!o) { partial = true; continue; }
      tables.add(o.tbl_name);
      if (o.type === "index") cursors.set(r.p1, { kind: "index", table: o.tbl_name, index: o.name });
      else {
        const wr = /WITHOUT\s+ROWID\s*$/i.test(String(o.sql || "").trim());
        cursors.set(r.p1, { kind: wr ? "worowid" : "table", table: o.tbl_name });
        if (wr) for (const c of tableCols(o.tbl_name)) columns.add(o.tbl_name + "." + c.name);
      }
    } else if (op === "VOpen") {
      partial = true;
    } else if (op === "Column" || op === "Rowid" || op === "IdxRowid") {
      const c = cursors.get(r.p1);
      if (!c) continue;
      if (op !== "Column") {
        const pk = tableCols(c.table).find((x) => Number(x.pk) === 1 && /^integer$/i.test(x.type));
        if (pk) columns.add(c.table + "." + pk.name);
        continue;
      }
      if (c.kind === "table") {
        const stored = tableCols(c.table).filter((x) => Number(x.hidden) !== 2);
        const col = stored[Number(r.p2)];
        if (col) columns.add(c.table + "." + col.name); else partial = true;
      } else if (c.kind === "index") {
        const info = indexCols(c.index).find((x) => Number(x.seqno) === Number(r.p2));
        if (info && info.name) columns.add(c.table + "." + info.name);
        else if (info && Number(info.cid) === -1) {
          const pk = tableCols(c.table).find((x) => Number(x.pk) === 1);
          if (pk) columns.add(c.table + "." + pk.name);
        }
      }
    }
  }
  return { tables: [...tables], columns: [...columns], partial };
}

function hasReturning(sql) { return /\bRETURNING\b/i.test(sql); }

function write(sql, params, dryRun, maxAffected, previewRows) {
  if (!rw) throw Object.assign(new Error("This database is open read-only."), { code: "READ_ONLY" });
  rw.exec("BEGIN IMMEDIATE");
  let committed = false;
  try {
    let returning;
    let affected = 0;
    let ran = false;
    if (dryRun && previewRows > 0 && !hasReturning(sql)) {
      let p = null;
      try { p = prep(rw, sql + " RETURNING *"); } catch {}
      if (p) {
        const res = collect(p.st, p.arrays, params, 0, previewRows, 200000);
        // drain remaining rows so the statement completes
        returning = res;
        ran = true;
      }
    }
    if (!ran) {
      const p = prep(rw, sql);
      if (hasReturning(sql)) returning = collect(p.st, p.arrays, params, 0, previewRows > 0 ? previewRows : 100, 200000);
      else p.st.run(...params);
    }
    affected = Number(rw.prepare("SELECT changes() AS n").get().n);
    if (dryRun) { rw.exec("ROLLBACK"); }
    else if (affected > maxAffected) {
      rw.exec("ROLLBACK");
      return { affected, returning, committed: false, overLimit: true };
    } else { rw.exec("COMMIT"); committed = true; }
    return { affected, returning, committed };
  } catch (err) {
    try { if (rw.isTransaction !== false) rw.exec("ROLLBACK"); } catch {}
    throw err;
  }
}

const handlers = {
  open() { openAll(); return { version: ro.prepare("SELECT sqlite_version() AS v").get().v }; },
  read({ sql, params, offset, maxRows, maxBytes }) { const p = prep(ro, sql); return collect(p.st, p.arrays, params || [], offset || 0, maxRows, maxBytes); },
  all({ sql, params }) { const st = ro.prepare(sql); if (st.setReadBigInts) st.setReadBigInts(true); return st.all(...(params || [])).map((r) => { const o = {}; for (const k of Object.keys(r)) o[k] = norm(r[k]); return o; }); },
  schema() { return schema(); },
  access({ sql, params }) { return access(sql, params || []); },
  write({ sql, params, dryRun, maxAffected, previewRows }) { return write(sql, params || [], dryRun, maxAffected, previewRows); },
  probe() { try { ro.exec("CREATE TABLE __safesql_probe(x)"); ro.exec("DROP TABLE __safesql_probe"); return { refused: false, message: "write succeeded" }; } catch (e) { return { refused: true, message: e.message }; } },
  close() { try { ro && ro.close(); } catch {} try { rw && rw.close(); } catch {} return true; },
};

parentPort.on("message", (msg) => {
  try {
    const result = handlers[msg.op](msg.args || {});
    parentPort.postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({ id: msg.id, ok: false, error: { message: err && err.message ? err.message : String(err), code: err && err.code } });
  }
});
`;
