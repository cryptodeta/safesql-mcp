import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { AuditLog } from "./audit.js";
import type { Limits, ResolvedConfig, ResolvedDatabase, SavedQuery } from "./config.js";
import { PostgresDriver } from "./drivers/postgres.js";
import { SqliteDriver } from "./drivers/sqlite.js";
import { SafeSqlError, toSafeSqlError } from "./errors.js";
import { cellText, formatCount, type ResultFormat, renderRows, serializeExport, shortType } from "./format.js";
import { type Analysis, analyzeSql, stripTrailingSemicolon } from "./guard.js";
import { maskEmail, Policy, REDACTED } from "./policy.js";
import { suggest } from "./suggest.js";
import type { Driver, FieldOrigin, Mode, RawResult, SchemaModel, TableInfo } from "./types.js";

export interface Database {
  name: string;
  config: ResolvedDatabase;
  driver: Driver;
  policy: Policy;
  limits: Limits;
  mode: Mode;
  schema?: SchemaModel;
  schemaAt?: number;
}

export interface QueryResult {
  db: string;
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  offset: number;
  hasMore: boolean;
  nextOffset?: number;
  byteCapped?: boolean;
  redacted: string[];
  ms: number;
  verb: string;
}

export interface ExecuteResult {
  db: string;
  verb: string;
  kind: "write" | "ddl";
  dryRun: boolean;
  affected: number;
  committed: boolean;
  confirmToken?: string;
  expiresInSec?: number;
  preview?: { columns: string[]; rows: unknown[][]; hasMore: boolean };
  warnings: string[];
  ms: number;
}

interface PendingConfirm {
  db: string;
  sql: string;
  params: string;
  expires: number;
  affected: number;
}

const SCHEMA_TTL_MS = 5 * 60_000;
const CONFIRM_TTL_MS = 10 * 60_000;

function q(engine: "sqlite" | "postgres", name: string): string {
  void engine;
  return `"${name.replaceAll('"', '""')}"`;
}

export function displayTable(t: TableInfo, defaultSchema: string): string {
  return t.schema === defaultSchema ? t.name : `${t.schema}.${t.name}`;
}

export class SafeSql {
  readonly databases = new Map<string, Database>();
  readonly audit: AuditLog;
  readonly config: ResolvedConfig;
  private confirms = new Map<string, PendingConfirm>();
  private savedFile: string;

  constructor(config: ResolvedConfig, drivers?: Map<string, Driver>) {
    this.config = config;
    this.audit = new AuditLog(config.auditLog);
    this.savedFile = join(config.stateDir, "queries.json");
    for (const db of config.databases) {
      const writable = db.mode !== "read";
      const driver =
        drivers?.get(db.name) ??
        (db.engine === "sqlite" ? new SqliteDriver({ path: db.target, writable }) : new PostgresDriver({ url: db.target, writable }));
      this.databases.set(db.name, {
        name: db.name,
        config: db,
        driver,
        policy: new Policy(db.policy, db.engine),
        limits: db.limits,
        mode: db.mode,
      });
    }
  }

  get anyWritable(): boolean {
    return [...this.databases.values()].some((d) => d.mode !== "read");
  }

  /** Remove credentials from any text before it reaches the model. */
  scrub(text: string): string {
    let out = text;
    for (const s of this.config.secrets) out = out.split(s).join("***");
    for (const d of this.databases.values()) if (d.config.engine === "postgres") out = out.split(d.config.target).join(d.config.display);
    return out;
  }

