#!/usr/bin/env node
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createDemoDatabase,
  demoStatements,
  isLikelyDatabaseSpec,
  type ResultFormat,
  resolveConfig,
  SafeSql,
  toSafeSqlError,
} from "@safesql/core";
import { overridesFrom, parseArgs } from "./cli-args.js";
import { formatChecks, runDoctor } from "./doctor.js";
import { startHttpServer } from "./http.js";
import { CLIENTS, type ClientName, installClient } from "./init.js";
import { createServer } from "./server.js";
import { TOOL_NAMES } from "./tools.js";
import { NAME, VERSION } from "./version.js";

// node:sqlite prints an ExperimentalWarning on some Node versions; keep stderr clean for MCP clients.
const originalEmit = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning?.message;
  if (text?.includes("SQLite")) return;
  return (originalEmit as (...a: unknown[]) => void).call(process, warning, ...rest);
}) as typeof process.emitWarning;

const HELP = `${NAME} v${VERSION} - safe SQL MCP server for SQLite and PostgreSQL (read-only by default)

Usage:
  ${NAME} [database...] [options]        Start the MCP server on stdio (what MCP clients run)
  ${NAME} --http [database...] [--port 3000] [--host 127.0.0.1]
                                          Streamable HTTP server at http://host:port/mcp
  ${NAME} init <client|all> [database...] [options] [--dry-run] [--name safesql]
                                          Add the server to ${CLIENTS.join(", ")}
  ${NAME} doctor [database...]            Check setup, connections and read-only enforcement
  ${NAME} demo [file] [--force]           Create a sample SQLite shop database (default ./safesql-demo.db)
  ${NAME} demo --sql postgres             Print the same sample data as SQL (pipe into psql)
  ${NAME} query <database> "<sql>" [--format table|csv|json|markdown]
  ${NAME} schema <database>               Print the compact schema overview
  ${NAME} tools                           List MCP tools
  ${NAME} --version | --help

Databases:
  ./app.db  sqlite:./app.db  postgres://user:pass@host:5432/db  name=<any of these>
  Or set DATABASE_URL, SAFESQL_DB_<NAME>=..., or use safesql.config.json (--config).

Options:
  --write                 Allow INSERT/UPDATE/DELETE through the execute tool (dry run + confirm)
  --admin                 Also allow schema changes (CREATE/ALTER/DROP)
  --max-rows <n>          Rows per query page (default 100)
  --timeout <ms>          Statement timeout (default 15000)
  --max-affected <n>      Roll back writes that change more rows (default 1000)
  --allow-tables <list>   Only these tables are visible (comma list, * wildcards)
  --deny-tables <list>    Hide these tables
  --deny-columns <list>   Hide these columns, e.g. users.password_hash,*.ssn
  --redact-columns <list> Mask these columns in results (on top of automatic secrets)
  --no-redact             Turn off automatic masking of password/token/secret columns
  --mask-emails           Mask e-mail addresses (j***@example.com)
  --export-dir <dir>      Where export_query writes files (default ~/safesql-exports)
  --audit-log <file|off>  JSONL audit log (default ~/.safesql-mcp/audit.jsonl)
  --config <file>         JSON config file (default ./safesql.config.json if present)

Environment:
  DATABASE_URL, SAFESQL_DB_<NAME>, SAFESQL_CONFIG, SAFESQL_MODE, SAFESQL_MAX_ROWS, SAFESQL_TIMEOUT_MS,
  SAFESQL_EXPORT_DIR, SAFESQL_AUDIT_LOG, SAFESQL_HTTP_TOKEN (require "Authorization: Bearer <token>"), PORT, HOST
`;

