import pg from "pg";
import Cursor from "pg-cursor";
import { SafeSqlError } from "../errors.js";
import { type PgNode, pgPlanHints, renderPgPlan } from "../hints.js";
import type {
  AccessSet,
  ColumnInfo,
  Driver,
  FieldOrigin,
  ForeignKey,
  IndexInfo,
  PlanResult,
  RawResult,
  ReadOptions,
  SchemaModel,
  TableInfo,
  WriteOptions,
  WriteOutcome,
} from "../types.js";

// Keep dates and timestamps as the exact text PostgreSQL sends (no local time zone conversion).
const TEXT_TYPES = [1082, 1083, 1114, 1184, 1266, 1186];
const typeOverrides = {
  getTypeParser(oid: number, format?: string) {
    if (TEXT_TYPES.includes(oid)) return (v: string) => v;
    return (pg.types.getTypeParser as (o: number, f?: string) => unknown)(oid, format);
  },
};

export interface PostgresDriverOptions {
  url: string;
  writable: boolean;
  /** Max pool size (default 4). */
  poolSize?: number;
}

function qi(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function norm(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return { $blob: v.length };
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "object") return JSON.stringify(v);
  return v;
}

function approxSize(row: unknown[]): number {
  let n = 2;
  for (const v of row) n += v === null ? 5 : typeof v === "string" ? v.length + 3 : String(v).length + 1;
  return n;
}

/** Map a pg error to a SafeSqlError with an actionable hint. */
export function pgError(err: unknown): SafeSqlError {
  if (err instanceof SafeSqlError) return err;
  const e = err as { code?: string; message?: string; hint?: string; position?: string };
  const msg = e.message ?? String(err);
  switch (e.code) {
    case "57014":
      return new SafeSqlError(
        "TIMEOUT",
        "Query cancelled by statement_timeout.",
        "Add a WHERE clause or LIMIT, filter on an indexed column, or ask the user to raise the timeout (--timeout / timeoutMs).",
      );
    case "25006":
      return new SafeSqlError(
        "READ_ONLY",
        `PostgreSQL refused a write in the read-only transaction: ${msg}`,
        "Reads run in READ ONLY transactions. Writes need write mode and the execute tool.",
      );
    case "55P03":
      return new SafeSqlError("TIMEOUT", `Could not get a lock in time: ${msg}`, "Another session holds a lock; try again later.");
    case "28P01":
    case "28000":
      return new SafeSqlError("CONNECTION", `Authentication failed: ${msg}`, "Check the user name and password in the connection URL.");
    case "3D000":
      return new SafeSqlError("CONNECTION", msg, "The database name in the URL does not exist on that server.");
    case "42501":
      return new SafeSqlError("SQL_ERROR", msg, "The database role lacks a privilege for this object.");
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|timeout expired|Connection terminated/i.test(msg))
    return new SafeSqlError(
      "CONNECTION",
      `Cannot reach PostgreSQL: ${msg}`,
      "Check host, port and that the server is running and reachable.",
    );
  return new SafeSqlError("SQL_ERROR", `${msg}${e.hint ? ` (hint: ${e.hint})` : ""}`);
}

type Client = pg.PoolClient;

export class PostgresDriver implements Driver {
  readonly engine = "postgres" as const;
  readonly writable: boolean;
  private readonly pool: pg.Pool;
  private originCache = new Map<number, { schema: string; table: string; columns: Map<number, string> }>();

  constructor(opts: PostgresDriverOptions) {
    this.writable = opts.writable;
    this.pool = new pg.Pool({
      connectionString: opts.url,
      max: opts.poolSize ?? 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: "safesql-mcp",
      types: typeOverrides as pg.CustomTypesConfig,
      allowExitOnIdle: true,
    });
    this.pool.on("error", () => {
      // idle client errors are reported on the next query
    });
  }

  async connect(): Promise<void> {
    const c = await this.client();
    c.release();
  }

  private async client(): Promise<Client> {
    try {
      return await this.pool.connect();
    } catch (err) {
      throw pgError(err);
    }
  }

