import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SafeSql } from "@safesql/core";

const text = (uri: string, body: string) => ({ contents: [{ uri, mimeType: "text/plain", text: body }] });

export function registerResources(server: McpServer, engine: SafeSql): void {
  server.registerResource(
    "databases",
    "safesql://databases",
    { title: "Connected databases", description: "Names, engines and modes of connected databases.", mimeType: "text/plain" },
    (uri) =>
      text(
        uri.href,
        [...engine.databases.values()]
          .map((d) => `${d.name}: ${d.config.engine}, ${d.mode} mode, ${engine.scrub(d.config.display)}`)
          .join("\n") || "No databases configured.",
      ),
  );

  server.registerResource(
    "schema",
    new ResourceTemplate("safesql://{db}/schema", {
      list: async () => ({
        resources: [...engine.databases.keys()].map((name) => ({
          uri: `safesql://${name}/schema`,
          name: `${name} schema`,
          mimeType: "text/plain",
          description: `Compact schema of ${name}`,
        })),
      }),
    }),
    { title: "Database schema", description: "Compact, token-efficient schema overview of one database.", mimeType: "text/plain" },
    async (uri, vars) => {
      try {
        return text(uri.href, engine.scrub(await engine.schemaOverview(String(vars.db))));
      } catch (err) {
        return text(uri.href, `Error: ${(err as Error).message}`);
      }
    },
  );

  server.registerResource(
    "table",
    new ResourceTemplate("safesql://{db}/table/{table}", { list: undefined }),
    {
      title: "Table details",
      description: "Columns, keys, indexes and references of one table, e.g. safesql://shop/table/orders.",
      mimeType: "text/plain",
    },
    async (uri, vars) => {
      try {
        return text(uri.href, engine.scrub(await engine.describeTable(String(vars.db), decodeURIComponent(String(vars.table)))));
      } catch (err) {
        return text(uri.href, `Error: ${(err as Error).message}`);
      }
    },
  );
}
