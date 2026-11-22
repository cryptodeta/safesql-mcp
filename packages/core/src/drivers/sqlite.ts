import { existsSync, statSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { SafeSqlError } from "../errors.js";
import { sqlitePlanHints } from "../hints.js";
import type {
  AccessSet,
  Driver,
  PlanResult,
  RawResult,
  ReadOptions,
  SchemaModel,
  TableInfo,
  WriteOptions,
  WriteOutcome,
} from "../types.js";
import { SQLITE_WORKER_SOURCE } from "./sqlite-worker.js";

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export interface SqliteDriverOptions {
  path: string;
  writable: boolean;
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** SQLite through node:sqlite in a worker thread. Reads use a connection opened with readOnly + query_only. */
export class SqliteDriver implements Driver {
  readonly engine = "sqlite" as const;
  readonly writable: boolean;
  private readonly path: string;
  private worker?: Worker;
  private ready?: Promise<string>;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: SqliteDriverOptions) {
    this.path = opts.path;
    this.writable = opts.writable;
  }

  async connect(): Promise<void> {
    await this.ensure();
  }

  private ensure(): Promise<string> {
    if (this.ready) return this.ready;
    const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 16))
      throw new SafeSqlError(
        "CONNECTION",
        `SQLite needs Node.js 22.16 or newer (running ${process.versions.node}).`,
        "Older node:sqlite builds cannot report result-column origins, which redaction relies on. Upgrade Node.js.",
      );
    if (!existsSync(this.path))
      throw new SafeSqlError(
        "CONNECTION",
        `SQLite file not found: ${this.path}`,
        "Check the path. Relative paths resolve from the directory the server was started in.",
      );
    if (statSync(this.path).isDirectory()) throw new SafeSqlError("CONNECTION", `${this.path} is a directory, not a SQLite file.`);
    const worker = new Worker(SQLITE_WORKER_SOURCE, {
      eval: true,
      workerData: { path: this.path, writable: this.writable },
    });
    worker.unref();
    worker.on("message", (msg: { id: number; ok: boolean; result?: unknown; error?: { message: string; code?: string } }) => {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(sqliteError(msg.error?.message ?? "SQLite error", msg.error?.code));
    });
    worker.on("error", (err) => this.failAll(err));
    worker.on("exit", () => {
      if (this.worker === worker) {
        this.worker = undefined;
        this.ready = undefined;
      }
      this.failAll(new SafeSqlError("INTERNAL", "SQLite worker stopped."));
    });
    this.worker = worker;
    this.ready = this.rawCall<{ version: string }>("open", {}, 15_000).then(
      (r) => r.version,
      (err) => {
        this.ready = undefined;
        void worker.terminate();
        throw new SafeSqlError(
          "CONNECTION",
          `Could not open ${this.path}: ${(err as Error).message}`,
          "Is it a valid SQLite database file?",
        );
      },
    );
    return this.ready;
  }

  private failAll(err: unknown) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private rawCall<T>(op: string, args: unknown, timeoutMs: number): Promise<T> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new SafeSqlError("INTERNAL", "SQLite worker is not running."));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        // A synchronous SQLite call cannot be interrupted from outside; stop the worker instead.
        this.worker = undefined;
        this.ready = undefined;
        void worker.terminate();
        reject(
          new SafeSqlError(
            "TIMEOUT",
            `Query stopped after ${timeoutMs} ms (timeout).`,
            "Add a WHERE clause or LIMIT, filter on an indexed column, or ask the user to raise the timeout (--timeout / timeoutMs).",
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      worker.postMessage({ id, op, args });
    });
  }

  /** Serialize calls: one statement at a time per database. */
  private call<T>(op: string, args: unknown, timeoutMs: number): Promise<T> {
    const run = async () => {
      await this.ensure();
      return this.rawCall<T>(op, args, timeoutMs);
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  async serverVersion(): Promise<string> {
    return `SQLite ${await this.ensure()}`;
  }

  read(sql: string, o: ReadOptions): Promise<RawResult> {
    return this.call<RawResult>(
      "read",
      { sql, params: o.params ?? [], offset: o.offset, maxRows: o.maxRows, maxBytes: o.maxBytes },
      o.timeoutMs,
    );
  }

  async write(sql: string, o: WriteOptions): Promise<WriteOutcome> {
    if (!this.writable) throw new SafeSqlError("READ_ONLY", "This database is read-only.");
    const r = await this.call<WriteOutcome & { overLimit?: boolean }>(
      "write",
      { sql, params: o.params ?? [], dryRun: o.dryRun, maxAffected: o.maxAffected, previewRows: o.previewRows },
      o.timeoutMs,
    );
    if (r.overLimit)
      throw new SafeSqlError(
        "TOO_MANY_ROWS",
        `The statement would change ${r.affected} rows, more than the limit of ${o.maxAffected}. Nothing was changed (rolled back).`,
        "Narrow the WHERE clause, split the change into batches, or raise maxAffectedRows in the config.",
      );
    return r;
  }

  async explain(sql: string, o: { params?: unknown[]; analyze: boolean; timeoutMs: number }): Promise<PlanResult> {
    const rows = await this.call<{ id: number; parent: number; detail: string }[]>(
      "all",
      { sql: `EXPLAIN QUERY PLAN ${sql}`, params: o.params ?? [] },
      o.timeoutMs,
    );
    const children = new Map<number, { id: number; detail: string }[]>();
    for (const r of rows) {
      const list = children.get(r.parent) ?? [];
      list.push(r);
      children.set(r.parent, list);
    }
    const lines: string[] = [];
    const walk = (parent: number, depth: number) => {
      for (const r of children.get(parent) ?? []) {
        lines.push(`${"  ".repeat(depth)}${r.detail}`);
        walk(r.id, depth + 1);
      }
    };
    walk(0, 0);
    let executionMs: number | undefined;
    let rowCount: number | undefined;
    if (o.analyze) {
      const start = performance.now();
      const res = await this.read(sql, { params: o.params, offset: 0, maxRows: 200_000, maxBytes: 50_000_000, timeoutMs: o.timeoutMs });
      executionMs = performance.now() - start;
      rowCount = res.rows.length;
      lines.push(`-- executed: ${rowCount} rows in ${executionMs.toFixed(1)} ms`);
    }
    const schema = await this.loadSchema();
    return {
      text: lines.join("\n"),
      raw: rows,
      hints: sqlitePlanHints(
        rows.map((r) => r.detail),
        schema,
      ),
      executionMs,
    };
  }

  async access(sql: string, params: unknown[] | undefined): Promise<AccessSet> {
    const r = await this.call<{ tables: string[]; columns: string[]; partial: boolean }>("access", { sql, params: params ?? [] }, 15_000);
    return { tables: new Set(r.tables), columns: new Set(r.columns), partial: r.partial };
  }

  loadSchema(): Promise<SchemaModel> {
    return this.call<SchemaModel>("schema", {}, 30_000);
  }

  async countRows(table: TableInfo, timeoutMs: number): Promise<number | null> {
    try {
      const r = await this.call<{ n: number }[]>("all", { sql: `SELECT count(*) AS n FROM ${quoteIdent(table.name)}` }, timeoutMs);
      return Number(r[0]?.n ?? 0);
    } catch {
      return null;
    }
  }

  /** Internal trusted read for introspection and profiling (still on the read-only connection). */
  internalAll<T = Record<string, unknown>>(sql: string, params: unknown[] = [], timeoutMs = 30_000): Promise<T[]> {
    return this.call<T[]>("all", { sql, params }, timeoutMs);
  }

  async probeReadOnly(): Promise<string> {
    const r = await this.call<{ refused: boolean; message: string }>("probe", {}, 10_000);
    if (!r.refused) throw new SafeSqlError("INTERNAL", "The read connection accepted a write. This should never happen.");
    return r.message;
  }

  async close(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    try {
      await this.rawCall("close", {}, 2000);
    } catch {
      // ignore
    }
    this.worker = undefined;
    this.ready = undefined;
    await worker.terminate();
  }
}

function sqliteError(message: string, code?: string): SafeSqlError {
  if (code === "READ_ONLY") return new SafeSqlError("READ_ONLY", message);
  if (/attempt to write a readonly database|query_only/i.test(message))
    return new SafeSqlError(
      "READ_ONLY",
      `The database refused a write: ${message}`,
      "This connection is read-only. Writes need write mode and the execute tool.",
    );
  return new SafeSqlError("SQL_ERROR", message);
}