  /** Run fn inside a transaction. Read transactions are READ ONLY and pinned before user SQL runs. */
  private async tx<T>(mode: "read" | "write", timeoutMs: number, fn: (c: Client) => Promise<T>): Promise<T> {
    const c = await this.client();
    let broken = false;
    try {
      await c.query(mode === "read" ? "BEGIN TRANSACTION READ ONLY" : "BEGIN");
      await c.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
      await c.query(`SET LOCAL idle_in_transaction_session_timeout = ${Math.max(5000, Math.floor(timeoutMs) * 2)}`);
      await c.query(`SET LOCAL lock_timeout = ${Math.min(5000, Math.max(1, Math.floor(timeoutMs)))}`);
      // Taking a snapshot now means "SET transaction_read_only = off" can no longer flip the transaction.
      if (mode === "read") await c.query("SELECT 1");
      return await fn(c);
    } catch (err) {
      if ((err as { code?: string }).code === undefined && !(err instanceof SafeSqlError)) broken = true;
      throw pgError(err);
    } finally {
      try {
        await c.query("ROLLBACK");
      } catch {
        broken = true;
      }
      c.release(broken);
    }
  }

  async serverVersion(): Promise<string> {
    return this.tx("read", 5000, async (c) => {
      const r = await c.query("SHOW server_version");
      return `PostgreSQL ${r.rows[0]?.server_version}`;
    });
  }

  private async origins(
    fields: { name: string; tableID: number; columnID: number; dataTypeID: number }[],
    c: Client,
  ): Promise<FieldOrigin[]> {
    const missing = [...new Set(fields.map((f) => f.tableID).filter((id) => id && !this.originCache.has(id)))];
    if (missing.length) {
      const r = await c.query(
        `SELECT c.oid::int AS oid, n.nspname AS schema, c.relname AS table, a.attnum::int AS attnum, a.attname AS column
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.oid = ANY($1::oid[]) AND a.attnum > 0`,
        [missing],
      );
      for (const row of r.rows as { oid: number; schema: string; table: string; attnum: number; column: string }[]) {
        let e = this.originCache.get(row.oid);
        if (!e) {
          e = { schema: row.schema, table: row.table, columns: new Map() };
          this.originCache.set(row.oid, e);
        }
        e.columns.set(row.attnum, row.column);
      }
    }
    return fields.map((f) => {
      const o = f.tableID ? this.originCache.get(f.tableID) : undefined;
      const column = o?.columns.get(f.columnID);
      return o && column ? { name: f.name, schema: o.schema, table: o.table, column } : { name: f.name };
    });
  }

  read(sql: string, o: ReadOptions): Promise<RawResult> {
    return this.tx("read", o.timeoutMs, async (c) => {
      const cursor = c.query(new Cursor(sql, o.params ?? [], { rowMode: "array" }));
      const readBatch = (n: number) =>
        new Promise<{ rows: unknown[][]; fields: { name: string; tableID: number; columnID: number; dataTypeID: number }[] }>(
          (resolve, reject) => {
            cursor.read(n, (err, rows, result) => {
              if (err) reject(err);
              else
                resolve({
                  rows: (rows as unknown as unknown[][]) ?? [],
                  fields: ((result as unknown as { fields?: [] })?.fields ?? []) as never,
                });
            });
          },
        );
      let closed = false;
      const closeCursor = async () => {
        if (closed) return;
        closed = true;
        await new Promise<void>((resolve) => cursor.close(() => resolve()));
      };
      try {
        let skipped = 0;
        let fields: { name: string; tableID: number; columnID: number; dataTypeID: number }[] = [];
        while (skipped < o.offset) {
          const b = await readBatch(Math.min(1000, o.offset - skipped));
          fields = b.fields.length ? b.fields : fields;
          if (!b.rows.length) break;
          skipped += b.rows.length;
        }
        const rows: unknown[][] = [];
        let bytes = 0;
        let hasMore = false;
        let byteCapped = false;
        outer: while (rows.length <= o.maxRows) {
          const want = Math.min(500, o.maxRows + 1 - rows.length);
          const b = await readBatch(want);
          if (b.fields.length) fields = b.fields;
          if (!b.rows.length) break;
          for (const raw of b.rows) {
            if (rows.length >= o.maxRows) {
              hasMore = true;
              break outer;
            }
            const row = raw.map(norm);
            bytes += approxSize(row);
            if (bytes > o.maxBytes && rows.length > 0) {
              hasMore = true;
              byteCapped = true;
              break outer;
            }
            rows.push(row);
          }
          if (b.rows.length < want) break;
        }
        // The cursor must be closed before the connection can run anything else.
        await closeCursor();
        const origins = await this.origins(fields, c);
        return { fields: origins, rows, hasMore, byteCapped };
      } finally {
        await closeCursor();
      }
    });
  }

