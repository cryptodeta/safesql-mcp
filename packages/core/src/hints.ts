import type { SchemaModel, TableInfo } from "./types.js";

const BIG_TABLE = 10_000;

function findTable(schema: SchemaModel, name: string): TableInfo | undefined {
  const n = name.toLowerCase();
  return schema.tables.find((t) => t.name.toLowerCase() === n);
}

/** Plain-language tuning hints from SQLite EXPLAIN QUERY PLAN details. */
export function sqlitePlanHints(details: string[], schema: SchemaModel): string[] {
  const hints = new Set<string>();
  for (const d of details) {
    const scan = /^SCAN (?:TABLE )?(\S+)(?: AS \S+)?$/.exec(d);
    if (scan) {
      const t = findTable(schema, scan[1]!);
      const size = t?.rowEstimate;
      hints.add(
        `Full scan of ${scan[1]}${size ? ` (~${size} rows)` : ""}. If the query filters or joins on a column of ${scan[1]}, an index on that column avoids reading every row.`,
      );
    }
    if (/USE TEMP B-TREE FOR (ORDER BY|GROUP BY|DISTINCT)/.test(d)) {
      const what = /FOR (ORDER BY|GROUP BY|DISTINCT)/.exec(d)![1];
      hints.add(`Sorting in a temporary B-tree for ${what}. An index whose columns match the ${what} order removes this step.`);
    }
    const auto = /AUTOMATIC (?:COVERING |PARTIAL )*INDEX ON (\S+)\(([^)]*)\)/.exec(d);
    if (auto)
      hints.add(
        `SQLite builds a temporary index on ${auto[1]}(${auto[2]}) for every run. Create it permanently: CREATE INDEX ON ${auto[1]}(${auto[2]}).`,
      );
    if (/CORRELATED (SCALAR )?SUBQUERY/.test(d))
      hints.add("A correlated subquery runs once per outer row. Rewriting it as a JOIN is usually faster.");
    if (/USING COVERING INDEX/.test(d)) hints.add("Good: a covering index answers the query without touching the table.");
  }
  return [...hints];
}

interface PgNode {
  "Node Type": string;
  "Relation Name"?: string;
  Alias?: string;
  "Plan Rows"?: number;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  Filter?: string;
  "Rows Removed by Filter"?: number;
  "Sort Method"?: string;
  "Sort Space Type"?: string;
  "Hash Batches"?: number;
  "Join Type"?: string;
  "Index Name"?: string;
  "Total Cost"?: number;
  Plans?: PgNode[];
  [key: string]: unknown;
}

/** Plain-language tuning hints from a PostgreSQL JSON plan. */
export function pgPlanHints(plan: PgNode, schema?: SchemaModel): string[] {
  const hints = new Set<string>();
  const visit = (n: PgNode) => {
    const rel = n["Relation Name"];
    const rows = n["Actual Rows"] ?? n["Plan Rows"] ?? 0;
    if (n["Node Type"] === "Seq Scan" && rel) {
      const t = schema ? findTable(schema, rel) : undefined;
      const size = t?.rowEstimate ?? 0;
      const removed = n["Rows Removed by Filter"] ?? 0;
      if (n.Filter && (size > BIG_TABLE || removed > BIG_TABLE)) {
        const cols = [...new Set([...n.Filter.matchAll(/\(?(\w+)\)? *(?:=|<|>|<=|>=|~~|IS)/g)].map((m) => m[1]))].filter(
          (c) => c && !/^\d+$/.test(c),
        );
        hints.add(
          `Seq Scan on ${rel} (~${Math.max(size, removed)} rows) with filter ${n.Filter}. Consider an index${cols.length ? ` on ${rel}(${cols.join(", ")})` : ""}.`,
        );
      } else if (size > BIG_TABLE * 10 && !n.Filter) {
        hints.add(`Seq Scan reads all of ${rel} (~${size} rows). Add a WHERE clause or LIMIT if you do not need every row.`);
      }
    }
    if (n["Sort Space Type"] === "Disk")
      hints.add(`Sort spilled to disk (${n["Sort Method"]}). An index matching the ORDER BY, or a larger work_mem, avoids it.`);
    if ((n["Hash Batches"] ?? 1) > 1)
      hints.add("Hash join used several batches (spilled to disk). A larger work_mem or a more selective join helps.");
    if (n["Node Type"] === "Nested Loop" && (n["Plan Rows"] ?? 0) > 100_000)
      hints.add("Nested Loop over many rows. Check that the join columns are indexed on the inner side.");
    if (n["Actual Rows"] !== undefined && n["Plan Rows"] !== undefined) {
      const est = Math.max(1, n["Plan Rows"]);
      const act = Math.max(1, n["Actual Rows"]);
      if ((act / est > 10 || est / act > 10) && Math.max(est, act) > 1000)
        hints.add(
          `Row estimate is off by ${Math.round(Math.max(act / est, est / act))}x on ${n["Node Type"]}${rel ? ` ${rel}` : ""} (planned ${est}, actual ${act}). Run ANALYZE ${rel ?? "on the tables involved"} so the planner has fresh statistics.`,
        );
    }
    void rows;
    for (const c of n.Plans ?? []) visit(c);
  };
  visit(plan);
  return [...hints];
}

/** Render a PostgreSQL JSON plan as compact indented text. */
export function renderPgPlan(plan: PgNode, depth = 0, lines: string[] = []): string[] {
  const parts: string[] = [plan["Node Type"]];
  if (plan["Join Type"] && plan["Node Type"].includes("Join")) parts[0] = `${plan["Join Type"]} ${plan["Node Type"]}`;
  if (plan["Relation Name"])
    parts.push(`on ${plan["Relation Name"]}${plan.Alias && plan.Alias !== plan["Relation Name"] ? ` ${plan.Alias}` : ""}`);
  if (plan["Index Name"]) parts.push(`using ${plan["Index Name"]}`);
  const cost = plan["Total Cost"] !== undefined ? `cost=${plan["Total Cost"]}` : "";
  const est = plan["Plan Rows"] !== undefined ? `rows=${plan["Plan Rows"]}` : "";
  const actual =
    plan["Actual Rows"] !== undefined
      ? ` actual rows=${plan["Actual Rows"]} loops=${plan["Actual Loops"]} time=${plan["Actual Total Time"]}ms`
      : "";
  lines.push(`${"  ".repeat(depth)}-> ${parts.join(" ")} (${[cost, est].filter(Boolean).join(" ")}${actual})`);
  for (const key of ["Index Cond", "Filter", "Hash Cond", "Merge Cond", "Join Filter", "Sort Key", "Group Key"]) {
    const v = plan[key];
    if (v !== undefined) lines.push(`${"  ".repeat(depth + 1)}${key}: ${Array.isArray(v) ? v.join(", ") : String(v)}`);
  }
  if (plan["Rows Removed by Filter"]) lines.push(`${"  ".repeat(depth + 1)}Rows Removed by Filter: ${plan["Rows Removed by Filter"]}`);
  if (plan["Sort Method"]) lines.push(`${"  ".repeat(depth + 1)}Sort Method: ${plan["Sort Method"]} (${plan["Sort Space Type"] ?? ""})`);
  for (const c of plan.Plans ?? []) renderPgPlan(c, depth + 1, lines);
  return lines;
}

export type { PgNode };
