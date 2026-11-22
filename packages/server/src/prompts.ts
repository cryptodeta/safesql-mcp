import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const user = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });
const dbNote = (db?: string) => (db ? ` in the database "${db}"` : "");

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "explore_database",
    {
      title: "Explore a database",
      description: "Get a guided tour: what the data is about, key tables, relationships and interesting facts.",
      argsSchema: { db: z.string().optional(), focus: z.string().optional() },
    },
    ({ db, focus }) =>
      user(
        `Explore the data${dbNote(db)}${focus ? ` with a focus on ${focus}` : ""}. ` +
          "1) Call schema_overview. 2) Call relationships to see how tables connect. 3) Use sample_rows on the 2-4 most important tables. " +
          "4) Run 3-5 small aggregate queries (counts, date ranges, top categories) with LIMIT. " +
          "Then summarise in plain language: what the database is for, the main entities, data volume and time range, and 5 questions it could answer. Keep queries small.",
      ),
  );

  server.registerPrompt(
    "optimize_query",
    {
      title: "Optimize a query",
      description: "Explain why a query is slow and propose faster SQL and indexes.",
      argsSchema: { sql: z.string(), db: z.string().optional() },
    },
    ({ sql, db }) =>
      user(
        `Optimize this query${dbNote(db)}:\n\n${sql}\n\n` +
          "1) Call explain (analyze=false first; use analyze=true only if the query is a read and reasonably cheap). " +
          "2) Call describe_table for the tables involved to see existing indexes. " +
          "3) Propose a rewritten query and/or CREATE INDEX statements, explaining the expected effect of each. " +
          "4) If a rewrite is a read, verify it returns the same results with query on a LIMITed sample. Do not create indexes yourself; give the SQL to the user.",
      ),
  );

  server.registerPrompt(
    "data_quality_check",
    {
      title: "Data quality check",
      description: "Find nulls, duplicates, orphans and odd values in a table.",
      argsSchema: { table: z.string(), db: z.string().optional() },
    },
    ({ table, db }) =>
      user(
        `Check the data quality of the table "${table}"${dbNote(db)}. ` +
          "1) describe_table and profile_table. 2) For each foreign key, count orphan rows (child rows with no parent) with a LEFT JOIN query. " +
          "3) Look for duplicate values in columns that look like natural keys (email, code, name) with GROUP BY ... HAVING count(*) > 1 LIMIT 20. " +
          "4) Check for suspicious values: negative amounts, future dates, empty strings, outliers. " +
          "Report a short table of issues with counts, severity and a suggested fix. Read-only: do not change data.",
      ),
  );

  server.registerPrompt(
    "safe_change",
    {
      title: "Make a safe data change",
      description: "Plan, preview and (after approval) apply a data change with the execute tool.",
      argsSchema: { change: z.string(), db: z.string().optional() },
    },
    ({ change, db }) =>
      user(
        `I want to make this change${dbNote(db)}: ${change}\n\n` +
          "1) Inspect the affected tables with describe_table and a SELECT that counts and shows the rows that would change. " +
          "2) Write a single statement with a precise WHERE clause and call execute with dry_run=true. " +
          "3) Show me the preview and affected row count, and wait for my explicit OK. 4) Only then call execute again with the confirm token.",
      ),
  );
}
