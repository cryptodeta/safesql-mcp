import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatCount, type ResultFormat, type SafeSql, SafeSqlError } from "@safesql/core";
import { z } from "zod";
import { list, run } from "./respond.js";
import { NAME, VERSION } from "./version.js";

export const READ_TOOLS = [
  "list_databases",
  "list_tables",
  "describe_table",
  "schema_overview",
  "search_schema",
  "sample_rows",
  "query",
  "explain",
  "profile_table",
  "relationships",
  "export_query",
  "saved_queries",
  "audit_log",
] as const;
export const WRITE_TOOLS = ["execute"] as const;
export const TOOL_NAMES = [...READ_TOOLS, ...WRITE_TOOLS] as const;

const db = z.string().optional().describe("Database name from list_databases. Optional when only one is connected.");
const params = z
  .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .optional()
  .describe("Bind parameters: $1, $2 (PostgreSQL) or ? (SQLite). Prefer these over pasting values into SQL.");
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export function registerTools(server: McpServer, engine: SafeSql): void {
  server.registerTool(
    "list_databases",
    {
      title: "List databases",
      description:
        "List connected databases with engine, mode (read/write/admin), limits and policy. Start here when you do not know the database name. Credentials are never shown.",
      inputSchema: {},
      annotations: readOnly,
    },
    () =>
      run(engine, async () => {
        const lines = [`${NAME} v${VERSION}: ${engine.databases.size} database${engine.databases.size === 1 ? "" : "s"}`];
        for (const d of engine.databases.values()) {
          let version = "";
          try {
            version = await Promise.race([
              d.driver.serverVersion(),
              new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
            ]);
          } catch (err) {
            version = `unreachable (${(err as Error).message})`;
          }
          const p = d.policy.cfg;
          const policy = [
            p.allowTables.length ? `only tables ${p.allowTables.join(",")}` : "",
            p.denyTables.length ? `hidden tables ${p.denyTables.join(",")}` : "",
            p.denyColumns.length ? `hidden columns ${p.denyColumns.join(",")}` : "",
            `redaction ${p.redact}${p.redactColumns.length ? ` + ${p.redactColumns.join(",")}` : ""}`,
            p.maskEmails ? "emails masked" : "",
          ]
            .filter(Boolean)
            .join("; ");
          const l = d.limits;
          lines.push(
            `- ${d.name}: ${d.config.engine}, ${d.mode.toUpperCase()} mode, ${version}${d.config.description ? ` - ${d.config.description}` : ""}`,
            `  location: ${d.config.display}`,
            `  limits: ${l.maxRows} rows/page, ${Math.round(l.maxBytes / 1000)} KB/response, ${l.timeoutMs} ms timeout${d.mode !== "read" ? `, max ${l.maxAffectedRows} rows changed per write` : ""}`,
            `  policy: ${policy}`,
          );
        }
        if (!engine.anyWritable) lines.push("All databases are read-only: writes are refused by the database engine itself.");
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "list_tables",
    {
      title: "List tables",
      description:
        "List tables and views with approximate row counts and column counts. Filter by schema or a name pattern (* or % wildcards). Compact output.",
      inputSchema: {
        db,
        schema: z.string().optional().describe("Only this schema (PostgreSQL)."),
        pattern: z.string().optional().describe("Name filter, e.g. 'order*' or '%log%'."),
      },
      annotations: readOnly,
    },
    ({ db: name, schema, pattern }) => run(engine, () => engine.listTables(name, { schema, pattern })),
  );

  server.registerTool(
    "describe_table",
    {
      title: "Describe table",
      description:
        "Columns with types, primary key, NOT NULL, defaults and foreign keys, plus indexes, row estimate and which tables reference it. Pass several tables at once to save calls.",
      inputSchema: {
        db,
        table: z.union([z.string(), z.array(z.string())]).describe("Table or view name (schema.table allowed), or a list."),
      },
      annotations: readOnly,
    },
    ({ db: name, table }) =>
      run(engine, async () => {
        const names = list(table);
        if (!names.length) throw new SafeSqlError("BAD_INPUT", "Give at least one table name.");
        const parts = await Promise.all(names.slice(0, 20).map((t) => engine.describeTable(name, t)));
        return parts.join("\n\n");
      }),
  );

  server.registerTool(
    "schema_overview",
    {
      title: "Schema overview",
      description:
        "The whole schema in one compact block (one line per table: columns, types, keys, row counts). The cheapest way to understand a database before writing SQL.",
      inputSchema: {
        db,
        schema: z.string().optional().describe("Only this schema (PostgreSQL)."),
        max_chars: z.number().int().min(500).max(200_000).optional().describe("Character budget (default 12000)."),
        refresh: z.boolean().optional().describe("Reload the schema instead of using the 5-minute cache."),
      },
      annotations: readOnly,
    },
    ({ db: name, schema, max_chars, refresh }) => run(engine, () => engine.schemaOverview(name, { schema, maxChars: max_chars, refresh })),
  );

  server.registerTool(
    "search_schema",
    {
      title: "Search schema",
      description:
        "Find tables and columns whose name or comment contains a word, e.g. 'email', 'price', 'created'. Suggests close names when nothing matches.",
      inputSchema: { db, term: z.string().min(1).describe("Word to search for.") },
      annotations: readOnly,
    },
    ({ db: name, term }) => run(engine, () => engine.searchSchema(name, term)),
  );

  server.registerTool(
    "sample_rows",
    {
      title: "Sample rows",
      description: "A few example rows from a table (first rows, or random). Sensitive columns are redacted.",
      inputSchema: {
        db,
        table: z.string().describe("Table or view name."),
        rows: z.number().int().min(1).max(100).optional().describe("How many rows (default 5)."),
        random: z.boolean().optional().describe("Random rows instead of the first ones (slower on big tables)."),
        columns: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe("Only these columns."),
        where: z.string().optional().describe("Optional SQL filter, e.g. \"status = 'shipped'\"."),
      },
      annotations: readOnly,
    },
    ({ db: name, table, rows, random, columns, where }) =>
      run(engine, async () => {
        const r = await engine.sample(name, table, { rows, random, columns: list(columns), where });
        return engine.formatQuery(r);
      }),
  );

  server.registerTool(
    "query",
    {
      title: "Run a read query",
      description:
        "Run one read-only SQL statement (SELECT, WITH, VALUES, EXPLAIN, SHOW, read PRAGMAs). Results are capped by rows, bytes and time; use offset to page. " +
        "Output is a compact pipe-separated table by default. Reads run on a read-only connection/transaction, so they cannot change data. " +
        "Use LIMIT and aggregates to keep answers small. Can also run a saved query by name.",
      inputSchema: {
        db,
        sql: z.string().optional().describe("One SQL statement. Not needed when 'saved' is given."),
        saved: z.string().optional().describe("Name of a saved query to run instead of sql."),
        params,
        max_rows: z.number().int().min(1).max(10_000).optional().describe("Rows per page (default from server, usually 100)."),
        offset: z.number().int().min(0).optional().describe("Skip this many rows (pagination)."),
        format: z.enum(["table", "markdown", "csv", "json"]).optional().describe("Output format (default table: most token-efficient)."),
        timeout_ms: z.number().int().min(100).optional().describe("Lower the timeout for this query (cannot exceed the server limit)."),
      },
      annotations: readOnly,
    },
    ({ db: name, sql, saved, params: p, max_rows, offset, format, timeout_ms }) =>
      run(engine, async () => {
        let text = sql;
        let target = name;
        if (saved) {
          const s = engine.getSaved(saved);
          text = s.sql;
          target = name ?? s.db;
        }
        if (!text) throw new SafeSqlError("BAD_INPUT", "Give sql or the name of a saved query.");
        const r = await engine.query(target, text, { params: p, maxRows: max_rows, offset, timeoutMs: timeout_ms });
        return engine.formatQuery(r, (format ?? "table") as ResultFormat);
      }),
  );

  server.registerTool(
    "explain",
    {
      title: "Explain query plan",
      description:
        "Show how the database will run a query (EXPLAIN) with plain-language tuning hints: full scans, missing indexes, sorts, bad estimates. " +
        "analyze=true also runs it (read queries only, inside a read-only transaction) to get real timings.",
      inputSchema: {
        db,
        sql: z.string().describe("The statement to explain."),
        params,
        analyze: z.boolean().optional().describe("Execute and measure (EXPLAIN ANALYZE). Read queries only."),
      },
      annotations: readOnly,
    },
    ({ db: name, sql, params: p, analyze }) =>
      run(engine, async () => {
        const plan = await engine.explain(name, sql, { params: p, analyze });
        const lines = [plan.text];
        if (plan.hints.length) lines.push("", "Hints:", ...plan.hints.map((h) => `- ${h}`));
        else lines.push("", "No obvious problems in this plan.");
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "profile_table",
    {
      title: "Profile table",
      description:
        "Data quality profile per column: null %, distinct count, min/max/avg and top values, plus notes (always-NULL, single-value columns). Samples large tables.",
      inputSchema: {
        db,
        table: z.string().describe("Table or view name."),
        columns: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe("Only these columns (default: first 40)."),
        sample_size: z.number().int().min(100).optional().describe("Rows to scan (default 100000)."),
        top_values: z.number().int().min(0).max(10).optional().describe("Top values per column (default 3)."),
      },
      annotations: readOnly,
    },
    ({ db: name, table, columns, sample_size, top_values }) =>
      run(engine, () => engine.profile(name, table, { columns: list(columns), sampleSize: sample_size, topValues: top_values })),
  );

  server.registerTool(
    "relationships",
    {
      title: "Relationships / ER diagram",
      description:
        "Foreign-key relationships as a Mermaid erDiagram (paste into Markdown to render) or a plain list. Focus on one table and its neighbours with depth.",
      inputSchema: {
        db,
        table: z.string().optional().describe("Center the diagram on this table."),
        depth: z.number().int().min(1).max(5).optional().describe("Hops from the table (default 1)."),
        format: z.enum(["mermaid", "list"]).optional().describe("mermaid (default) or list."),
        columns: z.boolean().optional().describe("Include every column in the diagram (default: keys only)."),
      },
      annotations: readOnly,
    },
    ({ db: name, table, depth, format, columns }) => run(engine, () => engine.relationships(name, { table, depth, format, columns })),
  );

  server.registerTool(
    "export_query",
    {
      title: "Export query to file",
      description: `Run a read query and save all rows (up to the export limit) to a CSV, JSON, JSONL or Markdown file in the export directory (${engine.config.exportDir}). Returns the path, not the data.`,
      inputSchema: {
        db,
        sql: z.string().describe("Read query to export."),
        file: z.string().describe("File name inside the export directory, e.g. 'orders-2026.csv'. The extension picks the format."),
        format: z.enum(["csv", "json", "jsonl", "markdown"]).optional(),
        params,
        overwrite: z.boolean().optional().describe("Replace an existing file."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ db: name, sql, file, format, params: p, overwrite }) =>
      run(engine, async () => {
        const r = await engine.exportQuery(name, sql, file, { format, params: p, overwrite });
        return `Exported ${r.rows} rows (${formatCount(r.bytes)} bytes, ${r.format}) to ${r.path}${r.truncated ? `\nStopped at the export limit; there are more rows.` : ""}`;
      }),
  );

  server.registerTool(
    "saved_queries",
    {
      title: "Saved queries",
      description: "List, save or delete named read queries. Run one with query(saved=name). Queries from the config file are read-only.",
      inputSchema: {
        action: z.enum(["list", "save", "delete"]).optional().describe("Default list."),
        name: z.string().optional(),
        sql: z.string().optional().describe("For save: the read query."),
        db,
        description: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ action, name, sql, db: dbName, description }) =>
      run(engine, () => {
        const act = action ?? "list";
        if (act === "save") {
          if (!name || !sql) throw new SafeSqlError("BAD_INPUT", "save needs name and sql.");
          engine.saveQuery(name, sql, { db: dbName, description });
          return `Saved "${name}". Run it with query(saved="${name}").`;
        }
        if (act === "delete") {
          if (!name) throw new SafeSqlError("BAD_INPUT", "delete needs name.");
          return engine.deleteQuery(name) ? `Deleted "${name}".` : `No saved query "${name}" (config-file queries cannot be deleted here).`;
        }
        const all = Object.entries(engine.savedQueries());
        if (!all.length) return "No saved queries yet. Save one with action=save.";
        return all
          .map(
            ([k, v]) =>
              `- ${k}${v.db ? ` [${v.db}]` : ""}${v.source === "config" ? " (config)" : ""}${v.description ? `: ${v.description}` : ""}\n  ${v.sql.replace(/\s+/g, " ")}`,
          )
          .join("\n");
      }),
  );

  server.registerTool(
    "audit_log",
    {
      title: "Audit log",
      description:
        "Recent statements run through this server (newest first): tool, SQL, rows, time, errors and blocked attempts. Bind parameter values are not logged.",
      inputSchema: {
        db,
        limit: z.number().int().min(1).max(200).optional().describe("Default 20."),
        only_writes: z.boolean().optional(),
        only_errors: z.boolean().optional(),
      },
      annotations: readOnly,
    },
    ({ db: dbName, limit, only_writes, only_errors }) =>
      run(engine, () => {
        const entries = engine.audit.recent(limit ?? 20, { db: dbName, onlyWrites: only_writes, onlyErrors: only_errors });
        const st = engine.audit.status;
        const head = `Audit log${st.path ? ` (${st.path})` : " (memory only)"}${st.error ? ` - file error: ${st.error}` : ""}`;
        if (!entries.length) return `${head}\nNo entries yet.`;
        return [
          head,
          ...entries.map(
            (e) =>
              `${e.ts} ${e.db} ${e.tool} ${e.ok ? "ok" : "FAILED"}${e.dryRun ? " dry-run" : ""}${e.committed ? " committed" : ""}${e.rows !== undefined ? ` rows=${e.rows}` : ""}${e.affected !== undefined ? ` affected=${e.affected}` : ""}${e.ms !== undefined ? ` ${e.ms}ms` : ""}\n  ${(e.sql ?? "").replace(/\s+/g, " ").slice(0, 300)}${e.error ? `\n  ${e.error}` : ""}`,
          ),
        ].join("\n");
      }),
  );

  if (!engine.anyWritable) return;

  server.registerTool(
    "execute",
    {
      title: "Change data (dry run first)",
      description:
        "Run one INSERT/UPDATE/DELETE (write mode) or schema change (admin mode). Always two steps: " +
        "1) call with dry_run=true (default): it runs inside a transaction, reports affected rows and a preview, then ROLLS BACK and returns a confirm token; " +
        "2) after the user agrees, call again with the exact same SQL and confirm=<token> to commit. " +
        "UPDATE/DELETE need a real WHERE clause. Changes above the row limit are rolled back.",
      inputSchema: {
        db,
        sql: z.string().describe("One data or schema change statement."),
        params,
        dry_run: z.boolean().optional().describe("Default true. Ignored when confirm is given."),
        confirm: z.string().optional().describe("Token from the dry run, to commit the change."),
        allow_full_table: z.boolean().optional().describe("Allow UPDATE/DELETE that touch every row. Only when the user asked for that."),
        preview_rows: z.number().int().min(0).max(50).optional().describe("Rows to show in the dry-run preview (default 5)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    ({ db: name, sql, params: p, dry_run, confirm, allow_full_table, preview_rows }) =>
      run(engine, async () => {
        const r = await engine.execute(name, sql, {
          params: p,
          dryRun: dry_run,
          confirm,
          allowFullTable: allow_full_table,
          previewRows: preview_rows,
        });
        return engine.formatExecute(r);
      }),
  );
}
