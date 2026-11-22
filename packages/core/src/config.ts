import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { SafeSqlError } from "./errors.js";
import type { PolicyConfig } from "./policy.js";
import type { Engine, Mode } from "./types.js";

export interface Limits {
  /** Rows returned per query page (default 100, hard max 10,000). */
  maxRows: number;
  /** Approximate bytes of row data per response (default 60,000). */
  maxBytes: number;
  /** Statement timeout in ms (default 15,000). */
  timeoutMs: number;
  /** Writes that change more rows than this are rolled back (default 1,000). */
  maxAffectedRows: number;
  /** Long cell values are cut to this many characters (default 300). */
  maxCellChars: number;
  /** Max rows written by export_query (default 100,000). */
  exportMaxRows: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxRows: 100,
  maxBytes: 60_000,
  timeoutMs: 15_000,
  maxAffectedRows: 1000,
  maxCellChars: 300,
  exportMaxRows: 100_000,
};

export interface DatabaseConfig extends PolicyConfig, Partial<Limits> {
  /** postgres://... URL, SQLite file path, sqlite:path or file:path. */
  url: string;
  mode?: Mode;
  description?: string;
}

export interface SavedQuery {
  db?: string;
  sql: string;
  description?: string;
}

export interface FileConfig {
  databases?: Record<string, DatabaseConfig | string>;
  defaults?: Partial<Limits> & PolicyConfig & { mode?: Mode };
  exportDir?: string;
  auditLog?: string | false;
  stateDir?: string;
  queries?: Record<string, SavedQuery>;
}

export interface ResolvedDatabase extends DatabaseConfig {
  name: string;
  engine: Engine;
  mode: Mode;
  /** Filesystem path (SQLite) or connection URL (PostgreSQL). Never shown to the model. */
  target: string;
  /** Safe-to-show location with credentials removed. */
  display: string;
  limits: Limits;
  policy: PolicyConfig;
}

export interface ResolvedConfig {
  databases: ResolvedDatabase[];
  exportDir: string;
  auditLog?: string;
  stateDir: string;
  queries: Record<string, SavedQuery>;
  /** Strings that must never appear in output (passwords). */
  secrets: string[];
  configFile?: string;
}

export interface CliOverrides {
  specs?: string[];
  mode?: Mode;
  configFile?: string;
  limits?: Partial<Limits>;
  policy?: PolicyConfig;
  exportDir?: string;
  auditLog?: string | false;
  stateDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

const SQLITE_EXT = new Set([".db", ".sqlite", ".sqlite3", ".db3", ".s3db", ".sl3"]);

/** Interpolate ${VAR} and ${VAR:-default} from the environment. */
export function interpolate(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, def?: string) => {
    const v = env[name];
    if (v !== undefined && v !== "") return v;
    if (def !== undefined) return def;
    throw new SafeSqlError("CONFIG", `Environment variable ${name} is not set.`, `Set ${name} or use \${${name}:-default}.`);
  });
}

export function detectEngine(url: string): Engine {
  const lower = url.toLowerCase();
  if (lower.startsWith("postgres://") || lower.startsWith("postgresql://")) return "postgres";
  if (lower.startsWith("mysql://") || lower.startsWith("mariadb://"))
    throw new SafeSqlError("CONFIG", "MySQL/MariaDB is not supported yet.", "Supported: SQLite files and postgres:// URLs.");
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(lower) && !lower.startsWith("file:") && !lower.startsWith("sqlite:"))
    throw new SafeSqlError(
      "CONFIG",
      `Unsupported database URL scheme in "${redactUrl(url)}".`,
      "Use a SQLite file path or a postgres:// URL.",
    );
  return "sqlite";
}

/** Strip sqlite:/file: prefixes and resolve relative to cwd. */
export function sqlitePath(url: string, cwd: string, home: string): string {
  let p = url.replace(/^sqlite:(\/\/)?/i, "").replace(/^file:(\/\/)?/i, "");
  p = p.split("?")[0]!;
  if (p.startsWith("~/") || p === "~") p = join(home, p.slice(1));
  return isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) ? p : resolve(cwd, p);
}

/** postgres://user:pass@host/db -> postgres://user:***@host/db */
export function redactUrl(url: string): string {
  return url
    .replace(/^([a-z][a-z0-9+.-]*:\/\/[^:/@]*):([^@]*)@/i, "$1:***@")
    .replace(/([?&](password|sslpassword|sslkey)=)[^&]*/gi, "$1***");
}

