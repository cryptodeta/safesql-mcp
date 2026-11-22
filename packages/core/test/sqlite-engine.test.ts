import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteDriver } from "../src/drivers/sqlite.js";
import type { SafeSqlError } from "../src/errors.js";
import type { SafeSql } from "../src/index.js";
import { sqliteEngine } from "./helpers.js";

async function err(p: Promise<unknown>): Promise<SafeSqlError> {
  try {
    await p;
  } catch (e) {
    return e as SafeSqlError;
  }
  throw new Error("expected a rejection");
}

describe("SQLite engine (read mode)", () => {
  let s: SafeSql;
  let dir: string;
  let path: string;
  beforeAll(() => {
    ({ engine: s, dir, path } = sqliteEngine());
  });
  afterAll(() => s.close());

  it("lists tables with counts", async () => {
    const out = await s.listTables();
    expect(out).toMatch(/orders ~1000 \[5\]/);
    expect(out).toMatch(/customer_revenue \(view\)/);
    expect(await s.listTables(undefined, { pattern: "order*" })).not.toMatch(/customers/);
  });

  it("describes a table compactly", async () => {
    const out = await s.describeTable(undefined, "orders");
    expect(out).toContain("customer_id int NOT NULL → customers.id");
    expect(out).toContain("idx_orders_customer (customer_id)");
    expect(out).toContain("referenced by: order_items.order_id");
    expect(await s.describeTable(undefined, "customers")).toMatch(/password_hash text NOT NULL \[redacted\]/);
  });

  it("suggests table names", async () => {
    const e = await err(s.describeTable(undefined, "ordrs"));
    expect(e.code).toBe("UNKNOWN_TABLE");
    expect(e.hint).toContain('"orders"');
    const e2 = await err(s.query(undefined, "SELECT * FROM customer"));
    expect(e2.hint).toContain('"customers"');
    const e3 = await err(s.query(undefined, "SELECT nmae FROM customers"));
    expect(e3.hint).toContain('"name"');
    const e4 = await err(s.query(undefined, "SELECT * FROM order"));
    expect(e4.hint).toMatch(/"orders".*double-quoted/);
  });

  it("gives a token-efficient schema overview within budget", async () => {
    const out = await s.schemaOverview();
    expect(out).toContain("orders ~1000: id* int, customer_id int→customers, status text, created_at text, total real");
    expect(out.length).toBeLessThan(1200);
    const small = await s.schemaOverview(undefined, { maxChars: 500 });
    expect(small).toMatch(/omitted to save tokens/);
  });

  it("searches the schema", async () => {
    expect(await s.searchSchema(undefined, "price")).toMatch(/column products.price/);
    expect(await s.searchSchema(undefined, "pric")).toMatch(/unit_price/);
    expect(await s.searchSchema(undefined, "qqqq")).toMatch(/Nothing matches/);
  });

  it("runs read queries with bind params, paging and caps", async () => {
    const r = await s.query(undefined, "SELECT id, status FROM orders WHERE customer_id = ? ORDER BY id", { params: [1], maxRows: 10 });
    expect(r.columns).toEqual(["id", "status"]);
    expect(r.rowCount).toBe(10);
    expect(r.hasMore).toBe(true);
    const next = await s.query(undefined, "SELECT id, status FROM orders WHERE customer_id = ? ORDER BY id", {
      params: [1],
      maxRows: 10,
      offset: r.nextOffset,
    });
    expect(next.rows[0]![0]).not.toBe(r.rows[0]![0]);
    expect(s.formatQuery(r)).toMatch(/Continue with offset=10/);
  });

  it("keeps duplicate column names and big integers", async () => {
    const r = await s.query(undefined, "SELECT 1 AS a, 2 AS a, 9007199254740993 AS big");
    expect(r.columns).toEqual(["a", "a", "big"]);
    expect(r.rows[0]).toEqual([1, 2, "9007199254740993"]);
  });

  it("stops at the byte cap", async () => {
    const r = await s.query(undefined, "SELECT name, email, country, created_at FROM customers", { maxRows: 10_000 });
    expect(r.rowCount).toBe(200);
    const { engine: tiny } = sqliteEngine({ limits: { maxBytes: 1000 } });
    const t = await tiny.query(undefined, "SELECT name, email FROM customers");
    expect(t.byteCapped).toBe(true);
    expect(t.rowCount).toBeLessThan(40);
    await tiny.close();
  });

  it("redacts secret columns even when aliased", async () => {
    const r = await s.query(undefined, "SELECT name, password_hash AS p FROM customers LIMIT 2");
    expect(r.rows.every((row) => row[1] === "[redacted]")).toBe(true);
    expect(r.redacted).toEqual(["p"]);
    const k = await s.query(undefined, "SELECT token FROM api_keys LIMIT 1");
    expect(k.rows[0]![0]).toBe("[redacted]");
  });

  it("refuses writes in the guard and in the engine itself", async () => {
    for (const sql of ["DELETE FROM orders", "DROP TABLE orders", "UPDATE orders SET total = 0 WHERE id = 1"]) {
      const e = await err(s.query(undefined, sql));
      expect(e.code).toBe("READ_ONLY");
    }
    // bypass the guard entirely: the read connection is opened read-only with query_only
    const driver = new SqliteDriver({ path, writable: false });
    const e = await err(driver.read("DELETE FROM orders", { maxRows: 1, offset: 0, timeoutMs: 5000, maxBytes: 10_000 }));
    expect(e.code).toBe("READ_ONLY");
    expect(await driver.probeReadOnly()).toMatch(/readonly/);
    await driver.close();
    expect((await s.query(undefined, "SELECT count(*) FROM orders")).rows[0]![0]).toBe(1000);
  });

  it("blocks statement smuggling and dangerous functions", async () => {
    expect((await err(s.query(undefined, "SELECT 1; DELETE FROM orders"))).code).toBe("BLOCKED");
    expect((await err(s.query(undefined, "ATTACH DATABASE 'x.db' AS x"))).code).toBe("BLOCKED");
    expect((await err(s.query(undefined, "PRAGMA query_only = 0"))).code).toBe("BLOCKED");
    expect((await err(s.query(undefined, "SELECT load_extension('evil')"))).code).toBe("BLOCKED");
  });

  it("times out runaway queries and recovers", async () => {
    const started = Date.now();
    const e = await err(
      s.query(undefined, "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT count(*) FROM r", { timeoutMs: 300 }),
    );
    expect(e.code).toBe("TIMEOUT");
    expect(Date.now() - started).toBeLessThan(3000);
    expect((await s.query(undefined, "SELECT 42")).rows[0]![0]).toBe(42);
  });

  it("explains with hints", async () => {
    const p = await s.explain(undefined, "SELECT * FROM order_items WHERE product_id = 3 ORDER BY quantity");
    expect(p.text).toMatch(/SCAN order_items/);
    expect(p.hints.join(" ")).toMatch(/Full scan of order_items/);
    const a = await s.explain(undefined, "SELECT count(*) FROM orders WHERE customer_id = 5", { analyze: true });
    expect(a.text).toMatch(/USING (COVERING )?INDEX idx_orders_customer/);
    expect(a.text).toMatch(/executed: 1 rows/);
    expect((await err(s.explain(undefined, "DELETE FROM orders WHERE id = 1", { analyze: true }))).code).toBe("READ_ONLY");
  });

  it("samples rows", async () => {
    const r = await s.sample(undefined, "customers", { rows: 3, columns: ["name", "password_hash"] });
    expect(r.rowCount).toBe(3);
    expect(r.rows[0]![1]).toBe("[redacted]");
    expect((await s.sample(undefined, "orders", { rows: 2, random: true, where: "status = 'shipped'" })).rowCount).toBe(2);
    expect((await err(s.sample(undefined, "orders", { columns: ["nope"] }))).code).toBe("BAD_INPUT");
    expect((await err(s.sample(undefined, "orders", { where: "1=1; DROP TABLE orders" }))).code).toBe("BLOCKED");
  });

  it("profiles a table", async () => {
    const out = await s.profile(undefined, "orders");
    expect(out).toMatch(/profile of orders: 1000 rows/);
    expect(out).toMatch(/status \| text \| 0 \(0%\) \| 5 \|/);
    expect(out).toMatch(/delivered \(427\)/);
    const c = await s.profile(undefined, "customers", { columns: ["password_hash", "country"] });
    expect(c).toMatch(/password_hash .*\[redacted\]/);
    expect(c).not.toMatch(/\$2b\$/);
  });

  it("draws relationships", async () => {
    const m = await s.relationships();
    expect(m.split("\n")[0]).toBe("erDiagram");
    expect(m).toContain('customers ||--o{ orders : "customer_id"');
    const focused = await s.relationships(undefined, { table: "products", format: "list" });
    expect(focused).toBe("order_items.product_id → products.id");
  });

  it("exports inside the export dir only", async () => {
    const r = await s.exportQuery(undefined, "SELECT id, total FROM orders ORDER BY id", "orders.csv");
    expect(r.rows).toBe(1000);
    expect(readFileSync(r.path, "utf8").split("\n")[1]).toMatch(/^1,/);
    expect(r.path.startsWith(join(dir, "exports"))).toBe(true);
    expect((await err(s.exportQuery(undefined, "SELECT 1", "orders.csv"))).message).toMatch(/already exists/);
    expect((await err(s.exportQuery(undefined, "SELECT 1", "../escape.csv"))).code).toBe("BLOCKED");
    expect((await err(s.exportQuery(undefined, "SELECT 1", "/etc/passwd"))).code).toBe("BLOCKED");
    const j = await s.exportQuery(undefined, "SELECT name, password_hash FROM customers LIMIT 2", "c.json");
    expect(JSON.parse(readFileSync(j.path, "utf8"))[0].password_hash).toBe("[redacted]");
  });

  it("saves, runs and deletes named queries", async () => {
    s.saveQuery("by_status", "SELECT status, count(*) FROM orders GROUP BY status", { description: "orders per status" });
    expect(s.savedQueries().by_status!.description).toBe("orders per status");
    expect(() => s.saveQuery("bad", "DELETE FROM orders")).toThrow(/Only read/);
    expect(() => s.saveQuery("9bad", "SELECT 1")).toThrow(/names/);
    expect(s.getSaved("by_status").sql).toMatch(/GROUP BY status/);
    expect(() => s.getSaved("by_stats")).toThrow(/No saved query/);
    expect(s.deleteQuery("by_status")).toBe(true);
    expect(s.deleteQuery("by_status")).toBe(false);
  });

  it("writes an audit log without parameter values", async () => {
    await s.query(undefined, "SELECT name FROM customers WHERE email = ?", { params: ["secret@example.com"] });
    const file = join(dir, "state", "audit.jsonl");
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("SELECT name FROM customers WHERE email = ?");
    expect(text).not.toContain("secret@example.com");
    const last = s.audit.recent(1)[0]!;
    expect(last).toMatchObject({ db: "shop", ok: true, kind: "read", params: 1 });
    expect(s.audit.recent(50, { onlyErrors: true }).length).toBeGreaterThan(0);
  });

  it("refuses execute in read mode", async () => {
    const e = await err(s.execute(undefined, "UPDATE orders SET status = 'x' WHERE id = 1"));
    expect(e.code).toBe("READ_ONLY");
    expect(e.hint).toMatch(/--write/);
  });

  it("errors for unknown databases with suggestions", () => {
    expect(() => s.db("shp")).toThrow(/No database named "shp"/);
  });
});

