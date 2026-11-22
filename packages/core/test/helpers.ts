import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { type CliOverrides, createDemoDatabase, demoStatements, resolveConfig, SafeSql } from "../src/index.js";

export const PG_URL = process.env.SAFESQL_TEST_PG_URL;

export function tempDir(prefix = "safesql-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A fresh demo SQLite database and an engine over it. */
export function sqliteEngine(o: Omit<CliOverrides, "specs"> = {}, dir = tempDir()): { engine: SafeSql; path: string; dir: string } {
  const path = join(dir, "shop.db");
  createDemoDatabase(path, true);
  const engine = new SafeSql(
    resolveConfig({
      env: {},
      home: dir,
      stateDir: join(dir, "state"),
      exportDir: join(dir, "exports"),
      cwd: dir,
      ...o,
      specs: [`shop=${path}`],
    }),
  );
  return { engine, path, dir };
}

/** Create a fresh PostgreSQL database seeded with the demo data. Returns its URL and a cleanup function. */
export async function createPgDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  if (!PG_URL) throw new Error("SAFESQL_TEST_PG_URL is not set");
  const name = `safesql_t_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new pg.Client(PG_URL);
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(PG_URL);
  u.pathname = `/${name}`;
  const url = u.toString();
  const c = new pg.Client(url);
  await c.connect();
  for (const s of demoStatements("postgres")) await c.query(s);
  await c.query("CREATE SCHEMA audit");
  await c.query(
    "CREATE TABLE audit.events (id serial PRIMARY KEY, customer_id int REFERENCES public.customers(id), kind text NOT NULL, at timestamptz NOT NULL DEFAULT now(), payload jsonb)",
  );
  await c.query(
    "INSERT INTO audit.events (customer_id, kind, payload) SELECT (i % 200) + 1, CASE WHEN i % 3 = 0 THEN 'login' ELSE 'view' END, jsonb_build_object('i', i) FROM generate_series(1, 300) i",
  );
  await c.query("COMMENT ON TABLE public.orders IS 'One row per checkout'");
  await c.query("ANALYZE");
  await c.end();
  return {
    url,
    drop: async () => {
      const a = new pg.Client(PG_URL);
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export function pgEngine(url: string, o: Omit<CliOverrides, "specs"> = {}, dir = tempDir()): SafeSql {
  return new SafeSql(
    resolveConfig({
      env: {},
      home: dir,
      stateDir: join(dir, "state"),
      exportDir: join(dir, "exports"),
      cwd: dir,
      ...o,
      specs: [`shop=${url}`],
    }),
  );
}
