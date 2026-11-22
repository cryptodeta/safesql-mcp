import type { CliOverrides, Mode } from "@safesql/core";
import { NAME } from "./version.js";

export const VALUE_FLAGS = new Set([
  "port",
  "host",
  "max-rows",
  "timeout",
  "max-affected",
  "allow-tables",
  "deny-tables",
  "deny-columns",
  "redact-columns",
  "export-dir",
  "audit-log",
  "config",
  "format",
  "name",
  "token",
  "sql",
]);
const BOOL_FLAGS = new Set([
  "write",
  "admin",
  "read-only",
  "no-redact",
  "mask-emails",
  "dry-run",
  "http",
  "stdio",
  "force",
  "help",
  "version",
]);

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
  /** Raw database/option arguments to forward to the server (for init). */
  forward: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  const forward: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h") {
      flags.help = true;
      continue;
    }
    if (a === "-v") {
      flags.version = true;
      continue;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (VALUE_FLAGS.has(name)) {
        const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
        if (value === undefined) throw new Error(`--${name} needs a value.`);
        flags[name] = value;
        if (!["port", "host", "format", "name", "token"].includes(name)) forward.push(`--${name}`, value);
      } else if (BOOL_FLAGS.has(name)) {
        flags[name] = true;
        if (["write", "admin", "read-only", "no-redact", "mask-emails"].includes(name)) forward.push(`--${name}`);
      } else throw new Error(`Unknown option --${name}. Run ${NAME} --help.`);
      continue;
    }
    positional.push(a);
  }
  return { positional, flags, forward };
}

const csv = (v: string | true | undefined) =>
  typeof v === "string"
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
const numFlag = (v: string | true | undefined, name: string) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number.`);
  return n;
};

export function overridesFrom(p: ParsedArgs, specs: string[]): CliOverrides {
  const f = p.flags;
  const mode: Mode | undefined = f.admin ? "admin" : f.write ? "write" : f["read-only"] ? "read" : undefined;
  const audit = f["audit-log"];
  return {
    specs,
    mode,
    configFile: typeof f.config === "string" ? f.config : undefined,
    limits: {
      maxRows: numFlag(f["max-rows"], "max-rows"),
      timeoutMs: numFlag(f.timeout, "timeout"),
      maxAffectedRows: numFlag(f["max-affected"], "max-affected"),
    },
    policy: {
      allowTables: csv(f["allow-tables"]),
      denyTables: csv(f["deny-tables"]),
      denyColumns: csv(f["deny-columns"]),
      redactColumns: csv(f["redact-columns"]),
      redact: f["no-redact"] ? "off" : undefined,
      maskEmails: f["mask-emails"] ? true : undefined,
    },
    exportDir: typeof f["export-dir"] === "string" ? f["export-dir"] : undefined,
    auditLog: audit === "off" ? false : typeof audit === "string" ? audit : undefined,
  };
}