describe("SQLite engine policies", () => {
  it("hides denied tables and columns, including via SELECT *, views and renames", async () => {
    const { engine: s } = sqliteEngine({ policy: { denyTables: ["api_keys"], denyColumns: ["customers.password_hash"] } });
    expect(await s.listTables()).not.toMatch(/api_keys/);
    expect(await s.describeTable(undefined, "customers")).not.toMatch(/password_hash/);
    expect((await err(s.describeTable(undefined, "api_keys"))).code).toBe("POLICY");
    for (const sql of [
      "SELECT * FROM api_keys",
      "SELECT password_hash FROM customers",
      "SELECT * FROM customers",
      "WITH c(a, b, x, y, z, w) AS (SELECT * FROM customers) SELECT w FROM c",
      "SELECT * FROM (SELECT * FROM customers) AS sub",
      "SELECT c.* FROM customers c JOIN orders o ON o.customer_id = c.id LIMIT 1",
    ]) {
      const e = await err(s.query(undefined, sql));
      expect(e.code, sql).toBe("POLICY");
    }
    const ok = await s.query(undefined, "SELECT id, name FROM customers LIMIT 1");
    expect(ok.rowCount).toBe(1);
    const e = await err(s.query(undefined, "SELECT * FROM customers"));
    expect(e.hint).toMatch(/Allowed columns of customers: id, name, email, country, created_at/);
    await s.close();
  });

  it("blocks views that read denied tables", async () => {
    const { engine: s } = sqliteEngine({ policy: { denyTables: ["orders"] } });
    expect((await err(s.query(undefined, "SELECT * FROM customer_revenue"))).code).toBe("POLICY");
    await s.close();
  });

  it("restricts to an allowlist", async () => {
    const { engine: s } = sqliteEngine({ policy: { allowTables: ["products"] } });
    expect((await s.listTables()).split("\n")).toHaveLength(2);
    expect((await s.query(undefined, "SELECT count(*) FROM products")).rows[0]![0]).toBe(28);
    expect((await err(s.query(undefined, "SELECT count(*) FROM orders"))).code).toBe("POLICY");
    await s.close();
  });

  it("masks emails and custom columns when asked", async () => {
    const { engine: s } = sqliteEngine({ policy: { maskEmails: true, redactColumns: ["customers.country"] } });
    const r = await s.query(undefined, "SELECT email, country FROM customers WHERE id = 1");
    expect(r.rows[0]![0]).toMatch(/^[a-z]\*\*\*@example\.com$/);
    expect(r.rows[0]![1]).toBe("[redacted]");
    await s.close();
  });

  it("can turn automatic redaction off", async () => {
    const { engine: s } = sqliteEngine({ policy: { redact: "off" } });
    const r = await s.query(undefined, "SELECT password_hash FROM customers WHERE id = 1");
    expect(r.rows[0]![0]).toMatch(/^\$2b\$/);
    await s.close();
  });
});

