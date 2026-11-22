import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CLIENTS = ["claude", "cursor", "vscode", "windsurf", "claude-code"] as const;
export type ClientName = (typeof CLIENTS)[number];

export interface InitOptions {
  home?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  dryRun?: boolean;
  /** Server key in the config (default "safesql"). */
  name?: string;
  /** Arguments passed to safesql-mcp (databases and flags). */
  args?: string[];
}

export interface InitResult {
  client: ClientName;
  path?: string;
  action: "written" | "unchanged" | "dry-run" | "command";
  config?: unknown;
  command?: string;
}

export function serverEntry(args: string[] = [], platform: NodeJS.Platform = process.platform) {
  return platform === "win32"
    ? { command: "cmd", args: ["/c", "npx", "-y", "safesql-mcp", ...args] }
    : { command: "npx", args: ["-y", "safesql-mcp", ...args] };
}

export function configPath(client: ClientName, o: InitOptions = {}): string | undefined {
  const home = o.home ?? homedir();
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  switch (client) {
    case "claude":
      if (platform === "darwin") return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
      if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
      return join(home, ".config", "Claude", "claude_desktop_config.json");
    case "cursor":
      return join(home, ".cursor", "mcp.json");
    case "vscode":
      return join(o.cwd ?? process.cwd(), ".vscode", "mcp.json");
    case "windsurf":
      return join(home, ".codeium", "windsurf", "mcp_config.json");
    case "claude-code":
      return undefined;
  }
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
}

/** Merge our server into a client's MCP config file, keeping everything else (a .bak copy is written first). */
export function installClient(client: ClientName, o: InitOptions = {}): InitResult {
  const name = o.name ?? "safesql";
  const entry = serverEntry(o.args ?? [], o.platform);
  if (client === "claude-code") {
    return { client, action: "command", command: `claude mcp add ${name} -- ${[entry.command, ...entry.args].map(shellQuote).join(" ")}` };
  }
  const path = configPath(client, o)!;
  let config: Record<string, unknown> = {};
  let original = "";
  if (existsSync(path)) {
    original = readFileSync(path, "utf8");
    if (original.trim()) {
      try {
        config = JSON.parse(original);
      } catch {
        throw new Error(`${path} is not valid JSON; fix or remove it, then run init again.`);
      }
    }
  }
  const key = client === "vscode" ? "servers" : "mcpServers";
  const servers = { ...((config[key] as Record<string, unknown>) ?? {}) };
  servers[name] = client === "vscode" ? { type: "stdio", ...entry } : entry;
  const next = { ...config, [key]: servers };
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (o.dryRun) return { client, path, action: "dry-run", config: next };
  if (text === original) return { client, path, action: "unchanged", config: next };
  mkdirSync(dirname(path), { recursive: true });
  if (original) writeFileSync(`${path}.bak`, original);
  writeFileSync(path, text);
  return { client, path, action: "written", config: next };
}

/** Find which client configs already mention safesql. */
export function installedClients(o: InitOptions = {}): { client: ClientName; path: string }[] {
  const out: { client: ClientName; path: string }[] = [];
  for (const c of CLIENTS) {
    const p = configPath(c, o);
    if (p && existsSync(p) && readFileSync(p, "utf8").includes("safesql-mcp")) out.push({ client: c, path: p });
  }
  return out;
}
