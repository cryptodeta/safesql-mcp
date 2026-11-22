import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { sqliteEngine, tempDir } from "../../core/test/helpers.js";
import { overridesFrom, parseArgs } from "../src/cli-args.js";
import { formatChecks, runDoctor } from "../src/doctor.js";
import { startHttpServer } from "../src/http.js";
import { configPath, installClient, installedClients } from "../src/init.js";

describe("Streamable HTTP", () => {
  it("serves MCP on /mcp with health, CORS and bearer auth", async () => {
    const { engine } = sqliteEngine();
    const http = await startHttpServer(engine, { port: 0, token: "t0ken" });
    const { port } = http.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    try {
      const health = await (await fetch(`${base}/health`)).json();
      expect(health).toMatchObject({ status: "ok", name: "safesql-mcp", databases: 1 });
      expect((await fetch(`${base}/mcp`, { method: "POST", body: "{}" })).status).toBe(401);
      expect((await fetch(`${base}/nope`)).status).toBe(404);
      const client = new Client({ name: "t", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: "Bearer t0ken" } } }),
      );
      const { tools } = await client.listTools();
      expect(tools.length).toBe(13);
      const r = await client.callTool({ name: "query", arguments: { sql: "SELECT count(*) AS n FROM customers" } });
      expect((r.content as { text: string }[])[0]!.text).toMatch(/n\n200/);
      await client.close();
    } finally {
      http.close();
      await engine.close();
    }
  });
});

describe("init", () => {
  it("merges into existing configs and keeps a backup", () => {
    const home = tempDir();
    const path = configPath("cursor", { home })!;
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    const r = installClient("cursor", { home, args: ["/data/shop.db"], platform: "linux" });
    expect(r.action).toBe("written");
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    expect(cfg.mcpServers.other).toEqual({ command: "x" });
    expect(cfg.mcpServers.safesql.args).toEqual(["-y", "safesql-mcp", "/data/shop.db"]);
    expect(existsSync(`${path}.bak`)).toBe(true);
    expect(installClient("cursor", { home, args: ["/data/shop.db"], platform: "linux" }).action).toBe("unchanged");
    expect(installedClients({ home }).map((c) => c.client)).toContain("cursor");
  });

  it("supports every client and Windows", () => {
    const home = tempDir();
    const cwd = tempDir();
    expect(installClient("vscode", { home, cwd, args: ["a.db"], dryRun: true, platform: "darwin" }).config).toEqual({
      servers: { safesql: { type: "stdio", command: "npx", args: ["-y", "safesql-mcp", "a.db"] } },
    });
    expect(installClient("claude-code", { args: ["postgres://u@h/db", "--write"], platform: "linux" }).command).toBe(
      "claude mcp add safesql -- npx -y safesql-mcp postgres://u@h/db --write",
    );
    const win = installClient("claude", { home, platform: "win32", env: { APPDATA: join(home, "AppData") }, dryRun: true });
    expect(win.path).toBe(join(home, "AppData", "Claude", "claude_desktop_config.json"));
    expect((win.config as { mcpServers: { safesql: { command: string } } }).mcpServers.safesql.command).toBe("cmd");
    expect(configPath("claude", { home, platform: "darwin" })).toContain("Library");
    expect(configPath("windsurf", { home })).toContain(".codeium");
    writeFileSync(join(cwd, "broken.json"), "{");
    mkdirSync(join(cwd, ".vscode"));
    writeFileSync(join(cwd, ".vscode", "mcp.json"), "{ nope");
    expect(() => installClient("vscode", { cwd })).toThrow(/not valid JSON/);
  });
});

describe("CLI arguments", () => {
  it("parses databases, flags and forwards server options", () => {
    const p = parseArgs([
      "init",
      "cursor",
      "./a.db",
      "--write",
      "--max-rows",
      "50",
      "--deny-columns=users.password",
      "--dry-run",
      "--name",
      "db1",
    ]);
    expect(p.positional).toEqual(["init", "cursor", "./a.db"]);
    expect(p.forward).toEqual(["--write", "--max-rows", "50", "--deny-columns", "users.password"]);
    const o = overridesFrom(p, ["./a.db"]);
    expect(o.mode).toBe("write");
    expect(o.limits?.maxRows).toBe(50);
    expect(o.policy?.denyColumns).toEqual(["users.password"]);
    expect(overridesFrom(parseArgs(["--admin", "--audit-log", "off", "--no-redact"]), []).auditLog).toBe(false);
    expect(overridesFrom(parseArgs(["--admin"]), []).mode).toBe("admin");
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown option/);
    expect(() => parseArgs(["--port"])).toThrow(/needs a value/);
    expect(() => overridesFrom(parseArgs(["--max-rows", "x"]), [])).toThrow(/positive/);
  });
});

describe("doctor", () => {
  it("checks connection and engine-level read-only enforcement", async () => {
    const { engine, dir } = sqliteEngine();
    const checks = await runDoctor(engine, { home: dir });
    const out = formatChecks(checks);
    expect(out).toMatch(/✓ \[shop\] connected: SQLite/);
    expect(out).toMatch(/✓ \[shop\] read path refuses writes \(engine-enforced\)/);
    expect(out).toMatch(/! not added to any MCP client yet/);
    expect(checks.some((c) => c.ok === false)).toBe(false);
    await engine.close();
  });

  it("reports missing files", async () => {
    const { engine } = sqliteEngine();
    const dir = tempDir();
    const { SafeSql, resolveConfig } = await import("../../core/src/index.js");
    const bad = new SafeSql(resolveConfig({ specs: [join(dir, "missing.db")], env: {}, home: dir }));
    const checks = await runDoctor(bad, { home: dir });
    expect(formatChecks(checks)).toMatch(/✗ \[missing\] SQLite file not found/);
    await bad.close();
    await engine.close();
  });
});
