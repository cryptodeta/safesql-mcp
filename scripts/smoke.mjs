#!/usr/bin/env node
// End-to-end smoke test of the built CLI: stdio and Streamable HTTP, against the example SQLite database.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const cli = fileURLToPath(new URL("../packages/server/dist/cli.js", import.meta.url));
const db = fileURLToPath(new URL("../examples/shop.db", import.meta.url));

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

if (!existsSync(db)) spawnSync(process.execPath, [cli, "demo", db], { stdio: "inherit" });
const fail = (msg) => {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
};
const text = (r) => r.content?.[0]?.text ?? "";

async function check(client, label) {
  const { tools } = await client.listTools();
  if (tools.length < 13) fail(`${label}: expected at least 13 tools, got ${tools.length}`);
  const r = await client.callTool({
    name: "query",
    arguments: { sql: "SELECT status, count(*) AS n FROM orders GROUP BY status ORDER BY n DESC LIMIT 2" },
  });
  if (!text(r).includes("delivered | 427")) fail(`${label}: unexpected query result:\n${text(r)}`);
  const w = await client.callTool({ name: "query", arguments: { sql: "DELETE FROM orders" } });
  if (!w.isError) fail(`${label}: DELETE was not refused`);
  console.log(`${label}: ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);
}

// stdio
{
  const client = new Client({ name: "smoke", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, db, "--audit-log", "off"], stderr: "pipe" }));
  await check(client, "stdio");
  await client.close();
}

// Streamable HTTP
{
  const port = 3900 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, [cli, "--http", db, "--port", String(port), "--audit-log", "off"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let ready = false;
  child.stderr.on("data", (d) => {
    if (String(d).includes("listening")) ready = true;
  });
  for (let i = 0; i < 50 && !ready; i++) await new Promise((r) => setTimeout(r, 100));
  if (!ready) fail("HTTP server did not start");
  try {
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    if (health.status !== "ok") fail("health check failed");
    const client = new Client({ name: "smoke", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    await check(client, "http");
    await client.close();
  } finally {
    child.kill();
  }
}
console.log("smoke OK");
