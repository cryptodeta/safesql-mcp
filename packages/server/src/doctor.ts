import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { PostgresDriver, type SafeSql, toSafeSqlError } from "@safesql/core";
import { installedClients } from "./init.js";

export interface Check {
  ok: boolean | "warn";
  label: string;
  detail?: string;
}

const MIN_NODE = [22, 16];

export async function runDoctor(engine: SafeSql, opts: { home?: string } = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const [maj = 0, min = 0] = process.versions.node.split(".").map(Number);
  const nodeOk = maj > MIN_NODE[0]! || (maj === MIN_NODE[0] && min >= MIN_NODE[1]!);
  checks.push({
    ok: nodeOk,
    label: `Node.js ${process.versions.node}`,
    detail: nodeOk ? undefined : `Need ${MIN_NODE.join(".")} or newer (node:sqlite).`,
  });
  try {
    createRequire(import.meta.url)("node:sqlite");
    checks.push({ ok: true, label: "node:sqlite available" });
  } catch (err) {
    checks.push({ ok: false, label: "node:sqlite unavailable", detail: (err as Error).message });
  }
  if (engine.config.configFile) checks.push({ ok: true, label: `config file ${engine.config.configFile}` });
  if (!engine.databases.size)
    checks.push({
      ok: false,
      label: "no databases configured",
      detail: "Pass a SQLite path or postgres:// URL, e.g. `safesql-mcp doctor ./app.db`, or set DATABASE_URL.",
    });

  for (const d of engine.databases.values()) {
    const prefix = `[${d.name}]`;
    try {
      const version = await d.driver.serverVersion();
      checks.push({ ok: true, label: `${prefix} connected: ${version}`, detail: engine.scrub(d.config.display) });
      const tables = await engine.visibleTables(d.name, true);
      checks.push({
        ok: tables.length ? true : "warn",
        label: `${prefix} ${tables.length} tables/views visible`,
        detail: tables.length ? undefined : "The database is empty or the policy hides everything.",
      });
      const refusal = await d.driver.probeReadOnly();
      checks.push({ ok: true, label: `${prefix} read path refuses writes (engine-enforced)`, detail: refusal.split("\n")[0] });
      checks.push({
        ok: d.mode === "read" ? true : "warn",
        label: `${prefix} mode: ${d.mode}`,
        detail: d.mode === "read" ? undefined : "Writes are allowed through the execute tool (dry run + confirm).",
      });
      if (d.driver instanceof PostgresDriver) {
        const p = await d.driver.privileges();
        if (p.superuser)
          checks.push({
            ok: "warn",
            label: `${prefix} role "${p.role}" is a superuser`,
            detail: "Use a dedicated read-only role for AI access (see README: Hardening).",
          });
        else if (d.mode === "read" && p.writableTables > 0)
          checks.push({
            ok: "warn",
            label: `${prefix} role "${p.role}" can write to ${p.writableTables} tables`,
            detail:
              "Reads are still locked to READ ONLY transactions, but a read-only role adds a second layer: GRANT pg_read_all_data TO <role>;",
          });
        else checks.push({ ok: true, label: `${prefix} role "${p.role}" privileges look appropriate` });
      }
    } catch (err) {
      const e = toSafeSqlError(err);
      checks.push({ ok: false, label: `${prefix} ${e.message}`, detail: e.hint });
    }
  }

  const dir = engine.config.exportDir;
  try {
    if (!existsSync(dir)) checks.push({ ok: true, label: `export dir ${dir} (created on first export)` });
    else {
      accessSync(dir, constants.W_OK);
      checks.push({ ok: true, label: `export dir ${dir} writable` });
    }
  } catch {
    checks.push({ ok: "warn", label: `export dir ${dir} is not writable`, detail: "Set SAFESQL_EXPORT_DIR or --export-dir." });
  }
  if (engine.config.auditLog) {
    try {
      mkdirSync(engine.config.stateDir, { recursive: true });
      checks.push({ ok: true, label: `audit log ${engine.config.auditLog}` });
    } catch (err) {
      checks.push({ ok: "warn", label: "audit log directory not writable", detail: (err as Error).message });
    }
  } else checks.push({ ok: "warn", label: "audit log disabled" });
  const clients = installedClients({ home: opts.home });
  checks.push(
    clients.length
      ? { ok: true, label: `configured in: ${clients.map((c) => c.client).join(", ")}` }
      : {
          ok: "warn",
          label: "not added to any MCP client yet",
          detail: "Run: npx -y safesql-mcp init <claude|cursor|vscode|windsurf|claude-code|all> <database>",
        },
  );
  return checks;
}

export function formatChecks(checks: Check[]): string {
  return checks
    .map((c) => `${c.ok === true ? "✓" : c.ok === "warn" ? "!" : "✗"} ${c.label}${c.detail ? `\n    ${c.detail}` : ""}`)
    .join("\n");
}
