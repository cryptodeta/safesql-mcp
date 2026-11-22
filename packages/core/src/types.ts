import type { Dialect } from "./lexer.js";

export type Engine = Dialect;
export type Mode = "read" | "write" | "admin";

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default?: string | null;
  pk: boolean;
  comment?: string | null;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface ForeignKey {
  name?: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
}

export interface TableInfo {
  schema: string;
  name: string;
  kind: "table" | "view" | "materialized view" | "foreign table" | "virtual table";
  rowEstimate?: number | null;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKey[];
  comment?: string | null;
  withoutRowid?: boolean;
}

export interface SchemaModel {
  engine: Engine;
  defaultSchema: string;
  tables: TableInfo[];
  loadedAt: number;
}

export interface FieldOrigin {
  name: string;
  /** Source table and column when the result column is a plain column reference. */
  table?: string;
  schema?: string;
  column?: string;
  type?: string;
}

export interface RawResult {
  fields: FieldOrigin[];
  rows: unknown[][];
  /** More rows exist after the returned page. */
  hasMore: boolean;
  /** Stopped early because the byte budget was reached. */
  byteCapped?: boolean;
}

export interface ReadOptions {
  params?: unknown[];
  maxRows: number;
  offset: number;
  timeoutMs: number;
  maxBytes: number;
}

export interface WriteOutcome {
  affected: number;
  /** Rows from RETURNING (or an automatic preview RETURNING *). */
  returning?: RawResult;
  committed: boolean;
}

export interface WriteOptions {
  params?: unknown[];
  timeoutMs: number;
  /** Run, measure and roll back. */
  dryRun: boolean;
  /** Roll back instead of committing when more rows than this would change. */
  maxAffected: number;
  /** Append RETURNING * to preview changed rows (dry runs only). */
  previewRows: number;
}

/** Tables and columns that a statement reads or writes, as found by the database's own planner. */
export interface AccessSet {
  tables: Set<string>;
  /** "table.column" */
  columns: Set<string>;
  /** The planner could not be fully mapped (virtual tables, functions). */
  partial?: boolean;
}

export interface PlanResult {
  /** Text plan, indented. */
  text: string;
  /** Raw plan (PostgreSQL JSON or SQLite rows). */
  raw: unknown;
  hints: string[];
  executionMs?: number;
}

export interface Driver {
  readonly engine: Engine;
  readonly writable: boolean;
  connect(): Promise<void>;
  serverVersion(): Promise<string>;
  read(sql: string, opts: ReadOptions): Promise<RawResult>;
  write(sql: string, opts: WriteOptions): Promise<WriteOutcome>;
  explain(sql: string, opts: { params?: unknown[]; analyze: boolean; timeoutMs: number }): Promise<PlanResult>;
  access(sql: string, params: unknown[] | undefined, schema: SchemaModel): Promise<AccessSet>;
  loadSchema(): Promise<SchemaModel>;
  /** Exact or estimated row count. */
  countRows(table: TableInfo, timeoutMs: number): Promise<number | null>;
  /** Verify that a write is refused on the read path. Returns the engine's refusal message. */
  probeReadOnly(): Promise<string>;
  close(): Promise<void>;
}