  db(name?: string): Database {
    if (!this.databases.size)
      throw new SafeSqlError(
        "CONFIG",
        "No databases are configured.",
        "Start the server with a SQLite file or postgres:// URL, e.g. `safesql-mcp ./app.db`, or set DATABASE_URL.",
      );
    if (!name) {
      if (this.databases.size === 1) return [...this.databases.values()][0]!;
      throw new SafeSqlError(
        "BAD_INPUT",
        `Several databases are connected; say which one with "db": ${[...this.databases.keys()].join(", ")}.`,
      );
    }
    const d = this.databases.get(name) ?? [...this.databases.values()].find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!d) {
      const s = suggest(name, this.databases.keys());
      throw new SafeSqlError(
        "UNKNOWN_DATABASE",
        `No database named "${name}".`,
        s.length
          ? `Did you mean ${s.map((x) => `"${x}"`).join(" or ")}? Connected: ${[...this.databases.keys()].join(", ")}`
          : `Connected: ${[...this.databases.keys()].join(", ")}`,
      );
    }
    return d;
  }

  async close(): Promise<void> {
    await Promise.all([...this.databases.values()].map((d) => d.driver.close().catch(() => undefined)));
  }

  // ---------------------------------------------------------------- schema

  async schema(dbName?: string, refresh = false): Promise<SchemaModel> {
    const d = this.db(dbName);
    if (!refresh && d.schema && d.schemaAt && Date.now() - d.schemaAt < SCHEMA_TTL_MS) return d.schema;
    const s = await d.driver.loadSchema();
    d.schema = s;
    d.schemaAt = Date.now();
    return s;
  }

  /** Tables visible under the policy, with denied columns removed. */
  async visibleTables(dbName?: string, refresh = false): Promise<TableInfo[]> {
    const d = this.db(dbName);
    const s = await this.schema(d.name, refresh);
    return s.tables
      .filter((t) => d.policy.tableAllowed(t.schema, t.name))
      .map((t) => ({ ...t, columns: t.columns.filter((c) => !d.policy.columnDenied(t.schema, t.name, c.name)) }));
  }

  async resolveTable(dbName: string | undefined, name: string): Promise<{ d: Database; table: TableInfo; schema: SchemaModel }> {
    const d = this.db(dbName);
    const schema = await this.schema(d.name);
    const tables = await this.visibleTables(d.name);
    const clean = name.trim().replace(/^["`[]|["`\]]$/g, "");
    const parts = clean.split(".");
    const tname = parts.pop()!;
    const sname = parts.pop();
    const match = (t: TableInfo, exact: boolean) =>
      (exact ? t.name === tname : t.name.toLowerCase() === tname.toLowerCase()) &&
      (sname ? (exact ? t.schema === sname : t.schema.toLowerCase() === sname.toLowerCase()) : true);
    let found = tables.filter((t) => match(t, true));
    if (!found.length) found = tables.filter((t) => match(t, false));
    if (found.length > 1 && !sname)
      found = found.filter((t) => t.schema === schema.defaultSchema).concat(found.filter((t) => t.schema !== schema.defaultSchema));
    const table = found[0];
    if (!table) {
      const hidden = schema.tables.find((t) => match(t, false));
      if (hidden) throw new SafeSqlError("POLICY", `Table "${name}" is not available: it is blocked by this server's policy.`);
      const s = suggest(
        clean,
        tables.map((t) => displayTable(t, schema.defaultSchema)),
      );
      throw new SafeSqlError(
        "UNKNOWN_TABLE",
        `No table or view named "${name}" in ${d.name}.`,
        s.length ? `Did you mean ${s.map((x) => `"${x}"`).join(" or ")}?` : "Use list_tables or search_schema to find the right name.",
      );
    }
    return { d, table, schema };
  }

  // ---------------------------------------------------------------- guard + policy

  private analyze(d: Database, sql: string): Analysis {
    return analyzeSql(stripTrailingSemicolon(sql), d.config.engine);
  }

  private async enforcePolicy(d: Database, a: Analysis, params: unknown[] | undefined): Promise<void> {
    if (!d.policy.restrictive) return;
    const lexical = d.policy.lexicalViolation(a.identifiers);
    if (lexical)
      throw new SafeSqlError(
        "POLICY",
        `The query mentions "${lexical}", which this server's policy blocks.`,
        "Remove that table or column from the query.",
      );
    const schema = await this.schema(d.name);
    let access: Awaited<ReturnType<Driver["access"]>>;
    try {
      access = await d.driver.access(a.sql, params, schema);
    } catch (err) {
      const e = toSafeSqlError(err);
      if (e.code === "SQL_ERROR") throw await this.withSuggestions(d, e);
      throw e;
    }
    const v = d.policy.accessViolation(access.tables, access.columns, schema.defaultSchema);
    if (!v) return;
    if (v.startsWith("column ")) {
      const [tname] = v.slice(7).split(".");
      const t = schema.tables.find((x) => x.name === tname);
      const allowed = t?.columns.filter((c) => !d.policy.columnDenied(t.schema, t.name, c.name)).map((c) => c.name) ?? [];
      throw new SafeSqlError(
        "POLICY",
        `The query reads ${v}, which this server's policy blocks (SELECT * and whole-row references include it).`,
        allowed.length
          ? `List the columns you need instead. Allowed columns of ${tname}: ${allowed.join(", ")}`
          : "Remove it from the query.",
      );
    }
    throw new SafeSqlError(
      "POLICY",
      `The query reads ${v}, which this server's policy blocks.`,
      "Remove it from the query; it is not available to this assistant.",
    );
  }

  /** Add did-you-mean hints to "no such table/column" errors. */
  private async withSuggestions(d: Database, e: SafeSqlError): Promise<SafeSqlError> {
    if (e.code !== "SQL_ERROR") return e;
    const m = /no such table: (?:\w+\.)?(\S+)/i.exec(e.message) ?? /relation "([^"]+)" does not exist/i.exec(e.message);
    const c = /no such column: (\S+)/i.exec(e.message) ?? /column "?([^"\s]+)"? does not exist/i.exec(e.message);
    const syntax = /near "([^"]+)": syntax error/i.exec(e.message) ?? /syntax error at or near "([^"]+)"/i.exec(e.message);
    try {
      const tables = await this.visibleTables(d.name);
      const schema = await this.schema(d.name);
      if (m) {
        const s = suggest(
          m[1]!.split(".").pop()!,
          tables.map((t) => displayTable(t, schema.defaultSchema)),
        );
        if (s.length) return new SafeSqlError("SQL_ERROR", e.message, `Did you mean ${s.map((x) => `"${x}"`).join(" or ")}?`);
      }
      if (syntax) {
        const s = suggest(
          syntax[1]!,
          tables.map((t) => displayTable(t, schema.defaultSchema)),
        );
        if (s.length)
          return new SafeSqlError(
            "SQL_ERROR",
            e.message,
            `Did you mean the table ${s.map((x) => `"${x}"`).join(" or ")}? Reserved words used as names must be double-quoted.`,
          );
      }
      if (c) {
        const raw = c[1]!.replace(/^[^.]+\./, "");
        const cols = new Set<string>();
        for (const t of tables) for (const col of t.columns) cols.add(col.name);
        const s = suggest(raw, cols);
        if (s.length) {
          const where = tables
            .filter((t) => t.columns.some((col) => s.includes(col.name)))
            .slice(0, 3)
            .map((t) => t.name);
          return new SafeSqlError(
            "SQL_ERROR",
            e.message,
            `Did you mean ${s.map((x) => `"${x}"`).join(" or ")}? (found in ${where.join(", ")})`,
          );
        }
      }
    } catch {
      // keep original error
    }
    return e;
  }

  private redact(d: Database, fields: FieldOrigin[], rows: unknown[][]): string[] {
    const redacted: string[] = [];
    const masks = fields.map((f) => {
      const col = f.column ?? f.name;
      if (
        d.policy.columnRedacted(f.schema, f.table, col) ||
        (f.column && d.policy.columnRedacted(f.schema, f.table, f.name)) ||
        d.policy.columnRedacted(f.schema, f.table, f.name)
      ) {
        redacted.push(f.name);
        return "redact" as const;
      }
      if (d.policy.isEmailColumn(col) || d.policy.isEmailColumn(f.name)) {
        redacted.push(`${f.name} (masked)`);
        return "email" as const;
      }
      return undefined;
    });
    if (!redacted.length) return redacted;
    for (const r of rows)
      masks.forEach((m, i) => {
        if (!m || r[i] === null || r[i] === undefined) return;
        r[i] = m === "redact" ? REDACTED : maskEmail(r[i]);
      });
    return redacted;
  }

  private dropDeniedColumns(d: Database, fields: FieldOrigin[], rows: unknown[][]): FieldOrigin[] {
    if (!d.policy.cfg.denyColumns.length) return fields;
    const keep = fields.map((f) => !(f.table && f.column && d.policy.columnDenied(f.schema ?? "main", f.table, f.column)));
    if (keep.every(Boolean)) return fields;
    for (let r = 0; r < rows.length; r++) rows[r] = rows[r]!.filter((_, i) => keep[i]);
    return fields.filter((_, i) => keep[i]);
  }

  // ---------------------------------------------------------------- read

  async query(
    dbName: string | undefined,
    sqlIn: string,
    o: { params?: unknown[]; maxRows?: number; offset?: number; timeoutMs?: number; tool?: string; internal?: boolean } = {},
  ): Promise<QueryResult> {
    const d = this.db(dbName);
    const started = performance.now();
    let a: Analysis | undefined;
    try {
      a = this.analyze(d, sqlIn);
      if (a.kind !== "read") {
        const how =
          d.mode === "read"
            ? `This database is read-only. ${a.verb} statements need ${a.kind === "ddl" ? "admin mode (--admin)" : "write mode (--write)"} and the execute tool.`
            : `Use the execute tool for ${a.verb}; it previews the change first.`;
        throw new SafeSqlError(
          "READ_ONLY",
          `"${a.verb}" changes ${a.kind === "ddl" ? "the schema" : "data"}, so it cannot run as a query.`,
          how,
        );
      }
      if (a.explainAnalyze && d.config.engine === "postgres") {
        // allowed: EXPLAIN ANALYZE of a read inside a READ ONLY transaction
      }
      await this.enforcePolicy(d, a, o.params);
      const maxRows = Math.min(Math.max(1, Math.floor(o.maxRows ?? d.limits.maxRows)), o.internal ? 5_000_000 : 10_000);
      const offset = Math.max(0, Math.floor(o.offset ?? 0));
      let raw: RawResult;
      try {
        raw = await d.driver.read(a.sql, {
          params: o.params,
          maxRows,
          offset,
          timeoutMs: o.timeoutMs ? Math.min(o.timeoutMs, d.limits.timeoutMs) : d.limits.timeoutMs,
          maxBytes: o.internal ? 1_000_000_000 : d.limits.maxBytes,
        });
      } catch (err) {
        throw await this.withSuggestions(d, toSafeSqlError(err));
      }
      const fields = this.dropDeniedColumns(d, raw.fields, raw.rows);
      const redacted = this.redact(d, fields, raw.rows);
      const ms = performance.now() - started;
      const res: QueryResult = {
        db: d.name,
        columns: fields.map((f) => f.name),
        rows: raw.rows,
        rowCount: raw.rows.length,
        offset,
        hasMore: raw.hasMore,
        nextOffset: raw.hasMore ? offset + raw.rows.length : undefined,
        byteCapped: raw.byteCapped,
        redacted,
        ms,
        verb: a.verb,
      };
      if (!o.internal)
        this.audit.record({
          db: d.name,
          tool: o.tool ?? "query",
          kind: "read",
          verb: a.verb,
          sql: a.sql,
          params: o.params?.length,
          ok: true,
          rows: res.rowCount,
          ms: Math.round(ms),
        });
      return res;
    } catch (err) {
      const e = toSafeSqlError(err);
      this.audit.record({
        db: d.name,
        tool: o.tool ?? "query",
        kind: a?.kind,
        verb: a?.verb,
        sql: stripTrailingSemicolon(sqlIn),
        ok: false,
        error: `${e.code}: ${e.message}`,
        ms: Math.round(performance.now() - started),
      });
      throw e;
    }
  }

  formatQuery(r: QueryResult, format: ResultFormat = "table", maxCellChars?: number): string {
    const d = this.db(r.db);
    const cell = maxCellChars ?? d.limits.maxCellChars;
    const head = `${r.rowCount} row${r.rowCount === 1 ? "" : "s"}${r.offset ? ` (from offset ${r.offset})` : ""} in ${r.ms.toFixed(0)} ms`;
    const lines = [head];
    if (r.columns.length) lines.push(renderRows(r.columns, r.rows, format, cell));
    if (r.hasMore)
      lines.push(
        r.byteCapped
          ? `… more rows (response size cap reached). Select fewer columns, or continue with offset=${r.nextOffset}.`
          : `… more rows. Continue with offset=${r.nextOffset}, or add WHERE/LIMIT/aggregation.`,
      );
    if (r.redacted.length) lines.push(`Redacted: ${r.redacted.join(", ")}`);
    return lines.join("\n");
  }

  // ---------------------------------------------------------------- explain

  async explain(dbName: string | undefined, sqlIn: string, o: { params?: unknown[]; analyze?: boolean } = {}) {
    const d = this.db(dbName);
    const a = this.analyze(d, sqlIn);
    let inner = a.sql;
    if (a.verb === "EXPLAIN") inner = a.sql.replace(/^\s*EXPLAIN\b(\s+(QUERY\s+PLAN|ANALYZE|ANALYSE|VERBOSE))*\s*(\([^)]*\))?/i, "").trim();
    const ia = this.analyze(d, inner);
    if (o.analyze && ia.kind !== "read")
      throw new SafeSqlError(
        "READ_ONLY",
        `EXPLAIN ANALYZE executes the statement, and ${ia.verb} changes data.`,
        "Use analyze=false to see the plan without running it, or the execute tool (dry run) to measure a write.",
      );
    if (ia.kind !== "read" && d.mode === "read")
      throw new SafeSqlError("READ_ONLY", `This database is read-only, so ${ia.verb} cannot be planned here.`);
    await this.enforcePolicy(d, ia, o.params);
    const started = performance.now();
    try {
      const plan = await d.driver.explain(ia.sql, { params: o.params, analyze: !!o.analyze, timeoutMs: d.limits.timeoutMs });
      this.audit.record({
        db: d.name,
        tool: "explain",
        kind: "read",
        verb: o.analyze ? "EXPLAIN ANALYZE" : "EXPLAIN",
        sql: ia.sql,
        ok: true,
        ms: Math.round(performance.now() - started),
      });
      return plan;
    } catch (err) {
      const e = await this.withSuggestions(d, toSafeSqlError(err));
      this.audit.record({
        db: d.name,
        tool: "explain",
        kind: "read",
        verb: "EXPLAIN",
        sql: ia.sql,
        ok: false,
        error: `${e.code}: ${e.message}`,
      });
      throw e;
    }
  }

  // ---------------------------------------------------------------- write

  async execute(
    dbName: string | undefined,
    sqlIn: string,
    o: { params?: unknown[]; dryRun?: boolean; confirm?: string; allowFullTable?: boolean; previewRows?: number } = {},
  ): Promise<ExecuteResult> {
    const d = this.db(dbName);
    const started = performance.now();
    let a: Analysis | undefined;
    const dryRun = o.confirm ? false : o.dryRun !== false;
    try {
      a = this.analyze(d, sqlIn);
      if (a.kind === "read") throw new SafeSqlError("BAD_INPUT", `${a.verb} only reads data; use the query tool.`);
      if (d.mode === "read")
        throw new SafeSqlError(
          "READ_ONLY",
          `Database "${d.name}" is read-only; ${a.verb} is not allowed.`,
          "The user can enable writes by starting the server with --write (data) or --admin (data + schema), or mode in the config file.",
        );
      if (a.kind === "ddl" && d.mode !== "admin")
        throw new SafeSqlError(
          "READ_ONLY",
          `${a.verb} changes the schema, which needs admin mode.`,
          "The user can start the server with --admin to allow schema changes.",
        );
      const warnings: string[] = [];
      if (a.hasWhere === false && !o.allowFullTable)
        throw new SafeSqlError(
          "BLOCKED",
          `${a.verb} without a WHERE clause would change every row${a.target ? ` of ${a.target}` : ""}.`,
          "Add a WHERE clause. If changing every row is really intended, pass allow_full_table=true (a dry run is still required).",
        );
      if (a.trivialWhere && !o.allowFullTable)
        throw new SafeSqlError(
          "BLOCKED",
          `The WHERE clause matches every row (for example 1=1 or TRUE).`,
          "Use a real filter. If changing every row is intended, pass allow_full_table=true.",
        );
      if (a.hasWhere === false || a.trivialWhere) warnings.push("This statement changes every row of the table.");
      if (a.destructive) warnings.push(`${a.verb} is destructive and cannot be undone after commit.`);
      // policy: lexical always; planner-based for DML (DDL cannot be planned)
      if (d.policy.restrictive) {
        const lexical = d.policy.lexicalViolation(a.identifiers);
        if (lexical) throw new SafeSqlError("POLICY", `The statement touches "${lexical}", which this server's policy blocks.`);
        if (a.kind === "write") await this.enforcePolicy(d, a, o.params);
      }
      const paramsKey = JSON.stringify(o.params ?? []);
      if (!dryRun) {
        const pending = o.confirm ? this.confirms.get(o.confirm) : undefined;
        if (!pending || pending.db !== d.name || pending.sql !== a.sql || pending.params !== paramsKey || pending.expires < Date.now()) {
          throw new SafeSqlError(
            "CONFIRM_REQUIRED",
            o.confirm ? "The confirm token is unknown, expired, or was issued for different SQL." : "Writes must be previewed first.",
            "Call execute with dry_run=true (the default), show the preview to the user, then call again with the exact same SQL and confirm=<token>.",
          );
        }
        this.confirms.delete(o.confirm!);
      }
      const outcome = await d.driver.write(a.sql, {
        params: o.params,
        timeoutMs: d.limits.timeoutMs,
        dryRun,
        maxAffected: d.limits.maxAffectedRows,
        previewRows: dryRun ? Math.min(Math.max(0, o.previewRows ?? 5), 50) : 0,
      });
      if (!dryRun) {
        d.schema = undefined; // schema or estimates may have changed
      }
      let preview: ExecuteResult["preview"];
      if (outcome.returning) {
        const fields = this.dropDeniedColumns(d, outcome.returning.fields, outcome.returning.rows);
        this.redact(d, fields, outcome.returning.rows);
        preview = { columns: fields.map((f) => f.name), rows: outcome.returning.rows, hasMore: outcome.returning.hasMore };
      }
      const result: ExecuteResult = {
        db: d.name,
        verb: a.verb,
        kind: a.kind,
        dryRun,
        affected: outcome.affected,
        committed: outcome.committed,
        preview,
        warnings,
        ms: performance.now() - started,
      };
      if (dryRun) {
        if (outcome.affected > d.limits.maxAffectedRows) {
          warnings.push(
            `It would change ${outcome.affected} rows, above the limit of ${d.limits.maxAffectedRows}; running it for real will be refused. Narrow the WHERE clause or batch it.`,
          );
        } else {
          const token = randomBytes(6).toString("base64url");
          this.confirms.set(token, {
            db: d.name,
            sql: a.sql,
            params: paramsKey,
            expires: Date.now() + CONFIRM_TTL_MS,
            affected: outcome.affected,
          });
          this.pruneConfirms();
          result.confirmToken = token;
          result.expiresInSec = CONFIRM_TTL_MS / 1000;
        }
      }
      this.audit.record({
        db: d.name,
        tool: "execute",
        kind: a.kind,
        verb: a.verb,
        sql: a.sql,
        params: o.params?.length,
        ok: true,
        affected: outcome.affected,
        dryRun,
        committed: outcome.committed,
        ms: Math.round(result.ms),
      });
      return result;
    } catch (err) {
      const e = toSafeSqlError(err);
      this.audit.record({
        db: d.name,
        tool: "execute",
        kind: a?.kind,
        verb: a?.verb,
        sql: stripTrailingSemicolon(sqlIn),
        ok: false,
        dryRun,
        error: `${e.code}: ${e.message}`,
        ms: Math.round(performance.now() - started),
      });
      throw e.code === "SQL_ERROR" ? await this.withSuggestions(d, e) : e;
    }
  }

  private pruneConfirms() {
    const now = Date.now();
    for (const [k, v] of this.confirms) if (v.expires < now) this.confirms.delete(k);
    while (this.confirms.size > 100) this.confirms.delete(this.confirms.keys().next().value!);
  }

  formatExecute(r: ExecuteResult): string {
    const lines: string[] = [];
    const rowsWord = `${r.affected} row${r.affected === 1 ? "" : "s"}`;
    if (r.dryRun) {
      lines.push(
        `DRY RUN (rolled back, nothing changed): ${r.verb} would affect ${r.kind === "ddl" ? "the schema" : rowsWord} in ${r.db}.`,
      );
    } else {
      lines.push(`COMMITTED: ${r.verb} ${r.kind === "ddl" ? "applied" : `changed ${rowsWord}`} in ${r.db} (${r.ms.toFixed(0)} ms).`);
    }
    for (const w of r.warnings) lines.push(`Warning: ${w}`);
    if (r.preview?.columns.length) {
      lines.push(`Preview of affected rows${r.dryRun ? " (after the change)" : ""}:`);
      lines.push(renderRows(r.preview.columns, r.preview.rows, "table", this.db(r.db).limits.maxCellChars));
      if (r.preview.hasMore) lines.push("…");
    }
    if (r.confirmToken)
      lines.push(
        `To apply it, show this preview to the user and, if they agree, call execute again with the same SQL and confirm="${r.confirmToken}" (valid ${Math.round((r.expiresInSec ?? 600) / 60)} min, single use).`,
      );
    return lines.join("\n");
  }

  // ---------------------------------------------------------------- listings

  async listTables(dbName?: string, o: { schema?: string; pattern?: string; counts?: boolean } = {}): Promise<string> {
    const d = this.db(dbName);
    const schema = await this.schema(d.name);
    let tables = await this.visibleTables(d.name);
    if (o.schema) tables = tables.filter((t) => t.schema.toLowerCase() === o.schema!.toLowerCase());
    if (o.pattern) {
      const re = new RegExp(
        o.pattern
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/%/g, ".*"),
        "i",
      );
      tables = tables.filter((t) => re.test(t.name));
    }
    if ((o.counts ?? d.config.engine === "sqlite") && tables.length <= 60) {
      await Promise.all(
        tables
          .filter((t) => t.kind === "table" && (t.rowEstimate === null || t.rowEstimate === undefined))
          .map(async (t) => {
            t.rowEstimate = await d.driver.countRows(t, 3000);
          }),
      );
    }
    if (!tables.length) return `No tables${o.pattern ? ` matching "${o.pattern}"` : ""} in ${d.name}.`;
    const bySchema = new Map<string, TableInfo[]>();
    for (const t of tables) bySchema.set(t.schema, [...(bySchema.get(t.schema) ?? []), t]);
    const lines = [
      `${tables.length} table${tables.length === 1 ? "" : "s"}/views in ${d.name} (${d.config.engine}). Format: name ~rows [cols]`,
    ];
    for (const [s, list] of bySchema) {
      if (bySchema.size > 1 || s !== schema.defaultSchema) lines.push(`schema ${s}:`);
      for (const t of list) {
        const kind = t.kind === "table" ? "" : ` (${t.kind})`;
        const rows = t.kind === "table" || t.kind === "materialized view" ? ` ~${formatCount(t.rowEstimate)}` : "";
        lines.push(`  ${t.name}${kind}${rows} [${t.columns.length}]`);
      }
    }
    return lines.join("\n");
  }

  async describeTable(dbName: string | undefined, name: string): Promise<string> {
    const { d, table: t, schema } = await this.resolveTable(dbName, name);
    if (t.kind === "table" && (t.rowEstimate === null || t.rowEstimate === undefined)) t.rowEstimate = await d.driver.countRows(t, 3000);
    const fkByCol = new Map<string, string>();
    for (const fk of t.foreignKeys)
      fk.columns.forEach((c, i) => {
        fkByCol.set(c, `→ ${fk.refSchema === schema.defaultSchema ? "" : `${fk.refSchema}.`}${fk.refTable}.${fk.refColumns[i]}`);
      });
    const lines = [
      `${t.kind} ${displayTable(t, schema.defaultSchema)}${t.kind === "table" || t.kind === "materialized view" ? `  ~${formatCount(t.rowEstimate)} rows` : ""}${t.comment ? `  -- ${t.comment}` : ""}`,
      "columns:",
    ];
    for (const c of t.columns) {
      const bits = [c.name, shortType(c.type) || "any"];
      if (c.pk) bits.push("PK");
      if (!c.nullable && !c.pk) bits.push("NOT NULL");
      if (c.default !== null && c.default !== undefined && c.default !== "") bits.push(`DEFAULT ${c.default}`);
      const fk = fkByCol.get(c.name);
      if (fk) bits.push(fk);
      if (d.policy.columnRedacted(t.schema, t.name, c.name)) bits.push("[redacted]");
      else if (d.policy.isEmailColumn(c.name)) bits.push("[masked]");
      if (c.comment) bits.push(`-- ${c.comment}`);
      lines.push(`  ${bits.join(" ")}`);
    }
    const idx = t.indexes.filter((i) => !i.primary);
    if (idx.length) {
      lines.push("indexes:");
      for (const i of idx) lines.push(`  ${i.unique ? "UNIQUE " : ""}${i.name} (${i.columns.join(", ")})`);
    }
    const tables = await this.visibleTables(d.name);
    const refs: string[] = [];
    for (const other of tables)
      for (const fk of other.foreignKeys)
        if (fk.refTable === t.name && fk.refSchema === t.schema)
          refs.push(`${displayTable(other, schema.defaultSchema)}.${fk.columns.join(",")}`);
    if (refs.length) lines.push(`referenced by: ${refs.join(", ")}`);
    return lines.join("\n");
  }

  /** Whole schema in one compact block, within a character budget. */
  async schemaOverview(dbName?: string, o: { maxChars?: number; schema?: string; refresh?: boolean } = {}): Promise<string> {
    const d = this.db(dbName);
    const schema = await this.schema(d.name, o.refresh);
    let tables = await this.visibleTables(d.name);
    if (o.schema) tables = tables.filter((t) => t.schema === o.schema);
    const budget = Math.max(500, o.maxChars ?? 12_000);
    const lines = [
      `${d.name} (${d.config.engine}, ${d.mode} mode): ${tables.length} tables/views. Legend: * = primary key, → = foreign key, ? = nullable, ~n = rows`,
    ];
    let used = lines[0]!.length;
    let omitted = 0;
    for (const t of tables) {
      const fk = new Map<string, string>();
      for (const f of t.foreignKeys)
        f.columns.forEach((c, i) => {
          fk.set(c, `${f.refTable}${f.refColumns[i] === "id" ? "" : `.${f.refColumns[i]}`}`);
        });
      const cols = t.columns
        .map(
          (c) =>
            `${c.name}${c.pk ? "*" : ""} ${shortType(c.type) || "any"}${c.nullable && !c.pk ? "?" : ""}${fk.has(c.name) ? `→${fk.get(c.name)}` : ""}`,
        )
        .join(", ");
      const size = t.kind === "table" ? ` ~${formatCount(t.rowEstimate)}` : ` (${t.kind})`;
      const line = `${displayTable(t, schema.defaultSchema)}${size}: ${cols}`;
      if (used + line.length + 1 > budget) {
        omitted++;
        continue;
      }
      lines.push(line);
      used += line.length + 1;
    }
    if (omitted) lines.push(`… ${omitted} more tables omitted to save tokens. Use list_tables / describe_table, or raise max_chars.`);
    return lines.join("\n");
  }

  async searchSchema(dbName: string | undefined, term: string, limit = 30): Promise<string> {
    const d = this.db(dbName);
    const schema = await this.schema(d.name);
    const tables = await this.visibleTables(d.name);
    const needle = term.toLowerCase().replace(/[%*]/g, "");
    const hits: string[] = [];
    for (const t of tables) {
      const tn = displayTable(t, schema.defaultSchema);
      if (t.name.toLowerCase().includes(needle) || (t.comment ?? "").toLowerCase().includes(needle))
        hits.push(`table  ${tn} (${t.columns.length} cols)`);
      for (const c of t.columns)
        if (c.name.toLowerCase().includes(needle) || (c.comment ?? "").toLowerCase().includes(needle))
          hits.push(`column ${tn}.${c.name} ${shortType(c.type)}`);
    }
    if (!hits.length) {
      const names = new Set<string>();
      for (const t of tables) {
        names.add(t.name);
        for (const c of t.columns) names.add(c.name);
      }
      const s = suggest(term, names, 5);
      return `Nothing matches "${term}" in ${d.name}.${s.length ? ` Closest names: ${s.join(", ")}` : ""}`;
    }
    const shown = hits.slice(0, limit);
    return [
      `${hits.length} match${hits.length === 1 ? "" : "es"} for "${term}" in ${d.name}:`,
      ...shown,
      ...(hits.length > limit ? [`… ${hits.length - limit} more`] : []),
    ].join("\n");
  }

  // ---------------------------------------------------------------- samples, profile, relationships

  async sample(
    dbName: string | undefined,
    table: string,
    o: { rows?: number; random?: boolean; columns?: string[]; where?: string } = {},
  ): Promise<QueryResult> {
    const { d, table: t } = await this.resolveTable(dbName, table);
    const e = d.config.engine;
    let cols = t.columns;
    if (o.columns?.length) {
      const wanted = o.columns.map((c) => c.toLowerCase());
      const missing = wanted.filter((w) => !cols.some((c) => c.name.toLowerCase() === w));
      if (missing.length)
        throw new SafeSqlError(
          "BAD_INPUT",
          `Unknown column(s) in ${t.name}: ${missing.join(", ")}.`,
          `Columns: ${cols.map((c) => c.name).join(", ")}`,
        );
      cols = cols.filter((c) => wanted.includes(c.name.toLowerCase()));
    }
    const n = Math.min(Math.max(1, o.rows ?? 5), 100);
    const from = e === "postgres" ? `${q(e, t.schema)}.${q(e, t.name)}` : q(e, t.name);
    const sql = `SELECT ${cols.map((c) => q(e, c.name)).join(", ")} FROM ${from}${o.where ? ` WHERE ${o.where}` : ""}${o.random ? " ORDER BY random()" : ""} LIMIT ${n}`;
    return this.query(d.name, sql, { maxRows: n, tool: "sample_rows" });
  }

  async profile(
    dbName: string | undefined,
    table: string,
    o: { columns?: string[]; sampleSize?: number; topValues?: number } = {},
  ): Promise<string> {
    const { d, table: t, schema } = await this.resolveTable(dbName, table);
    const e = d.config.engine;
    const sampleSize = Math.min(Math.max(100, o.sampleSize ?? 100_000), 5_000_000);
    let cols = t.columns;
    if (o.columns?.length) cols = cols.filter((c) => o.columns!.some((x) => x.toLowerCase() === c.name.toLowerCase()));
    cols = cols.slice(0, 40);
    if (!cols.length) throw new SafeSqlError("BAD_INPUT", "No matching columns to profile.");
    const from = e === "postgres" ? `${q(e, t.schema)}.${q(e, t.name)}` : q(e, t.name);
    const src = `(SELECT * FROM ${from} LIMIT ${sampleSize}) AS s`;
    const isNum = (ty: string) => /int|real|float|double|numeric|decimal|money|serial/i.test(ty);
    const isOrderable = (ty: string) => isNum(ty) || /char|text|date|time|uuid|clob|^$/i.test(ty);
    const sensitive = (c: string) => d.policy.columnRedacted(t.schema, t.name, c) || d.policy.isEmailColumn(c);
    const exprs: string[] = ["count(*) AS n"];
    cols.forEach((c, i) => {
      const col = q(e, c.name);
      const textExpr = e === "postgres" ? `${col}::text` : col;
      exprs.push(`count(${col}) AS nn${i}`, `count(DISTINCT ${textExpr}) AS nd${i}`);
      if (!sensitive(c.name) && isOrderable(c.type)) exprs.push(`min(${col}) AS mn${i}`, `max(${col}) AS mx${i}`);
      if (!sensitive(c.name) && isNum(c.type)) exprs.push(`avg(${col}) AS av${i}`);
    });
    const internal = (
      d.driver as unknown as { internalAll: (s: string, p?: unknown[], t?: number) => Promise<Record<string, unknown>[]> }
    ).internalAll.bind(d.driver);
    const started = performance.now();
    const stats = (await internal(`SELECT ${exprs.join(", ")} FROM ${src}`, [], d.limits.timeoutMs * 2))[0] ?? {};
    const n = Number(stats.n ?? 0);
    const exact = n < sampleSize;
    const lines = [
      `profile of ${displayTable(t, schema.defaultSchema)}: ${n} rows${exact ? "" : ` (first ${sampleSize} rows sampled)`}`,
      "column | type | nulls | distinct | min | max | avg | top values",
    ];
    const topN = Math.min(Math.max(0, o.topValues ?? 3), 10);
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i]!;
      const nonNull = Number(stats[`nn${i}`] ?? 0);
      const distinct = Number(stats[`nd${i}`] ?? 0);
      const nulls = n - nonNull;
      const pct = n ? ` (${((nulls / n) * 100).toFixed(nulls && nulls < n / 100 ? 2 : 0)}%)` : "";
      let top = "";
      if (topN && !sensitive(c.name) && distinct > 0 && distinct < n && i < 25) {
        const col = q(e, c.name);
        const rows = await internal(
          `SELECT ${col} AS v, count(*) AS c FROM ${src} WHERE ${col} IS NOT NULL GROUP BY ${col} ORDER BY count(*) DESC LIMIT ${topN}`,
          [],
          d.limits.timeoutMs,
        );
        top = rows.map((r) => `${cellText(r.v, 40)} (${r.c})`).join(", ");
      } else if (sensitive(c.name)) top = "[redacted]";
      const mn = stats[`mn${i}`];
      const mx = stats[`mx${i}`];
      const av = stats[`av${i}`];
      lines.push(
        [
          c.name,
          shortType(c.type) || "any",
          `${nulls}${pct}`,
          String(distinct) + (distinct === n && n > 0 ? " (unique)" : ""),
          mn === undefined || mn === null ? "" : cellText(mn, 40),
          mx === undefined || mx === null ? "" : cellText(mx, 40),
          av === undefined || av === null ? "" : Number(av).toFixed(2),
          top,
        ].join(" | "),
      );
    }
    const issues: string[] = [];
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i]!;
      const nonNull = Number(stats[`nn${i}`] ?? 0);
      if (n > 0 && nonNull === 0) issues.push(`${c.name} is always NULL`);
      else if (n > 0 && !c.nullable === false && nonNull / n < 0.5)
        issues.push(`${c.name} is mostly NULL (${(((n - nonNull) / n) * 100).toFixed(0)}%)`);
      if (n > 1 && Number(stats[`nd${i}`]) === 1) issues.push(`${c.name} has a single value`);
    }
    if (issues.length) lines.push(`notes: ${issues.join("; ")}`);
    this.audit.record({
      db: d.name,
      tool: "profile_table",
      kind: "read",
      verb: "PROFILE",
      sql: `profile ${t.schema}.${t.name}`,
      ok: true,
      rows: n,
      ms: Math.round(performance.now() - started),
    });
    return lines.join("\n");
  }

  async relationships(
    dbName?: string,
    o: { table?: string; depth?: number; format?: "mermaid" | "list"; columns?: boolean } = {},
  ): Promise<string> {
    const d = this.db(dbName);
    const schema = await this.schema(d.name);
    const all = await this.visibleTables(d.name);
    const key = (t: { schema: string; name: string }) => `${t.schema}.${t.name}`;
    const byKey = new Map(all.map((t) => [key(t), t]));
    let include = new Set(all.map(key));
    if (o.table) {
      const { table } = await this.resolveTable(d.name, o.table);
      const depth = Math.min(Math.max(1, o.depth ?? 1), 5);
      include = new Set([key(table)]);
      for (let i = 0; i < depth; i++) {
        const frontier = new Set(include);
        for (const t of all) {
          for (const fk of t.foreignKeys) {
            const ref = `${fk.refSchema}.${fk.refTable}`;
            if (frontier.has(key(t)) || frontier.has(ref)) {
              if (byKey.has(ref)) include.add(ref);
              include.add(key(t));
            }
          }
        }
      }
    }
    const edges: { from: TableInfo; to: string; cols: string[]; refCols: string[]; optional: boolean }[] = [];
    for (const t of all) {
      if (!include.has(key(t))) continue;
      for (const fk of t.foreignKeys) {
        const ref = `${fk.refSchema}.${fk.refTable}`;
        if (!include.has(ref) || !byKey.has(ref)) continue;
        const optional = fk.columns.some((c) => t.columns.find((x) => x.name === c)?.nullable);
        edges.push({ from: t, to: ref, cols: fk.columns, refCols: fk.refColumns, optional });
      }
    }
    const name = (k: string) => {
      const t = byKey.get(k)!;
      return displayTable(t, schema.defaultSchema);
    };
    const ent = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_");
    if (o.format === "list") {
      if (!edges.length) return "No foreign keys found.";
      return edges.map((e) => `${name(key(e.from))}.${e.cols.join(",")} → ${name(e.to)}.${e.refCols.join(",")}`).join("\n");
    }
    const lines = ["erDiagram"];
    for (const e of edges) {
      const unique =
        e.from.indexes.some((i) => i.unique && i.columns.join() === e.cols.join()) ||
        e.from.columns
          .filter((c) => c.pk)
          .map((c) => c.name)
          .join() === e.cols.join();
      const card = `${e.optional ? "|o" : "||"}--${unique ? "o|" : "o{"}`;
      lines.push(`  ${ent(name(e.to))} ${card} ${ent(name(key(e.from)))} : "${e.cols.join(",")}"`);
    }
    for (const k of include) {
      const t = byKey.get(k);
      if (!t) continue;
      const fkCols = new Set(t.foreignKeys.flatMap((f) => f.columns));
      const shown = t.columns.filter((c) => o.columns || c.pk || fkCols.has(c.name));
      if (!shown.length) continue;
      lines.push(`  ${ent(name(k))} {`);
      for (const c of shown) {
        const typ = (shortType(c.type) || "any").replace(/[^A-Za-z0-9_]/g, "_");
        const tags = [c.pk ? "PK" : "", fkCols.has(c.name) ? "FK" : ""].filter(Boolean).join(", ");
        lines.push(`    ${typ} ${ent(c.name)}${tags ? ` ${tags}` : ""}`);
      }
      lines.push("  }");
    }
    if (lines.length === 1) return "No tables or foreign keys to draw.";
    return lines.join("\n");
  }

  // ---------------------------------------------------------------- export

  async exportQuery(
    dbName: string | undefined,
    sql: string,
    file: string,
    o: { params?: unknown[]; format?: "csv" | "json" | "jsonl" | "markdown"; overwrite?: boolean; maxRows?: number } = {},
  ): Promise<{ path: string; rows: number; bytes: number; truncated: boolean; format: string }> {
    const d = this.db(dbName);
    const dir = resolve(this.config.exportDir);
    const target = resolve(dir, file);
    const rel = relative(dir, target);
    if (!rel || rel.startsWith("..") || rel.includes(`..${sep}`) || resolve(dir, rel) !== target)
      throw new SafeSqlError(
        "BLOCKED",
        `Export files must stay inside the export directory (${dir}).`,
        'Use a plain file name such as "orders.csv".',
      );
    const ext = extname(target).toLowerCase().replace(".", "");
    const format =
      o.format ?? (ext === "json" ? "json" : ext === "jsonl" || ext === "ndjson" ? "jsonl" : ext === "md" ? "markdown" : "csv");
    if (existsSync(target) && !o.overwrite)
      throw new SafeSqlError("BAD_INPUT", `${rel} already exists in the export directory.`, "Pick another name or pass overwrite=true.");
    const limit = Math.min(o.maxRows ?? d.limits.exportMaxRows, d.limits.exportMaxRows);
    const r = await this.query(d.name, sql, { params: o.params, maxRows: limit, internal: true, tool: "export_query" });
    const body = serializeExport(r.columns, r.rows, format);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
    this.audit.record({
      db: d.name,
      tool: "export_query",
      kind: "read",
      verb: r.verb,
      sql: stripTrailingSemicolon(sql),
      ok: true,
      rows: r.rowCount,
      ms: Math.round(r.ms),
    });
    return { path: target, rows: r.rowCount, bytes: Buffer.byteLength(body), truncated: r.hasMore, format };
  }

  // ---------------------------------------------------------------- saved queries

  private loadSaved(): Record<string, SavedQuery> {
    if (!existsSync(this.savedFile)) return {};
    try {
      return JSON.parse(readFileSync(this.savedFile, "utf8")) as Record<string, SavedQuery>;
    } catch {
      return {};
    }
  }

  savedQueries(): Record<string, SavedQuery & { source: "config" | "saved" }> {
    const out: Record<string, SavedQuery & { source: "config" | "saved" }> = {};
    for (const [k, v] of Object.entries(this.loadSaved())) out[k] = { ...v, source: "saved" };
    for (const [k, v] of Object.entries(this.config.queries)) out[k] = { ...v, source: "config" };
    return out;
  }

  getSaved(name: string): SavedQuery {
    const all = this.savedQueries();
    const q0 = all[name];
    if (!q0) {
      const s = suggest(name, Object.keys(all));
      throw new SafeSqlError(
        "BAD_INPUT",
        `No saved query named "${name}".`,
        s.length ? `Did you mean ${s.join(" or ")}?` : "List them with saved_queries.",
      );
    }
    return q0;
  }

  saveQuery(name: string, sql: string, o: { db?: string; description?: string } = {}): SavedQuery {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name))
      throw new SafeSqlError("BAD_INPUT", "Query names use letters, digits, _ and - (max 64).");
    if (this.config.queries[name])
      throw new SafeSqlError("BAD_INPUT", `"${name}" is defined in the config file and cannot be replaced here.`);
    const d = this.db(o.db);
    const a = this.analyze(d, sql);
    if (a.kind !== "read") throw new SafeSqlError("BAD_INPUT", "Only read queries can be saved.");
    const all = this.loadSaved();
    all[name] = { db: o.db ?? (this.databases.size > 1 ? d.name : undefined), sql: a.sql, description: o.description };
    mkdirSync(dirname(this.savedFile), { recursive: true });
    writeFileSync(this.savedFile, `${JSON.stringify(all, null, 2)}\n`);
    return all[name]!;
  }

  deleteQuery(name: string): boolean {
    const all = this.loadSaved();
    if (!all[name]) return false;
    delete all[name];
    writeFileSync(this.savedFile, `${JSON.stringify(all, null, 2)}\n`);
    return true;
  }
}
