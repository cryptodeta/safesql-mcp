import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts", index: "src/index.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  splitting: true,
  minify: false,
  // The core engine is bundled so `npx safesql-mcp` only installs the MCP SDK, zod and pg.
  noExternal: ["@safesql/core"],
  external: ["pg", "pg-cursor", "node:sqlite"],
});
