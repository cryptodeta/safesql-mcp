import { describe, expect, it } from "vitest";
import { accessFromPlan } from "../src/drivers/postgres.js";
import { type PgNode, pgPlanHints, renderPgPlan, sqlitePlanHints } from "../src/hints.js";
import type { SchemaModel } from "../src/types.js";

const schema: SchemaModel = {
  engine: "postgres",
  defaultSchema: "public",
  loadedAt: 0,
  tables: [
    {
      schema: "public",
      name: "events",
      kind: "table",
      rowEstimate: 500_000,
      columns: [
        { name: "id", type: "int", nullable: false, pk: true },
        { name: "user_id", type: "int", nullable: false, pk: false },
        { name: "secret", type: "text", nullable: true, pk: false },
      ],
      indexes: [],
      foreignKeys: [],
    },
  ],
};

describe("plan hints", () => {
  it("SQLite: full scans, temp b-trees, automatic indexes", () => {
    const h = sqlitePlanHints(["SCAN events", "USE TEMP B-TREE FOR ORDER BY", "SEARCH t USING AUTOMATIC COVERING INDEX ON t(a)(a=?)"], {
      ...schema,
      engine: "sqlite",
    });
    expect(h.join("\n")).toMatch(/Full scan of events \(~500000 rows\)/);
    expect(h.join("\n")).toMatch(/ORDER BY/);
    expect(h.join("\n")).toMatch(/CREATE INDEX ON t\(a\)/);
  });

  it("PostgreSQL: seq scan with filter, disk sort, bad estimates", () => {
    const plan: PgNode = {
      "Node Type": "Sort",
      "Sort Method": "external merge",
      "Sort Space Type": "Disk",
      "Plan Rows": 10,
      "Actual Rows": 50_000,
      "Actual Loops": 1,
      Plans: [
        {
          "Node Type": "Seq Scan",
          "Relation Name": "events",
          Alias: "events",
          Filter: "(user_id = 42)",
          "Plan Rows": 10,
          "Rows Removed by Filter": 450_000,
        },
      ],
    };
    const h = pgPlanHints(plan, schema).join("\n");
    expect(h).toMatch(/index on events\(user_id\)/);
    expect(h).toMatch(/spilled to disk/);
    expect(h).toMatch(/off by 5000x/);
    expect(renderPgPlan(plan).join("\n")).toMatch(/-> Seq Scan on events/);
  });
});

describe("accessFromPlan", () => {
  it("maps aliases to tables and columns", () => {
    const plan: PgNode = {
      "Node Type": "Hash Join",
      Output: ["e.id", "u.name"],
      "Hash Cond": "(e.user_id = u.id)",
      Plans: [
        { "Node Type": "Seq Scan", "Relation Name": "events", Schema: "public", Alias: "e", Output: ["e.id", "e.user_id"] },
        { "Node Type": "Seq Scan", "Relation Name": "users", Schema: "public", Alias: "u", Output: ["u.id", "u.name"] },
      ],
    };
    const a = accessFromPlan(plan, schema);
    expect([...a.tables].sort()).toEqual(["public.events", "public.users"]);
    expect([...a.columns]).toEqual(expect.arrayContaining(["public.events.user_id", "public.users.name"]));
  });

  it("maps unqualified names when only one table is involved", () => {
    const plan: PgNode = {
      "Node Type": "Seq Scan",
      "Relation Name": "events",
      Schema: "public",
      Alias: "events",
      Output: ["id", "secret"],
    };
    expect([...accessFromPlan(plan, schema).columns].sort()).toEqual(["public.events.id", "public.events.secret"]);
  });

  it("marks function scans as partial", () => {
    expect(accessFromPlan({ "Node Type": "Function Scan" }, schema).partial).toBe(true);
  });
});