describe("SQLite engine (write mode)", () => {
  it("previews, confirms and commits a change", async () => {
    const { engine: s } = sqliteEngine({ mode: "write" });
    const dry = await s.execute(undefined, "UPDATE orders SET status = 'held' WHERE customer_id = ?", { params: [5] });
    expect(dry.dryRun).toBe(true);
    expect(dry.affected).toBe(9);
    expect(dry.committed).toBe(false);
    expect(dry.preview!.columns).toContain("status");
    expect(dry.confirmToken).toMatch(/^[\w-]{8}$/);
    expect(s.formatExecute(dry)).toMatch(/DRY RUN \(rolled back, nothing changed\): UPDATE would affect 9 rows/);
    expect((await s.query(undefined, "SELECT count(*) FROM orders WHERE status = 'held'")).rows[0]![0]).toBe(0);

    // wrong SQL or params with the token
    expect(
      (
        await err(
          s.execute(undefined, "UPDATE orders SET status = 'held' WHERE customer_id = ?", { params: [6], confirm: dry.confirmToken }),
        )
      ).code,
    ).toBe("CONFIRM_REQUIRED");
    // the failed attempt does not burn the token for the right SQL
    const done = await s.execute(undefined, "UPDATE orders SET status = 'held' WHERE customer_id = ?", {
      params: [5],
      confirm: dry.confirmToken,
    });
    expect(done.committed).toBe(true);
    expect(done.affected).toBe(9);
    expect((await s.query(undefined, "SELECT count(*) FROM orders WHERE status = 'held'")).rows[0]![0]).toBe(9);
    // single use
    expect(
      (
        await err(
          s.execute(undefined, "UPDATE orders SET status = 'held' WHERE customer_id = ?", { params: [5], confirm: dry.confirmToken }),
        )
      ).code,
    ).toBe("CONFIRM_REQUIRED");
    // dry_run=false without token
    expect((await err(s.execute(undefined, "DELETE FROM orders WHERE id = 1", { dryRun: false }))).code).toBe("CONFIRM_REQUIRED");
    expect(s.audit.recent(10, { onlyWrites: true }).some((e) => e.committed)).toBe(true);
    await s.close();
  });

  it("requires a real WHERE clause", async () => {
    const { engine: s } = sqliteEngine({ mode: "write", limits: { maxAffectedRows: 5000 } });
    expect((await err(s.execute(undefined, "DELETE FROM order_items"))).code).toBe("BLOCKED");
    expect((await err(s.execute(undefined, "UPDATE orders SET total = 0 WHERE 1 = 1"))).code).toBe("BLOCKED");
    const all = await s.execute(undefined, "UPDATE products SET in_stock = 1", { allowFullTable: true });
    expect(all.affected).toBe(28);
    expect(all.warnings.join(" ")).toMatch(/every row/);
    await s.close();
  });

  it("enforces the max affected rows limit", async () => {
    const { engine: s } = sqliteEngine({ mode: "write", limits: { maxAffectedRows: 10 } });
    const dry = await s.execute(undefined, "UPDATE orders SET status = 'x' WHERE status = 'delivered'");
    expect(dry.affected).toBe(427);
    expect(dry.confirmToken).toBeUndefined();
    expect(dry.warnings.join(" ")).toMatch(/above the limit of 10/);
    await s.close();
  });

  it("inserts with RETURNING and reports constraint errors", async () => {
    const { engine: s } = sqliteEngine({ mode: "write" });
    const dry = await s.execute(
      undefined,
      "INSERT INTO products (id, name, category, price) VALUES (100, 'Pen', 'Office', 1.5) RETURNING id, name",
    );
    expect(dry.preview!.rows).toEqual([[100, "Pen"]]);
    await s.execute(undefined, "INSERT INTO products (id, name, category, price) VALUES (100, 'Pen', 'Office', 1.5) RETURNING id, name", {
      confirm: dry.confirmToken,
    });
    const e = await err(s.execute(undefined, "INSERT INTO products (id, name, category, price) VALUES (100, 'Pen', 'Office', 1.5)"));
    expect(e.code).toBe("SQL_ERROR");
    expect(e.message).toMatch(/UNIQUE/);
    await s.close();
  });

  it("needs admin mode for schema changes and blocks denied tables", async () => {
    const { engine: w } = sqliteEngine({ mode: "write", policy: { denyTables: ["api_keys"] } });
    expect((await err(w.execute(undefined, "CREATE TABLE x (a int)"))).code).toBe("READ_ONLY");
    expect((await err(w.execute(undefined, "DELETE FROM api_keys WHERE id = 1"))).code).toBe("POLICY");
    await w.close();
    const { engine: a } = sqliteEngine({ mode: "admin" });
    const dry = await a.execute(undefined, "DROP TABLE api_keys");
    expect(dry.kind).toBe("ddl");
    expect(dry.warnings.join(" ")).toMatch(/destructive/);
    expect(await a.listTables()).toMatch(/api_keys/);
    await a.execute(undefined, "DROP TABLE api_keys", { confirm: dry.confirmToken });
    expect(await a.listTables()).not.toMatch(/api_keys/);
    await a.close();
  });
});
