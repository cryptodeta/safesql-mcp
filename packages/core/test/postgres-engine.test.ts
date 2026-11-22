import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDriver } from "../src/drivers/postgres.js";
import type { SafeSqlError } from "../src/errors.js";
import type { SafeSql } from "../src/index.js";
import { createPgDatabase, PG_URL, pgEngine } from "./helpers.js";

async function err(p: Promise<unknown>): Promise<SafeSqlError> {
  try {
    await p;
  } catch (e) {
    return e as SafeSqlError;
  }
  throw new Error("expected a rejection");
}

// Runs against a real PostgreSQL server. Set SAFESQL_TEST_PG_URL (CI does this with a service container).
describe.skipIf(!PG_URL)("PostgreSQL engine", () => {
  let url: string;
  let drop: () => Promise<void>;
  let s: SafeSql;
  const extra: SafeSql[] = [];
  const engine = (o: Parameters<typeof pgEngine>[1]) => {
    const e = pgEngine(url, o);
    extra.push(e);
    return e;
  };

  beforeAll(async () => {
    ({ url, drop } = await createPgDatabase());
    s = pgEngine(url);
  });
  afterAll(async () => {
    await s?.close();
    await Promise.all(extra.map((e) => e.close()));
    await drop?.();
  });

  it("introspects schemas, tables, views, keys and comments", async () => {
    const list = await s.listTables();
    expect(list).toMatch(/orders ~1000 \[5\]/);
    expect(list).toMatch(/schema audit:\n {2}events ~300/);
    const d = await s.describeTable(undefined, "orders");
    expect(d).toMatch(/^table orders {2}~1000 rows {2}-- One row per checkout/);
    expect(d).toContain("total numeric(10,2) NOT NULL DEFAULT 0");
    expect(await s.describeTable(undefined, "audit.events")).toContain("customer_id int → customers.id");
    expect(await s.describeTable(undefined, "customers")).toMatch(/referenced by: .*audit\.events\.customer_id/);
    expect(await s.describeTable(undefined, "customers")).toMatch(/referenced by: .*orders\.customer_id/);
    const o = await s.schemaOverview();
    expect(o).toContain("audit.events ~300: id* int, customer_id int?→customers, kind text, at timestamptz, payload jsonb?");
  });

  it("runs reads with $n params, paging and native types", async () => {
    const r = await s.query(undefined, "SELECT id, created_at, total FROM orders WHERE customer_id = $1 ORDER BY id", {
      params: [1],
      maxRows: 5,
    });
    expect(r.rowCount).toBe(5);
    expect(r.hasMore).toBe(true);
    expect(r.rows[0]![1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const page2 = await s.query(undefined, "SELECT id FROM orders WHERE customer_id = $1 ORDER BY id", {
      params: [1],
      maxRows: 5,
      offset: 5,
    });
    expect(page2.rows[0]![0]).not.toBe(r.rows[0]![0]);
    const j = await s.query(
      undefined,
      "SELECT payload, 1 AS a, 2 AS a, 12345678901234567::bigint AS big FROM audit.events ORDER BY id LIMIT 1",
    );
    expect(j.rows[0]).toEqual(['{"i":1}', 1, 2, "12345678901234567"]);
  });

  it("redacts by source column, even when aliased", async () => {
    const r = await s.query(
      undefined,
      "SELECT c.name, c.password_hash AS x, k.token FROM customers c JOIN api_keys k ON k.customer_id = c.id LIMIT 3",
    );
    expect(r.rows.every((row) => row[1] === "[redacted]" && row[2] === "[redacted]")).toBe(true);
    expect(r.redacted).toEqual(["x", "token"]);
  });

  it("enforces READ ONLY at the engine level, even with the guard bypassed", async () => {
    const driver = new PostgresDriver({ url, writable: false });
    const opts = { maxRows: 5, offset: 0, timeoutMs: 5000, maxBytes: 100_000 };
    for (const sql of [
      "DELETE FROM orders",
      "WITH d AS (DELETE FROM orders RETURNING id) SELECT count(*) FROM d",
      "SELECT nextval(pg_get_serial_sequence('audit.events', 'id'))",
      "SELECT * FROM orders FOR UPDATE",
    ]) {
      const e = await err(driver.read(sql, opts));
      expect(e.code, sql).toBe("READ_ONLY");
    }
    // flipping the transaction to read-write is refused because a snapshot was already taken
    const flip = await err(driver.read("SELECT set_config('transaction_read_only', 'off', true)", opts));
    expect(flip.message).toMatch(/read-write mode must be set before any query|read-only/);
    expect(await driver.probeReadOnly()).toMatch(/read-only transaction/);
    await driver.close();
    expect((await s.query(undefined, "SELECT count(*)::int FROM orders")).rows[0]![0]).toBe(1000);
  });

  it("blocks dangerous statements and functions in the guard", async () => {
    for (const sql of [
      "SET transaction_read_only = off",
      "COPY orders TO '/tmp/x'",
      "SELECT pg_read_file('/etc/hostname')",
      "DO $$ BEGIN END $$",
      "SELECT 1; SELECT 2",
    ]) {
      expect((await err(s.query(undefined, sql))).code, sql).toBe("BLOCKED");
    }
  });

  it("cancels slow queries with statement_timeout", async () => {
    const e = await err(s.query(undefined, "SELECT pg_sleep(5)", { timeoutMs: 300 }));
    expect(e.code).toBe("TIMEOUT");
    expect((await s.query(undefined, "SELECT 1 AS ok")).rows[0]![0]).toBe(1);
  });

  it("explains with hints and EXPLAIN ANALYZE for reads", async () => {
    const p = await s.explain(undefined, "SELECT * FROM orders WHERE customer_id = $1", { params: [3] });
    expect(p.text).toMatch(/Scan/);
    const a = await s.explain(undefined, "SELECT count(*) FROM order_items WHERE quantity > 1", { analyze: true });
    expect(a.text).toMatch(/actual rows=/);
    expect(a.text).toMatch(/Execution Time/);
    expect((await err(s.explain(undefined, "DELETE FROM orders WHERE id = 1", { analyze: true }))).code).toBe("READ_ONLY");
  });

  it("suggests names in errors", async () => {
    expect((await err(s.query(undefined, "SELECT * FROM ordrs"))).hint).toContain('"orders"');
    expect((await err(s.query(undefined, "SELECT stauts FROM orders"))).hint).toContain('"status"');
  });

  it("profiles, samples and maps relationships", async () => {
    const p = await s.profile(undefined, "audit.events");
    expect(p).toMatch(/kind \| text \| 0 \(0%\) \| 2 \|/);
    expect(p).toMatch(/view \(200\)/);
    expect((await s.sample(undefined, "products", { rows: 3, random: true })).rowCount).toBe(3);
    const m = await s.relationships(undefined, { table: "customers" });
    expect(m).toContain('customers |o--o{ audit_events : "customer_id"');
    expect(m).toContain('customers ||--o{ orders : "customer_id"');
  });

  it("applies table and column policies with the planner", async () => {
    const p = engine({ policy: { denyTables: ["api_keys"], denyColumns: ["customers.password_hash"] } });
    expect(await p.listTables()).not.toMatch(/api_keys/);
    for (const sql of [
      "SELECT * FROM customers",
      "SELECT x FROM (SELECT * FROM customers) t(a, b, c, d, e, x)",
      "SELECT * FROM api_keys",
      "SELECT (SELECT count(*) FROM api_keys)",
    ]) {
      expect((await err(p.query(undefined, sql))).code, sql).toBe("POLICY");
    }
    expect((await p.query(undefined, "SELECT name FROM customers LIMIT 1")).rowCount).toBe(1);
    const a = engine({ policy: { allowTables: ["audit.*"] } });
    expect((await a.listTables()).trim().split("\n")).toHaveLength(3);
    expect((await err(a.query(undefined, "SELECT count(*) FROM audit.events e JOIN customers c ON c.id = e.customer_id"))).code).toBe(
      "POLICY",
    );
    expect((await a.query(undefined, "SELECT count(*)::int FROM audit.events")).rows[0]![0]).toBe(300);
  });

  it("previews and commits writes in write mode", async () => {
    const w = engine({ mode: "write", limits: { maxAffectedRows: 50 } });
    const dry = await w.execute(undefined, "UPDATE orders SET status = 'held' WHERE customer_id = $1", { params: [5] });
    expect(dry.affected).toBe(9);
    expect(dry.preview!.rows[0]).toContain("held");
    expect((await w.query(undefined, "SELECT count(*)::int FROM orders WHERE status = 'held'")).rows[0]![0]).toBe(0);
    const done = await w.execute(undefined, "UPDATE orders SET status = 'held' WHERE customer_id = $1", {
      params: [5],
      confirm: dry.confirmToken,
    });
    expect(done.committed).toBe(true);
    expect((await w.query(undefined, "SELECT count(*)::int FROM orders WHERE status = 'held'")).rows[0]![0]).toBe(9);
    const big = await w.execute(undefined, "DELETE FROM order_items WHERE quantity >= 1");
    expect(big.confirmToken).toBeUndefined();
    expect(big.warnings.join(" ")).toMatch(/above the limit/);
    expect((await err(w.execute(undefined, "DELETE FROM orders"))).code).toBe("BLOCKED");
    expect((await err(w.execute(undefined, "ALTER TABLE orders ADD COLUMN x int"))).code).toBe("READ_ONLY");
    const fk = await err(w.execute(undefined, "DELETE FROM customers WHERE id = 1"));
    expect(fk.code).toBe("SQL_ERROR");
    expect(fk.message).toMatch(/foreign key/);
  });

  it("supports schema changes in admin mode, rolled back on dry run", async () => {
    const a = engine({ mode: "admin" });
    const dry = await a.execute(undefined, "ALTER TABLE products ADD COLUMN sku text");
    expect(dry.kind).toBe("ddl");
    expect(await a.describeTable(undefined, "products")).not.toMatch(/sku/);
    await a.execute(undefined, "ALTER TABLE products ADD COLUMN sku text", { confirm: dry.confirmToken });
    expect(await a.describeTable(undefined, "products")).toMatch(/sku text/);
  });

  it("never leaks the password from the connection URL", async () => {
    const u = new URL(url);
    u.password = "Sup3rSecretPw";
    u.port = "1";
    const bad = engine({});
    const fresh = pgEngine(u.toString());
    extra.push(fresh);
    const e = await err(fresh.query(undefined, "SELECT 1"));
    expect(e.code).toBe("CONNECTION");
    expect(fresh.scrub(`${e.message} ${u.toString()}`)).not.toContain("Sup3rSecretPw");
    expect([...fresh.databases.values()][0]!.config.display).toContain(":***@");
    void bad;
  });
});
