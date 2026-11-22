import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type SafeSql, toSafeSqlError } from "@safesql/core";

export function ok(engine: SafeSql, text: string): CallToolResult {
  return { content: [{ type: "text", text: engine.scrub(text) }] };
}

export function fail(engine: SafeSql, err: unknown): CallToolResult {
  const e = toSafeSqlError(err);
  const lines = [`Error [${e.code}]: ${e.message}`];
  if (e.hint) lines.push(`Hint: ${e.hint}`);
  return { isError: true, content: [{ type: "text", text: engine.scrub(lines.join("\n")) }] };
}

export async function run(engine: SafeSql, fn: () => Promise<string> | string): Promise<CallToolResult> {
  try {
    return ok(engine, await fn());
  } catch (err) {
    return fail(engine, err);
  }
}

/** Accept ["a","b"], "a,b" or "a b". */
export function list(input: string | string[] | undefined): string[] {
  if (input === undefined) return [];
  const arr = Array.isArray(input) ? input : [input];
  return arr
    .flatMap((s) => s.split(/[,\s]+/))
    .map((s) => s.trim())
    .filter(Boolean);
}
