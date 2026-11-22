import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AuditEntry {
  ts: string;
  db: string;
  tool: string;
  kind?: string;
  verb?: string;
  sql?: string;
  params?: number;
  ok: boolean;
  rows?: number;
  affected?: number;
  dryRun?: boolean;
  committed?: boolean;
  ms?: number;
  error?: string;
}

/** Append-only JSONL audit log plus an in-memory ring buffer for the audit_log tool. */
export class AuditLog {
  private readonly ring: AuditEntry[] = [];
  private fileError?: string;
  constructor(
    readonly path: string | undefined,
    private readonly capacity = 500,
  ) {
    if (path) {
      try {
        mkdirSync(dirname(path), { recursive: true });
      } catch (err) {
        this.fileError = (err as Error).message;
      }
    }
  }

  record(e: Omit<AuditEntry, "ts">): AuditEntry {
    const entry: AuditEntry = { ts: new Date().toISOString(), ...e };
    if (entry.sql && entry.sql.length > 4000) entry.sql = `${entry.sql.slice(0, 4000)}…`;
    this.ring.push(entry);
    if (this.ring.length > this.capacity) this.ring.shift();
    if (this.path && !this.fileError) {
      try {
        appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
      } catch (err) {
        this.fileError = (err as Error).message;
      }
    }
    return entry;
  }

  recent(limit = 20, filter?: { db?: string; onlyWrites?: boolean; onlyErrors?: boolean }): AuditEntry[] {
    let list = this.ring;
    if (filter?.db) list = list.filter((e) => e.db === filter.db);
    if (filter?.onlyWrites) list = list.filter((e) => e.kind === "write" || e.kind === "ddl");
    if (filter?.onlyErrors) list = list.filter((e) => !e.ok);
    return list.slice(-limit).reverse();
  }

  get status(): { path?: string; error?: string; entries: number } {
    return { path: this.path, error: this.fileError, entries: this.ring.length };
  }
}
