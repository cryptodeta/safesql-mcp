// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these tests check environment interpolation
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { detectEngine, interpolate, isLikelyDatabaseSpec, parseSpec, redactUrl, resolveConfig, sqlitePath } from "../src/config.js";
import { tempDir } from "./helpers.js";

describe("database specs", () => {
  it("parses name=url and plain urls", () => {
    expect(parseSpec("shop=./shop.db")).toEqual({ name: "shop", url: "./shop.db" });
    expect(parseSpec("postgres://u:p@h/db")).toEqual({ url: "postgres://u:p@h/db" });
    expect(parseSpec("./a=b.db")).toEqual({ url: "./a=b.db" });
  });

  it("detects engines", () => {
    expect(detectEngine("postgres://h/db")).toBe("postgres");
    expect(detectEngine("postgresql://h/db")).toBe("postgres");
    expect(detectEngine("./x.sqlite")).toBe("sqlite");
    expect(detectEngine("sqlite:./x.db")).toBe("sqlite");
    expect(() => detectEngine("mysql://h/db")).toThrow(/not supported/);
    expect(() => detectEngine("mongodb://h/db")).toThrow(/Unsupported/);
  });

  it("resolves SQLite paths", () => {
    expect(sqlitePath("sqlite:data/x.db", "/w", "/home/u")).toBe(resolve("/w", "data/x.db"));
    expect(sqlitePath("file:///abs/x.db", "/w", "/home/u")).toBe("/abs/x.db");
    expect(sqlitePath("~/x.db", "/w", "/home/u")).toBe(join("/home/u", "x.db"));
  });

  it("recognises database arguments", () => {
    expect(isLikelyDatabaseSpec("x.db")).toBe(true);
    expect(isLikelyDatabaseSpec("a=postgres://h/d")).toBe(true);
    expect(isLikelyDatabaseSpec("hello")).toBe(false);
  });

  it("redacts passwords from URLs", () => {
    expect(redactUrl("postgres://bob:s3cr%40t@db.example.com:5432/app?sslmode=require")).toBe(
      "postgres://bob:***@db.example.com:5432/app?sslmode=require",
    );
    expect(redactUrl("postgres://db/app?password=hunter2&x=1")).toBe("postgres://db/app?password=***&x=1");
  });

  it("interpolates environment variables", () => {
    expect(interpolate("postgres://${U}@h/${DB:-app}", { U: "bob" })).toBe("postgres://bob@h/app");
    expect(() => interpolate("${MISSING}", {})).toThrow(/MISSING/);
  });
});

describe("resolveConfig", () => {
  it("names databases and de-duplicates", () => {
    const c = resolveConfig({
      specs: ["/data/shop.db", "/other/shop.db", "postgres://u:pw123@h/analytics"],
      env: {},
      home: "/h",
      cwd: "/w",
    });
    expect(c.databases.map((d) => d.name)).toEqual(["shop", "shop_2", "analytics"]);
    expect(c.databases[2]!.display).toBe("postgres://u:***@h/analytics");
    expect(c.secrets).toContain("pw123");
    expect(c.databases.every((d) => d.mode === "read")).toBe(true);
  });

  it("reads DATABASE_URL and SAFESQL_DB_* from the environment", () => {
    expect(resolveConfig({ env: { DATABASE_URL: "postgres://h/main" }, home: "/h" }).databases.map((d) => d.name)).toEqual(["main"]);
    const c = resolveConfig({ env: { SAFESQL_DB_REPORTS: "/x/r.db", DATABASE_URL: "postgres://h/ignored" }, home: "/h" });
    expect(c.databases.map((d) => d.name)).toEqual(["reports"]);
  });

  it("applies mode and limits from flags and env, clamped to safe ranges", () => {
    const c = resolveConfig({
      specs: ["/a.db"],
      env: { SAFESQL_MAX_ROWS: "50", SAFESQL_MODE: "write" },
      limits: { timeoutMs: 5 },
      home: "/h",
    });
    expect(c.databases[0]!.mode).toBe("write");
    expect(c.databases[0]!.limits.maxRows).toBe(50);
    expect(c.databases[0]!.limits.timeoutMs).toBe(100);
    expect(() => resolveConfig({ specs: ["/a.db"], env: { SAFESQL_MAX_ROWS: "lots" }, home: "/h" })).toThrow(/positive/);
    expect(() => resolveConfig({ specs: ["/a.db"], env: { SAFESQL_MODE: "god" }, home: "/h" })).toThrow(/read, write or admin/);
  });

  it("loads a config file with per-database settings and saved queries", () => {
    const dir = tempDir();
    const file = join(dir, "safesql.config.json");
    writeFileSync(
      file,
      JSON.stringify({
        defaults: { maxRows: 20, denyColumns: ["*.ssn"] },
        databases: {
          prod: { url: "postgres://reader:${PGPASS}@db/prod", maxRows: 10, denyTables: ["secrets"] },
          local: { url: "./dev.db", mode: "admin" },
          short: "./short.db",
        },
        queries: { top: { sql: "SELECT 1", db: "local" } },
        auditLog: false,
      }),
    );
    const c = resolveConfig({ env: { PGPASS: "pa55word" }, cwd: dir, home: dir, policy: { denyTables: ["tmp_*"] } });
    expect(c.configFile).toBe(file);
    const [prod, local, short] = c.databases;
    expect(prod!.limits.maxRows).toBe(10);
    expect(prod!.policy.denyTables).toEqual(["tmp_*", "secrets"]);
    expect(prod!.policy.denyColumns).toEqual(["*.ssn"]);
    expect(prod!.display).toBe("postgres://reader:***@db/prod");
    expect(c.secrets).toContain("pa55word");
    expect(local!.mode).toBe("admin");
    expect(local!.target).toBe(join(dir, "dev.db"));
    expect(short!.limits.maxRows).toBe(20);
    expect(c.queries.top!.sql).toBe("SELECT 1");
    expect(c.auditLog).toBeUndefined();
  });

  it("reports broken config files clearly", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "x"));
    writeFileSync(join(dir, "bad.json"), "{ nope");
    expect(() => resolveConfig({ configFile: "bad.json", cwd: dir, env: {}, home: dir })).toThrow(/not valid JSON/);
    expect(() => resolveConfig({ configFile: "missing.json", cwd: dir, env: {}, home: dir })).toThrow(/Cannot read/);
    writeFileSync(join(dir, "nourl.json"), JSON.stringify({ databases: { a: {} } }));
    expect(() => resolveConfig({ configFile: "nourl.json", cwd: dir, env: {}, home: dir })).toThrow(/needs a "url"/);
  });

  it("defaults the audit log and export dir under home", () => {
    const c = resolveConfig({ specs: [], env: {}, home: "/h", cwd: "/w" });
    expect(c.auditLog).toBe(join("/h", ".safesql-mcp", "audit.jsonl"));
    expect(c.exportDir).toBe(resolve("/w", join("/h", "safesql-exports")));
    expect(resolveConfig({ env: { SAFESQL_AUDIT_LOG: "off" }, home: "/h" }).auditLog).toBeUndefined();
  });
});
