import { describe, expect, it } from "vitest";
import { SafeSqlError } from "../src/errors.js";
import { analyzeSql } from "../src/guard.js";
import type { Dialect } from "../src/lexer.js";

const kind = (sql: string, d: Dialect = "postgres") => analyzeSql(sql, d).kind;
const blockedMsg = (sql: string, d: Dialect = "postgres") => {
  try {
    analyzeSql(sql, d);
  } catch (err) {
    expect(err).toBeInstanceOf(SafeSqlError);
    return (err as SafeSqlError).message;
  }
  throw new Error(`expected "${sql}" to be rejected`);
};

describe("read statements", () => {
  it.each([
    "SELECT 1",
    "select * from orders where id = $1",
    "WITH t AS (SELECT 1) SELECT * FROM t",
    "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 5) SELECT * FROM r",
    "VALUES (1), (2)",
    "TABLE orders",
    "SHOW search_path",
    "EXPLAIN SELECT 1",
    "EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM t",
    "(SELECT 1) UNION (SELECT 2)",
    "SELECT replace(name, 'a', 'b') FROM t",
    "SELECT 'DELETE FROM x; DROP TABLE y' AS s",
    'SELECT "delete" FROM t',
    "SELECT 1; ",
    "SELECT data->>'k', data ? 'k' FROM t",
  ])("%s is a read", (sql) => {
    expect(kind(sql)).toBe("read");
  });

  it.each(["PRAGMA table_info(orders)", "pragma main.index_list('t')", "PRAGMA integrity_check", "SELECT * FROM [order items]"])(
    "%s is a read in SQLite",
    (sql) => {
      expect(kind(sql, "sqlite")).toBe("read");
    },
  );
});

describe("writes and DDL", () => {
  it.each([
    ["INSERT INTO t VALUES (1)", "INSERT"],
    ["UPDATE t SET a = 1 WHERE id = 2", "UPDATE"],
    ["DELETE FROM t WHERE id = 2", "DELETE"],
    ["MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = 1", "MERGE"],
    ["WITH d AS (DELETE FROM t WHERE id = 1 RETURNING *) SELECT * FROM d", "DELETE"],
    ["WITH x AS (SELECT 1) UPDATE t SET a = 1 WHERE id = 1", "UPDATE"],
    ["EXPLAIN ANALYZE DELETE FROM t WHERE id = 1", "EXPLAIN ANALYZE DELETE"],
    ["EXPLAIN (ANALYZE true) UPDATE t SET a = 1 WHERE id = 2", "EXPLAIN ANALYZE UPDATE"],
  ])("%s is a write (%s)", (sql, verb) => {
    const a = analyzeSql(sql, "postgres");
    expect(a.kind).toBe("write");
    expect(a.verb).toBe(verb);
  });

  it("REPLACE INTO is a write in SQLite", () => {
    expect(kind("REPLACE INTO t VALUES (1)", "sqlite")).toBe("write");
    expect(kind("INSERT OR REPLACE INTO t VALUES (1)", "sqlite")).toBe("write");
  });

  it("EXPLAIN of a write without ANALYZE is a read (nothing runs)", () => {
    expect(kind("EXPLAIN DELETE FROM t WHERE id = 1")).toBe("read");
  });

  it.each([
    ["CREATE TABLE x (a int)", "CREATE TABLE", false],
    ["CREATE UNIQUE INDEX i ON t(a)", "CREATE INDEX", false],
    ["CREATE OR REPLACE VIEW v AS SELECT 1", "CREATE VIEW", false],
    ["ALTER TABLE t ADD COLUMN b int", "ALTER TABLE", false],
    ["ALTER TABLE t DROP COLUMN b", "ALTER TABLE", true],
    ["DROP TABLE IF EXISTS t", "DROP TABLE", true],
    ["TRUNCATE t", "TRUNCATE", true],
  ])("%s is DDL", (sql, verb, destructive) => {
    const a = analyzeSql(sql, "postgres");
    expect(a.kind).toBe("ddl");
    expect(a.verb).toBe(verb);
    expect(!!a.destructive).toBe(destructive);
  });

  it("finds the target table", () => {
    expect(analyzeSql("UPDATE public.orders SET a = 1 WHERE id = 1", "postgres").target).toBe("public.orders");
    expect(analyzeSql('DELETE FROM "Order Items" WHERE id = 1', "postgres").target).toBe("Order Items");
    expect(analyzeSql("INSERT OR IGNORE INTO t (a) VALUES (1)", "sqlite").target).toBe("t");
    expect(analyzeSql("DROP TABLE IF EXISTS old_logs", "postgres").target).toBe("old_logs");
  });
});

