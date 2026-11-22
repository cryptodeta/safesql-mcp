import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import type { SafeSql } from "../../core/src/index.js";
import { sqliteEngine } from "../../core/test/helpers.js";
import { createServer } from "../src/server.js";
import { READ_TOOLS, TOOL_NAMES } from "../src/tools.js";

let client: Client | undefined;
let engine: SafeSql | undefined;

async function connect(o: Parameters<typeof sqliteEngine>[0] = {}) {
  ({ engine } = sqliteEngine(o));
  const server = createServer(engine);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(b);
  return client;
}

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "") as string;
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await c.callTool({ name, arguments: args });
  return { text: text(r), isError: !!r.isError };
};

afterEach(async () => {
  await client?.close();
  await engine?.close();
  client = undefined;
  engine = undefined;
});

describe("MCP server (read mode)", () => {
  it("lists only read tools, all annotated read-only except file writers", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
    for (const t of tools) {
      expect(t.description!.length, t.name).toBeGreaterThan(50);
      expect(t.annotations?.destructiveHint, t.name).toBe(false);
    }
    expect(tools.filter((t) => t.annotations?.readOnlyHint).length).toBe(READ_TOOLS.length - 2);
  });

  it("sends instructions that mention read-only mode", async () => {
    const c = await connect();
    expect(c.getInstructions()).toMatch(/All databases are read-only/);
  });

  it("answers the core tools", async () => {
    const c = await connect();
    expect((await call(c, "list_databases")).text).toMatch(/shop: sqlite, READ mode, SQLite 3\./);
    expect((await call(c, "list_tables")).text).toMatch(/orders ~1000/);
    expect((await call(c, "describe_table", { table: "orders, products" })).text).toMatch(/table orders[\s\S]*table products/);
    expect((await call(c, "schema_overview")).text).toMatch(/customers ~200: id\* int/);
    expect((await call(c, "search_schema", { term: "email" })).text).toMatch(/column customers.email/);
    expect((await call(c, "sample_rows", { table: "products", rows: 2 })).text).toMatch(/^2 rows/);
    const q = await call(c, "query", {
      sql: "SELECT status, count(*) AS n FROM orders GROUP BY status ORDER BY n DESC",
      format: "markdown",
    });
    expect(q.text).toMatch(/\| status \| n \|\n\|---\|---\|\n\| delivered \| 427 \|/);
    expect((await call(c, "query", { sql: "SELECT id FROM orders WHERE customer_id = ?", params: [1], max_rows: 3 })).text).toMatch(
      /offset=3/,
    );
    expect((await call(c, "explain", { sql: "SELECT * FROM order_items WHERE product_id = 1" })).text).toMatch(/Hints:\n- Full scan/);
    expect((await call(c, "profile_table", { table: "products" })).text).toMatch(/category \| text/);
    expect((await call(c, "relationships", { table: "orders" })).text).toMatch(/^erDiagram/);
    expect((await call(c, "export_query", { sql: "SELECT * FROM products", file: "p.csv" })).text).toMatch(/Exported 28 rows/);
    expect((await call(c, "saved_queries", { action: "save", name: "statuses", sql: "SELECT DISTINCT status FROM orders" })).text).toMatch(
      /Saved/,
    );
    expect((await call(c, "saved_queries")).text).toMatch(/statuses/);
    expect((await call(c, "query", { saved: "statuses" })).text).toMatch(/^5 rows/);
    expect((await call(c, "audit_log", { limit: 3 })).text).toMatch(/shop query ok/);
  });

  it("returns actionable errors", async () => {
    const c = await connect();
    const w = await call(c, "query", { sql: "DELETE FROM orders" });
    expect(w.isError).toBe(true);
    expect(w.text).toMatch(/^Error \[READ_ONLY\]/);
    expect(w.text).toMatch(/Hint: .*--write/);
    const t = await call(c, "describe_table", { table: "custmers" });
    expect(t.text).toMatch(/Did you mean "customers"/);
    const d = await call(c, "query", { db: "nope", sql: "SELECT 1" });
    expect(d.text).toMatch(/UNKNOWN_DATABASE/);
    const x = await call(c, "execute", { sql: "DELETE FROM orders WHERE id = 1" });
    expect(x.isError).toBe(true);
  });

  it("serves resources and prompts", async () => {
    const c = await connect();
    const { resources } = await c.listResources();
    expect(resources.map((r) => r.uri)).toEqual(expect.arrayContaining(["safesql://databases", "safesql://shop/schema"]));
    const schema = await c.readResource({ uri: "safesql://shop/schema" });
    expect((schema.contents[0] as { text: string }).text).toMatch(/orders ~1000/);
    const table = await c.readResource({ uri: "safesql://shop/table/orders" });
    expect((table.contents[0] as { text: string }).text).toMatch(/customer_id int NOT NULL/);
    const { prompts } = await c.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["data_quality_check", "explore_database", "optimize_query", "safe_change"]);
    const p = await c.getPrompt({ name: "optimize_query", arguments: { sql: "SELECT 1" } });
    expect((p.messages[0]!.content as { text: string }).text).toMatch(/explain/);
  });
});

describe("MCP server (write mode)", () => {
  it("adds the execute tool and runs the two-step flow", async () => {
    const c = await connect({ mode: "write" });
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(tools.find((t) => t.name === "execute")!.annotations?.destructiveHint).toBe(true);
    const dry = await call(c, "execute", { sql: "UPDATE products SET price = price * 1.1 WHERE category = 'Books'" });
    expect(dry.text).toMatch(/DRY RUN .* would affect 5 rows/);
    const token = /confirm="([^"]+)"/.exec(dry.text)![1];
    const done = await call(c, "execute", { sql: "UPDATE products SET price = price * 1.1 WHERE category = 'Books'", confirm: token });
    expect(done.text).toMatch(/COMMITTED: UPDATE changed 5 rows/);
    expect((await call(c, "audit_log", { only_writes: true })).text).toMatch(/committed affected=5/);
    expect(c.getInstructions()).toMatch(/dry run first/);
  });
});