function urlSecrets(url: string): string[] {
  const out: string[] = [];
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^:/@]*:([^@]*)@/i.exec(url);
  if (m?.[1]) {
    out.push(m[1]);
    try {
      out.push(decodeURIComponent(m[1]));
    } catch {
      // keep raw
    }
  }
  for (const q of url.matchAll(/[?&](?:password|sslpassword)=([^&]*)/gi)) if (q[1]) out.push(q[1]);
  return out.filter((s) => s.length >= 3);
}

function defaultName(engine: Engine, url: string, target: string): string {
  if (engine === "sqlite") return basename(target, extname(target)) || "db";
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname.replace(/^\//, "")) || u.hostname || "postgres";
  } catch {
    return "postgres";
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "db";
}

/** Parse "name=url" or "url". */
export function parseSpec(spec: string): { name?: string; url: string } {
  const m = /^([A-Za-z][A-Za-z0-9_-]{0,63})=(.+)$/.exec(spec);
  if (m && !m[2]!.startsWith("=")) return { name: m[1], url: m[2]! };
  return { url: spec };
}

export function isLikelyDatabaseSpec(arg: string): boolean {
  if (/^[A-Za-z][A-Za-z0-9_-]*=/.test(arg)) return true;
  if (/^(postgres|postgresql|sqlite|file|mysql|mariadb):/i.test(arg)) return true;
  return SQLITE_EXT.has(extname(arg.split("?")[0]!).toLowerCase()) || existsSync(arg);
}

function num(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const v = env[key];
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new SafeSqlError("CONFIG", `${key} must be a positive number, got "${v}".`);
  return n;
}

function clampLimits(l: Limits): Limits {
  return {
    maxRows: Math.min(Math.max(1, Math.floor(l.maxRows)), 10_000),
    maxBytes: Math.min(Math.max(1000, Math.floor(l.maxBytes)), 5_000_000),
    timeoutMs: Math.min(Math.max(100, Math.floor(l.timeoutMs)), 600_000),
    maxAffectedRows: Math.max(1, Math.floor(l.maxAffectedRows)),
    maxCellChars: Math.min(Math.max(20, Math.floor(l.maxCellChars)), 100_000),
    exportMaxRows: Math.min(Math.max(1, Math.floor(l.exportMaxRows)), 5_000_000),
  };
}

const MODES: Mode[] = ["read", "write", "admin"];

function checkMode(m: unknown, where: string): Mode | undefined {
  if (m === undefined) return undefined;
  if (!MODES.includes(m as Mode)) throw new SafeSqlError("CONFIG", `${where}: mode must be read, write or admin (got "${String(m)}").`);
  return m as Mode;
}

export function loadConfigFile(path: string): FileConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new SafeSqlError("CONFIG", `Cannot read config file ${path}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text) as FileConfig;
  } catch (err) {
    throw new SafeSqlError("CONFIG", `Config file ${path} is not valid JSON: ${(err as Error).message}`);
  }
}

/** Merge config file, CLI arguments and environment variables into a list of databases. */
export function resolveConfig(o: CliOverrides = {}): ResolvedConfig {
  const env = o.env ?? process.env;
  const cwd = o.cwd ?? process.cwd();
  const home = o.home ?? homedir();
  let configFile = o.configFile ?? env.SAFESQL_CONFIG;
  if (!configFile && existsSync(join(cwd, "safesql.config.json"))) configFile = join(cwd, "safesql.config.json");
  const file: FileConfig = configFile ? loadConfigFile(resolve(cwd, configFile)) : {};

  const envMode = checkMode(env.SAFESQL_MODE || undefined, "SAFESQL_MODE");
  const baseLimits: Limits = clampLimits({
    ...DEFAULT_LIMITS,
    ...file.defaults,
    ...stripUndefined({
      maxRows: num(env, "SAFESQL_MAX_ROWS"),
      timeoutMs: num(env, "SAFESQL_TIMEOUT_MS"),
      maxBytes: num(env, "SAFESQL_MAX_BYTES"),
      maxAffectedRows: num(env, "SAFESQL_MAX_AFFECTED_ROWS"),
    }),
    ...stripUndefined(o.limits ?? {}),
  });
  const basePolicy: PolicyConfig = {
    redact: file.defaults?.redact,
    maskEmails: file.defaults?.maskEmails ?? (env.SAFESQL_MASK_EMAILS === "1" || env.SAFESQL_MASK_EMAILS === "true" ? true : undefined),
    denyTables: file.defaults?.denyTables,
    denyColumns: file.defaults?.denyColumns,
    redactColumns: file.defaults?.redactColumns,
    allowTables: file.defaults?.allowTables,
  };
  const cliPolicy = o.policy ?? {};
  const baseMode: Mode = o.mode ?? envMode ?? checkMode(file.defaults?.mode, "defaults") ?? "read";

  const entries: { name?: string; cfg: DatabaseConfig; fromCli: boolean }[] = [];
  for (const [name, v] of Object.entries(file.databases ?? {})) {
    const cfg = typeof v === "string" ? { url: v } : v;
    if (!cfg || typeof cfg.url !== "string") throw new SafeSqlError("CONFIG", `Database "${name}" in the config file needs a "url".`);
    entries.push({ name, cfg: { ...cfg, url: interpolate(cfg.url, env) }, fromCli: false });
  }
  for (const spec of o.specs ?? []) {
    const p = parseSpec(spec);
    entries.push({ name: p.name, cfg: { url: interpolate(p.url, env) }, fromCli: true });
  }
  // Environment: SAFESQL_DB_<NAME>=url, then DATABASE_URL when nothing else is configured.
  for (const [k, v] of Object.entries(env)) {
    const m = /^SAFESQL_DB_([A-Za-z0-9_]+)$/.exec(k);
    if (m && v) entries.push({ name: m[1]!.toLowerCase(), cfg: { url: v }, fromCli: false });
  }
  if (!entries.length && env.DATABASE_URL) entries.push({ cfg: { url: env.DATABASE_URL }, fromCli: false });

  const used = new Set<string>();
  const secrets = new Set<string>();
  const databases: ResolvedDatabase[] = entries.map(({ name, cfg }) => {
    const engine = detectEngine(cfg.url);
    const target = engine === "sqlite" ? sqlitePath(cfg.url, cwd, home) : cfg.url;
    for (const s of urlSecrets(cfg.url)) secrets.add(s);
    let finalName = sanitizeName(name ?? defaultName(engine, cfg.url, target));
    if (used.has(finalName)) {
      let i = 2;
      while (used.has(`${finalName}_${i}`)) i++;
      finalName = `${finalName}_${i}`;
    }
    used.add(finalName);
    const mode = checkMode(cfg.mode, `database "${finalName}"`) ?? baseMode;
    const limits = clampLimits({ ...baseLimits, ...stripUndefined(pickLimits(cfg)) });
    const policy: PolicyConfig = {
      redact: cfg.redact ?? cliPolicy.redact ?? basePolicy.redact,
      maskEmails: cfg.maskEmails ?? cliPolicy.maskEmails ?? basePolicy.maskEmails,
      allowTables: [...(basePolicy.allowTables ?? []), ...(cliPolicy.allowTables ?? []), ...(cfg.allowTables ?? [])],
      denyTables: [...(basePolicy.denyTables ?? []), ...(cliPolicy.denyTables ?? []), ...(cfg.denyTables ?? [])],
      denyColumns: [...(basePolicy.denyColumns ?? []), ...(cliPolicy.denyColumns ?? []), ...(cfg.denyColumns ?? [])],
      redactColumns: [...(basePolicy.redactColumns ?? []), ...(cliPolicy.redactColumns ?? []), ...(cfg.redactColumns ?? [])],
    };
    return {
      ...cfg,
      name: finalName,
      engine,
      mode,
      target,
      display: engine === "sqlite" ? target : redactUrl(cfg.url),
      limits,
      policy,
    };
  });

  const stateDir = o.stateDir ?? env.SAFESQL_STATE_DIR ?? file.stateDir ?? join(home, ".safesql-mcp");
  const auditRaw = o.auditLog ?? (env.SAFESQL_AUDIT_LOG !== undefined ? env.SAFESQL_AUDIT_LOG : file.auditLog);
  const auditLog =
    auditRaw === false || auditRaw === "off" || auditRaw === "false" || auditRaw === "0"
      ? undefined
      : typeof auditRaw === "string" && auditRaw
        ? resolve(cwd, auditRaw)
        : join(stateDir, "audit.jsonl");
  return {
    databases,
    exportDir: resolve(cwd, o.exportDir ?? env.SAFESQL_EXPORT_DIR ?? file.exportDir ?? join(home, "safesql-exports")),
    auditLog,
    stateDir,
    queries: file.queries ?? {},
    secrets: [...secrets],
    configFile: configFile ? resolve(cwd, configFile) : undefined,
  };
}

function pickLimits(c: Partial<Limits>): Partial<Limits> {
  return {
    maxRows: c.maxRows,
    maxBytes: c.maxBytes,
    timeoutMs: c.timeoutMs,
    maxAffectedRows: c.maxAffectedRows,
    maxCellChars: c.maxCellChars,
    exportMaxRows: c.exportMaxRows,
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