  async write(sql: string, o: WriteOptions): Promise<WriteOutcome> {
    if (!this.writable) throw new SafeSqlError("READ_ONLY", "This database is read-only.");
    const c = await this.client();
    let committed = false;
    try {
      await c.query("BEGIN");
      await c.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(o.timeoutMs))}`);
      await c.query(`SET LOCAL lock_timeout = ${Math.min(5000, Math.max(1, Math.floor(o.timeoutMs)))}`);
      let result: pg.QueryResult | undefined;
      const wantsPreview =
        o.dryRun && o.previewRows > 0 && !/\bRETURNING\b/i.test(sql) && /^\s*(WITH\b[\s\S]*)?\s*(INSERT|UPDATE|DELETE|MERGE)\b/i.test(sql);
      if (wantsPreview) {
        await c.query("SAVEPOINT safesql_preview");
        try {
          result = await c.query({ text: `${sql} RETURNING *`, values: o.params ?? [], rowMode: "array" });
        } catch {
          await c.query("ROLLBACK TO SAVEPOINT safesql_preview");
          result = undefined;
        }
      }
      if (!result) result = await c.query({ text: sql, values: o.params ?? [], rowMode: "array" });
      const affected = result.rowCount ?? 0;
      let returning: RawResult | undefined;
      if (result.fields?.length) {
        const cap = o.previewRows > 0 ? o.previewRows : 100;
        const rows = (result.rows as unknown[][]).slice(0, cap).map((r) => r.map(norm));
        returning = {
          fields: await this.origins(result.fields as never, c),
          rows,
          hasMore: result.rows.length > cap,
        };
      }
      if (o.dryRun) {
        await c.query("ROLLBACK");
      } else if (affected > o.maxAffected) {
        await c.query("ROLLBACK");
        throw new SafeSqlError(
          "TOO_MANY_ROWS",
          `The statement would change ${affected} rows, more than the limit of ${o.maxAffected}. Nothing was changed (rolled back).`,
          "Narrow the WHERE clause, split the change into batches, or raise maxAffectedRows in the config.",
        );
      } else {
        await c.query("COMMIT");
        committed = true;
      }
      return { affected, returning, committed };
    } catch (err) {
      try {
        await c.query("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw pgError(err);
    } finally {
      this.originCache.clear();
      c.release();
    }
  }

  async explain(sql: string, o: { params?: unknown[]; analyze: boolean; timeoutMs: number }): Promise<PlanResult> {
    const opts = o.analyze ? "FORMAT JSON, ANALYZE, BUFFERS" : "FORMAT JSON";
    const plan = await this.tx("read", o.timeoutMs, async (c) => {
      const r = await c.query(`EXPLAIN (${opts}) ${sql}`, o.params ?? []);
      const v = (r.rows[0] as Record<string, unknown>)["QUERY PLAN"];
      return (typeof v === "string" ? JSON.parse(v) : v) as { Plan: PgNode; "Execution Time"?: number; "Planning Time"?: number }[];
    });
    const top = plan[0]!;
    const lines = renderPgPlan(top.Plan);
    if (top["Planning Time"] !== undefined) lines.push(`Planning Time: ${top["Planning Time"]} ms`);
    if (top["Execution Time"] !== undefined) lines.push(`Execution Time: ${top["Execution Time"]} ms`);
    let schema: SchemaModel | undefined;
    try {
      schema = await this.loadSchema();
    } catch {
      schema = undefined;
    }
    return { text: lines.join("\n"), raw: plan, hints: pgPlanHints(top.Plan, schema), executionMs: top["Execution Time"] };
  }

  async access(sql: string, params: unknown[] | undefined, schema: SchemaModel): Promise<AccessSet> {
    const plan = await this.tx("read", 15_000, async (c) => {
      const r = await c.query(`EXPLAIN (VERBOSE, FORMAT JSON) ${sql}`, params ?? []);
      const v = (r.rows[0] as Record<string, unknown>)["QUERY PLAN"];
      return (typeof v === "string" ? JSON.parse(v) : v) as { Plan: PgNode }[];
    });
    return accessFromPlan(plan[0]!.Plan, schema);
  }

  async loadSchema(): Promise<SchemaModel> {
    return this.tx("read", 30_000, async (c) => {
      const cur = await c.query("SELECT current_schema() AS s");
      const defaultSchema = (cur.rows[0]?.s as string) ?? "public";
      const rels = await c.query(
        `SELECT c.oid::int AS oid, n.nspname AS schema, c.relname AS name, c.relkind AS kind,
                CASE WHEN c.reltuples < 0 THEN (SELECT s.n_live_tup FROM pg_stat_user_tables s WHERE s.relid = c.oid) ELSE c.reltuples END::float8 AS tuples,
                obj_description(c.oid, 'pg_class') AS comment
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r','p','v','m','f')
            AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'
            AND NOT c.relispartition AND has_schema_privilege(n.oid, 'USAGE')
          ORDER BY n.nspname, c.relname`,
      );
      const oids = rels.rows.map((r) => r.oid as number);
      const cols = await c.query(
        `SELECT a.attrelid::int AS rel, a.attnum::int AS num, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
                  a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS def, col_description(a.attrelid, a.attnum) AS comment
             FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
            WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped
            ORDER BY a.attrelid, a.attnum`,
        [oids],
      );
      const cons = await c.query(
        `SELECT con.conrelid::int AS rel, con.conname AS name, con.contype AS type, con.conkey::int[] AS keys,
                  con.confkey::int[] AS fkeys, fn.nspname AS refschema, fc.relname AS reftable, con.confrelid::int AS refoid
             FROM pg_constraint con
             LEFT JOIN pg_class fc ON fc.oid = con.confrelid LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
            WHERE con.conrelid = ANY($1::oid[]) AND con.contype IN ('p','f')`,
        [oids],
      );
      const idx = await c.query(
        `SELECT i.indrelid::int AS rel, ic.relname AS name, i.indisunique AS uniq, i.indisprimary AS prim, i.indkey::int[] AS keys,
                  i.indnkeyatts::int AS nkeys
             FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
            WHERE i.indrelid = ANY($1::oid[])
            ORDER BY ic.relname`,
        [oids],
      );
      const colsByRel = new Map<
        number,
        { num: number; name: string; type: string; notnull: boolean; def: string | null; comment: string | null }[]
      >();
      for (const r of cols.rows) {
        const list = colsByRel.get(r.rel) ?? [];
        list.push(r);
        colsByRel.set(r.rel, list);
      }
      const attName = (rel: number, num: number) =>
        colsByRel.get(rel)?.find((x) => x.num === num)?.name ?? (num === 0 ? "<expr>" : `#${num}`);
      const pkByRel = new Map<number, number[]>();
      const fksByRel = new Map<number, ForeignKey[]>();
      for (const r of cons.rows) {
        if (r.type === "p") pkByRel.set(r.rel, r.keys);
        else {
          const list = fksByRel.get(r.rel) ?? [];
          list.push({
            name: r.name,
            columns: (r.keys as number[]).map((k) => attName(r.rel, k)),
            refSchema: r.refschema,
            refTable: r.reftable,
            refColumns: (r.fkeys as number[]).map((k) => attName(r.refoid, k)),
          });
          fksByRel.set(r.rel, list);
        }
      }
      const idxByRel = new Map<number, IndexInfo[]>();
      for (const r of idx.rows) {
        const list = idxByRel.get(r.rel) ?? [];
        list.push({
          name: r.name,
          unique: r.uniq,
          primary: r.prim,
          columns: (r.keys as number[]).slice(0, r.nkeys).map((k) => attName(r.rel, k)),
        });
        idxByRel.set(r.rel, list);
      }
      const kinds: Record<string, TableInfo["kind"]> = { r: "table", p: "table", v: "view", m: "materialized view", f: "foreign table" };
      const tables: TableInfo[] = rels.rows.map((r) => {
        const pk = pkByRel.get(r.oid) ?? [];
        const columns: ColumnInfo[] = (colsByRel.get(r.oid) ?? []).map((col) => ({
          name: col.name,
          type: col.type,
          nullable: !col.notnull,
          default: col.def,
          pk: pk.includes(col.num),
          comment: col.comment,
        }));
        return {
          schema: r.schema,
          name: r.name,
          kind: kinds[r.kind] ?? "table",
          rowEstimate:
            r.tuples !== null && r.tuples >= 0 && (r.kind === "r" || r.kind === "p" || r.kind === "m") ? Math.round(r.tuples) : null,
          columns,
          indexes: idxByRel.get(r.oid) ?? [],
          foreignKeys: fksByRel.get(r.oid) ?? [],
          comment: r.comment,
        };
      });
      return { engine: "postgres" as const, defaultSchema, tables, loadedAt: Date.now() };
    });
  }

  async countRows(table: TableInfo, timeoutMs: number): Promise<number | null> {
    try {
      return await this.tx("read", timeoutMs, async (c) => {
        const r = await c.query(`SELECT count(*)::bigint AS n FROM ${qi(table.schema)}.${qi(table.name)}`);
        return Number(r.rows[0]?.n ?? 0);
      });
    } catch {
      return null;
    }
  }

  /** Trusted internal read (introspection, profiling) inside a READ ONLY transaction. */
  internalAll<T = Record<string, unknown>>(sql: string, params: unknown[] = [], timeoutMs = 30_000): Promise<T[]> {
    return this.tx("read", timeoutMs, async (c) => (await c.query(sql, params)).rows as T[]);
  }

  async probeReadOnly(): Promise<string> {
    try {
      await this.tx("read", 5000, async (c) => {
        await c.query("CREATE TEMP TABLE __safesql_probe (x int)");
      });
    } catch (err) {
      const e = err as SafeSqlError;
      if (e.code === "READ_ONLY") return e.message;
      throw err;
    }
    throw new SafeSqlError("INTERNAL", "The read-only transaction accepted a write. This should never happen.");
  }

  /** Privileges of the connected role, for doctor. */
  async privileges(): Promise<{ role: string; superuser: boolean; writableTables: number; canCreate: boolean }> {
    const rows = await this.internalAll<{ role: string; superuser: boolean; writable: string; cancreate: boolean }>(
      `SELECT current_user AS role,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
              (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
                  AND (has_table_privilege(c.oid, 'INSERT') OR has_table_privilege(c.oid, 'UPDATE') OR has_table_privilege(c.oid, 'DELETE'))) AS writable,
              has_schema_privilege(current_schema(), 'CREATE') AS cancreate`,
    );
    const r = rows[0]!;
    return { role: r.role, superuser: r.superuser, writableTables: Number(r.writable), canCreate: r.cancreate };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

const EXPR_KEYS = [
  "Output",
  "Filter",
  "Index Cond",
  "Recheck Cond",
  "Hash Cond",
  "Merge Cond",
  "Join Filter",
  "Sort Key",
  "Group Key",
  "Presorted Key",
  "Order By",
  "TID Cond",
  "One-Time Filter",
];

/** Tables and columns referenced by a VERBOSE JSON plan. */
export function accessFromPlan(root: PgNode, schema: SchemaModel): AccessSet {
  const tables = new Set<string>();
  const columns = new Set<string>();
  const aliases = new Map<string, { schema: string; table: string }>();
  const exprs: string[] = [];
  let partial = false;
  const visit = (n: PgNode) => {
    const rel = n["Relation Name"];
    if (rel) {
      const sch = (n.Schema as string | undefined) ?? schema.defaultSchema;
      tables.add(`${sch}.${rel}`);
      aliases.set(n.Alias ?? rel, { schema: sch, table: rel });
    }
    if (n["Node Type"] === "Function Scan" || n["Node Type"] === "Custom Scan" || n["Node Type"] === "Foreign Scan") partial = true;
    for (const k of EXPR_KEYS) {
      const v = n[k];
      if (Array.isArray(v)) exprs.push(...v.map(String));
      else if (typeof v === "string") exprs.push(v);
    }
    for (const c of n.Plans ?? []) visit(c);
  };
  visit(root);
  const ident = '(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)';
  const qualified = new RegExp(`(${ident})\\.(${ident})`, "g");
  const unq = (s: string) => (s.startsWith('"') ? s.slice(1, -1).replaceAll('""', '"') : s);
  for (const e of exprs) {
    for (const m of e.matchAll(qualified)) {
      const a = aliases.get(unq(m[1]!));
      if (a) columns.add(`${a.schema}.${a.table}.${unq(m[2]!)}`);
    }
  }
  if (aliases.size === 1) {
    const only = [...aliases.values()][0]!;
    const t = schema.tables.find((x) => x.schema === only.schema && x.name === only.table);
    if (t) {
      const names = new Set(t.columns.map((c) => c.name));
      for (const e of exprs)
        for (const m of e.matchAll(new RegExp(ident, "g"))) {
          const name = unq(m[0]);
          if (names.has(name)) columns.add(`${only.schema}.${only.table}.${name}`);
        }
    }
  }
  return { tables, columns, partial };
}
