import type { Engine } from "./types.js";

/** Default name patterns for columns whose values are masked in every result. */
export const DEFAULT_SENSITIVE =
  /(password|passwd|^pass$|_pass$|^pwd$|_pwd$|secret|token|api_?key|private_?key|access_?key|auth_?key|session_?key|^ssn$|social_security|credit_?card|card_?number|^cvv$|^cvc$|^iban$|^salt$|_salt$)/i;

export const REDACTED = "[redacted]";

function globToRegex(glob: string): RegExp {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}

/**
 * Match a dotted rule ("users", "public.users", "users.email", "*.password", "audit_*") against a qualified
 * name. Rules with fewer parts match the right-most parts of the name, so "users.email" matches
 * "public.users.email" and "users" matches "public.users".
 */
export function ruleMatches(rule: string, qualified: string[]): boolean {
  const parts = rule.split(".");
  if (parts.length > qualified.length) return false;
  const tail = qualified.slice(qualified.length - parts.length);
  return parts.every((p, i) => globToRegex(p).test(tail[i]!));
}

export interface PolicyConfig {
  allowTables?: string[];
  denyTables?: string[];
  denyColumns?: string[];
  redactColumns?: string[];
  /** "auto" masks DEFAULT_SENSITIVE names plus redactColumns; "off" masks only redactColumns. */
  redact?: "auto" | "off";
  maskEmails?: boolean;
}

export class Policy {
  readonly cfg: Required<Omit<PolicyConfig, "maskEmails" | "redact">> & { maskEmails: boolean; redact: "auto" | "off" };
  constructor(
    cfg: PolicyConfig,
    private readonly engine: Engine,
  ) {
    this.cfg = {
      allowTables: cfg.allowTables ?? [],
      denyTables: cfg.denyTables ?? [],
      denyColumns: cfg.denyColumns ?? [],
      redactColumns: cfg.redactColumns ?? [],
      redact: cfg.redact ?? "auto",
      maskEmails: cfg.maskEmails ?? false,
    };
  }

  /** True when tables or columns are restricted (requires planner-based access checks). */
  get restrictive(): boolean {
    return this.cfg.allowTables.length > 0 || this.cfg.denyTables.length > 0 || this.cfg.denyColumns.length > 0;
  }

  private split(name: string): string[] {
    return name.split(".");
  }

  tableAllowed(schema: string, table: string): boolean {
    const q = [schema, table];
    if (this.cfg.denyTables.some((r) => ruleMatches(r, q))) return false;
    if (this.cfg.allowTables.length && !this.cfg.allowTables.some((r) => ruleMatches(r, q))) return false;
    return true;
  }

  columnDenied(schema: string, table: string, column: string): boolean {
    return this.cfg.denyColumns.some((r) => ruleMatches(r, [schema, table, column]));
  }

  columnRedacted(schema: string | undefined, table: string | undefined, column: string): boolean {
    if (this.cfg.redact === "auto" && DEFAULT_SENSITIVE.test(column)) return true;
    const q = [schema ?? "*", table ?? "*", column];
    return this.cfg.redactColumns.some((r) => ruleMatches(r, q) || (r.split(".").length === 1 && globToRegex(r).test(column)));
  }

  isEmailColumn(column: string): boolean {
    return this.cfg.maskEmails && /e_?mail/i.test(column);
  }

  /** Lexical pre-check: bare names of denied tables/columns mentioned in the SQL. Returns the offending rule. */
  lexicalViolation(identifiers: Set<string>): string | undefined {
    for (const rule of [...this.cfg.denyTables, ...this.cfg.denyColumns]) {
      const last = rule.split(".").pop()!;
      if (last.includes("*") || last.includes("?")) {
        const re = globToRegex(last);
        for (const id of identifiers) if (re.test(id)) return rule;
      } else if (identifiers.has(last.toLowerCase())) return rule;
    }
    return undefined;
  }

  /** Check planner-reported access. Names are "table"/"table.col" (SQLite) or "schema.table"/"schema.table.col". */
  accessViolation(tables: Iterable<string>, columns: Iterable<string>, defaultSchema: string): string | undefined {
    for (const t of tables) {
      const parts = this.split(t);
      const q = parts.length === 1 ? [defaultSchema, parts[0]!] : parts;
      if (q[q.length - 1] === "sqlite_schema" || q[q.length - 1] === "sqlite_master") continue;
      if (!this.tableAllowed(q[0]!, q[1]!)) return `table ${q.join(".")}`;
    }
    for (const c of columns) {
      const parts = this.split(c);
      const q = parts.length === 2 ? [defaultSchema, ...parts] : parts;
      if (this.columnDenied(q[0]!, q[1]!, q[2]!)) return `column ${q.slice(-2).join(".")}`;
    }
    return undefined;
  }

  get engineName(): Engine {
    return this.engine;
  }
}

export function maskEmail(v: unknown): unknown {
  if (typeof v !== "string") return v;
  return v.replace(
    /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
    (_m, first: string, domain: string) => `${first}***@${domain}`,
  );
}