describe("WHERE checks", () => {
  it("flags UPDATE/DELETE without WHERE", () => {
    expect(analyzeSql("DELETE FROM t", "postgres").hasWhere).toBe(false);
    expect(analyzeSql("UPDATE t SET a = (SELECT max(b) FROM u WHERE u.id = 1)", "postgres").hasWhere).toBe(false);
    expect(analyzeSql("WITH d AS (DELETE FROM t RETURNING *) SELECT 1", "postgres").hasWhere).toBe(false);
    expect(analyzeSql("DELETE FROM t WHERE id IN (SELECT id FROM u)", "postgres").hasWhere).toBe(true);
    expect(analyzeSql("UPDATE t SET a = (SELECT 1) WHERE id = 2", "postgres").hasWhere).toBe(true);
    expect(analyzeSql("UPDATE t SET a = (SELECT 1 WHERE true)", "postgres").hasWhere).toBe(false);
    expect(analyzeSql("INSERT INTO t VALUES (1) ON CONFLICT (id) DO UPDATE SET a = 2", "postgres").hasWhere).toBeUndefined();
  });

  it.each(["1=1", "TRUE", "1", "(1 = 1)", "id = id", "status = 'x' OR 1=1", "1 <> 2", "'a' = 'a'"])("WHERE %s is trivial", (w) => {
    expect(analyzeSql(`DELETE FROM t WHERE ${w}`, "postgres").trivialWhere).toBe(true);
  });

  it.each(["id = 1", "status = 'x' AND 1=1", "a = b", "created_at < now() - interval '1 day'"])("WHERE %s is a real filter", (w) => {
    expect(analyzeSql(`DELETE FROM t WHERE ${w}`, "postgres").trivialWhere).toBe(false);
  });
});

describe("blocked statements", () => {
  it.each([
    ["SELECT 1; DROP TABLE t", /one statement/],
    ["SELECT 1; -- harmless\n DELETE FROM t", /one statement/],
    ["BEGIN", /transactions/],
    ["COMMIT", /transactions/],
    ["SET transaction_read_only = off", /SET/],
    ["SET ROLE admin", /SET/],
    ["RESET ALL", /RESET/],
    ["COPY t TO '/tmp/x'", /COPY/],
    ["DO $$ BEGIN DELETE FROM t; END $$", /DO/],
    ["CALL proc()", /CALL/],
    ["GRANT ALL ON t TO bob", /privilege/],
    ["LOCK TABLE t", /LOCK/],
    ["VACUUM", /VACUUM/],
    ["CREATE ROLE bob", /CREATE ROLE/],
    ["DROP DATABASE prod", /DROP DATABASE/],
    ["CREATE EXTENSION dblink", /EXTENSION/],
    ["ALTER SYSTEM SET work_mem = '1GB'", /ALTER SYSTEM/],
    ["CREATE INDEX CONCURRENTLY i ON t(a)", /CONCURRENTLY/],
    ["SELECT set_config('transaction_read_only', 'off', true)", /set_config/],
    ["SELECT pg_read_file('/etc/passwd')", /pg_read_file/],
    ["SELECT pg_catalog.pg_terminate_backend(123)", /pg_terminate_backend/],
    ["SELECT * FROM dblink('host=x', 'DELETE FROM t') AS r(a int)", /dblink/],
    ["SELECT query_to_xml('DELETE FROM t', true, true, '')", /query_to_xml/],
    ["SELECT lo_export(1, '/tmp/x')", /lo_export/],
    ["SELECT * FROM t FOR UPDATE", /row locks/],
    ["SELECT * FROM t FOR NO KEY UPDATE", /row locks/],
    ["SELECT * FROM t FOR SHARE", /row locks/],
    ["SELECT * INTO new_t FROM t", /INTO/],
    ["PREPARE p AS DELETE FROM t", /prepared/],
    ["EXECUTE p", /EXECUTE/],
  ])("%s", (sql, re) => {
    expect(blockedMsg(sql)).toMatch(re);
  });

  it.each([
    ["ATTACH DATABASE '/tmp/x.db' AS x", /ATTACH/],
    ["PRAGMA query_only = 0", /assignments/],
    ["PRAGMA writable_schema = 1", /assignments/],
    ["PRAGMA journal_mode = DELETE", /assignments/],
    ["PRAGMA optimize", /allowlist/],
    ["SELECT load_extension('x')", /load_extension/],
    ["SELECT writefile('/tmp/x', 'y')", /writefile/],
    ["VACUUM INTO '/tmp/copy.db'", /VACUUM/],
  ])("SQLite: %s", (sql, re) => {
    expect(blockedMsg(sql, "sqlite")).toMatch(re);
  });

  it("rejects empty and broken input with BAD_INPUT", () => {
    for (const sql of ["", "   ", "-- only a comment", "SELECT 'unterminated"]) {
      try {
        analyzeSql(sql, "sqlite");
        throw new Error("should fail");
      } catch (err) {
        expect((err as SafeSqlError).code).toBe("BAD_INPUT");
      }
    }
  });

  it("suggests the right keyword for typos", () => {
    try {
      analyzeSql("SELCT * FROM t", "sqlite");
    } catch (err) {
      expect((err as SafeSqlError).hint).toMatch(/SELECT/);
    }
  });

  it("does not treat keywords inside strings or comments as statements", () => {
    expect(kind("SELECT 1 /* ; DROP TABLE t */")).toBe("read");
    expect(kind("SELECT $$ ; DELETE FROM t $$")).toBe("read");
  });

  it("collects identifiers for policy checks", () => {
    const a = analyzeSql('SELECT u."Password", x.email FROM users u JOIN x ON true', "postgres");
    expect([...a.identifiers]).toEqual(expect.arrayContaining(["users", "password", "email", "x"]));
  });
});