/** Make SQLite paths absolute so client configs work from any working directory. */
function absolutize(specs: string[]): string[] {
  return specs.map((s) => {
    const m = /^([A-Za-z][A-Za-z0-9_-]*=)?(.*)$/.exec(s)!;
    const prefix = m[1] ?? "";
    const url = m[2]!;
    if (/^(postgres|postgresql|mysql|mariadb):\/\//i.test(url) || url.includes("${")) return s;
    const path = url.replace(/^(sqlite|file):(\/\/)?/i, "");
    return `${prefix}${resolve(path)}`;
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const p = parseArgs(argv);
  const [cmd, ...rest] = p.positional;
  if (p.flags.help || cmd === "help") return void process.stdout.write(HELP);
  if (p.flags.version) return void process.stdout.write(`${VERSION}\n`);
  if (cmd === "tools") return void process.stdout.write(`${TOOL_NAMES.join("\n")}\n`);

  if (cmd === "demo") {
    if (typeof p.flags.sql === "string") {
      if (p.flags.sql !== "postgres" && p.flags.sql !== "sqlite") throw new Error("--sql must be postgres or sqlite.");
      process.stdout.write(`${demoStatements(p.flags.sql).join(";\n")};\n`);
      return;
    }
    const file = resolve(rest[0] ?? "safesql-demo.db");
    createDemoDatabase(file, !!p.flags.force);
    process.stdout.write(
      `Created ${file} (customers, products, orders, order_items, api_keys + a view).\n\nTry it:\n  ${NAME} schema ${file}\n  ${NAME} query ${file} "SELECT status, count(*) FROM orders GROUP BY status"\n  ${NAME} init claude ${file}\n`,
    );
    return;
  }

  if (cmd === "init") {
    const target = rest[0];
    const clients = target === "all" ? [...CLIENTS] : CLIENTS.includes(target as ClientName) ? [target as ClientName] : [];
    if (!clients.length) {
      process.stderr.write(`Usage: ${NAME} init <${CLIENTS.join("|")}|all> [database...] [options]\n`);
      process.exitCode = 1;
      return;
    }
    const specs = absolutize(rest.slice(1));
    if (!specs.length && !p.flags.config)
      process.stderr.write("Note: no database given. The server will use DATABASE_URL / SAFESQL_DB_* from the client's environment.\n");
    if (specs.some((s) => /:\/\/[^:/@]+:[^@]+@/.test(s)))
      process.stderr.write(
        "Warning: the connection URL contains a password and will be stored in the client config file in plain text.\n  Consider SAFESQL_DB_<NAME> or DATABASE_URL in the client's env settings instead.\n",
      );
    const args = [...specs, ...p.forward];
    const name = typeof p.flags.name === "string" ? p.flags.name : undefined;
    for (const c of clients) {
      const r = installClient(c, { dryRun: !!p.flags["dry-run"], args, name });
      if (r.action === "command") process.stdout.write(`${c}: run this command:\n  ${r.command}\n`);
      else if (r.action === "dry-run") process.stdout.write(`${c}: would write ${r.path}\n${JSON.stringify(r.config, null, 2)}\n`);
      else process.stdout.write(`${c}: ${r.action} ${r.path}${r.action === "written" ? " (restart the app to load it)" : ""}\n`);
    }
    return;
  }

  if (cmd === "doctor") {
    const engine = new SafeSql(resolveConfig(overridesFrom(p, rest)));
    try {
      const checks = await runDoctor(engine);
      process.stdout.write(`${NAME} v${VERSION} doctor\n${formatChecks(checks)}\n`);
      if (checks.some((c) => c.ok === false)) process.exitCode = 1;
    } finally {
      await engine.close();
    }
    return;
  }

  if (cmd === "query" || cmd === "schema") {
    const [spec, sql] = rest;
    if (!spec || (cmd === "query" && !sql)) throw new Error(`Usage: ${NAME} ${cmd} <database> ${cmd === "query" ? '"<sql>"' : ""}`);
    const engine = new SafeSql(
      resolveConfig({ ...overridesFrom(p, [spec]), auditLog: p.flags["audit-log"] === undefined ? false : overridesFrom(p, []).auditLog }),
    );
    try {
      const name = [...engine.databases.keys()].pop();
      if (cmd === "schema") process.stdout.write(`${engine.scrub(await engine.schemaOverview(name))}\n`);
      else {
        const r = await engine.query(name, sql!, { tool: "cli" });
        process.stdout.write(
          `${engine.scrub(engine.formatQuery(r, (typeof p.flags.format === "string" ? p.flags.format : "table") as ResultFormat))}\n`,
        );
      }
    } finally {
      await engine.close();
    }
    return;
  }

  const http = p.flags.http || cmd === "http" || process.env.MCP_TRANSPORT === "http";
  const specs = cmd === "http" || cmd === "stdio" ? rest : p.positional;
  for (const spec of specs) {
    if (!isLikelyDatabaseSpec(spec)) {
      process.stderr.write(`Unknown command or database "${spec}".\n\n${HELP}`);
      process.exitCode = 1;
      return;
    }
  }
  const engine = new SafeSql(resolveConfig(overridesFrom(p, specs)));
  const shutdown = () => {
    void engine.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  const summary = [...engine.databases.values()].map((d) => `${d.name} (${d.config.engine}, ${d.mode})`).join(", ") || "no databases";
  if (http) {
    const port = Number(p.flags.port ?? process.env.PORT ?? 3000);
    const host = String(p.flags.host ?? process.env.HOST ?? "127.0.0.1");
    const token = typeof p.flags.token === "string" ? p.flags.token : process.env.SAFESQL_HTTP_TOKEN;
    await startHttpServer(engine, { port, host, token });
    process.stderr.write(`${NAME} v${VERSION} listening on http://${host}:${port}/mcp - ${summary}\n`);
    if (!token && !["127.0.0.1", "localhost", "::1"].includes(host))
      process.stderr.write(
        "Warning: listening on a non-local address without SAFESQL_HTTP_TOKEN. Anyone who can reach this port can query your databases.\n",
      );
    return;
  }
  const server = createServer(engine);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`${NAME} v${VERSION} running on stdio - ${summary}\n`);
}

main().catch((err) => {
  const e = toSafeSqlError(err);
  process.stderr.write(`Error: ${e.message}${e.hint ? `\nHint: ${e.hint}` : ""}\n`);
  process.exit(1);
});
