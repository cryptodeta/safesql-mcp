import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SafeSql } from "@safesql/core";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { registerTools } from "./tools.js";
import { NAME, VERSION } from "./version.js";

export function instructions(engine: SafeSql): string {
  const names = [...engine.databases.values()].map((d) => `${d.name} (${d.config.engine}, ${d.mode})`).join(", ") || "none";
  return `safesql: safe SQL access. Databases: ${names}.
- Start with schema_overview (cheapest) or list_tables, then describe_table. Use search_schema to find columns.
- query runs ONE read statement; results are capped, so use LIMIT, aggregates and offset paging. Prefer bind params.
- explain shows plans with tuning hints. profile_table checks data quality. relationships draws a Mermaid ER diagram.
- [redacted] values are hidden on purpose; do not try to work around redaction or blocked tables.${
    engine.anyWritable
      ? "\n- Changes go through execute: dry run first, show the preview to the user, commit with the confirm token only after they agree."
      : "\n- All databases are read-only."
  }`;
}

export function createServer(engine: SafeSql): McpServer {
  const server = new McpServer(
    { name: NAME, version: VERSION, title: "SafeSQL" },
    { instructions: instructions(engine), capabilities: { logging: {} } },
  );
  registerTools(server, engine);
  registerResources(server, engine);
  registerPrompts(server);
  return server;
}
