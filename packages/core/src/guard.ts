import { SafeSqlError } from "./errors.js";
import { type Dialect, LexError, splitStatements, type Token } from "./lexer.js";
import { suggest } from "./suggest.js";

/**
 * Statement classes:
 * - read:  SELECT / WITH / VALUES / TABLE / SHOW / read-only PRAGMA / EXPLAIN of a read
 * - write: INSERT / UPDATE / DELETE / MERGE / REPLACE (data changes)
 * - ddl:   CREATE / ALTER / DROP / TRUNCATE / COMMENT / REINDEX / ANALYZE / REFRESH (schema changes)
 */
export type StatementKind = "read" | "write" | "ddl";

export interface Analysis {
  kind: StatementKind;
  /** Main verb, e.g. SELECT, UPDATE, DROP TABLE, EXPLAIN. */
  verb: string;
  /** SQL with surrounding whitespace and the trailing semicolon removed. */
  sql: string;
  tokens: Token[];
  /** For UPDATE/DELETE: whether every UPDATE/DELETE has a WHERE clause. */
  hasWhere?: boolean;
  /** WHERE clause that matches every row (1=1, TRUE, x=x, ... OR 1=1). */
  trivialWhere?: boolean;
  /** Target table of a DML/DDL statement when it can be read from the SQL. */
  target?: string;
  /** EXPLAIN ANALYZE (executes the statement). */
  explainAnalyze?: boolean;
  /** Destructive DDL (DROP, TRUNCATE, ALTER ... DROP). */
  destructive?: boolean;
  /** Bare and quoted identifiers mentioned anywhere (lowercased), for policy checks. */
  identifiers: Set<string>;
}

const READ_VERBS = new Set(["SELECT", "VALUES", "TABLE", "SHOW"]);
const WRITE_VERBS = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE", "UPSERT"]);
const DDL_VERBS = new Set(["CREATE", "ALTER", "DROP", "TRUNCATE", "COMMENT", "REINDEX", "ANALYZE", "REFRESH"]);

/** Statements that are never allowed, in any mode, with the reason shown to the model. */
const ALWAYS_BLOCKED: Record<string, string> = {
  ATTACH: "ATTACH can open arbitrary files on the server",
  DETACH: "DETACH changes the connection's database list",
  BEGIN: "transactions are managed by safesql-mcp (every statement runs in its own transaction)",
  START: "transactions are managed by safesql-mcp",
  COMMIT: "transactions are managed by safesql-mcp",
  END: "transactions are managed by safesql-mcp",
  ROLLBACK: "transactions are managed by safesql-mcp",
  ABORT: "transactions are managed by safesql-mcp",
  SAVEPOINT: "transactions are managed by safesql-mcp",
  RELEASE: "transactions are managed by safesql-mcp",
  SET: "SET could change the session's safety settings (read-only mode, timeouts, role)",
  RESET: "RESET could change the session's safety settings",
  COPY: "COPY can read and write server files and programs",
  CALL: "CALL runs stored procedures whose effects cannot be checked",
  DO: "DO runs arbitrary procedural code",
  LOCK: "LOCK can block other users of the database",
  LISTEN: "LISTEN/NOTIFY are session features",
  NOTIFY: "LISTEN/NOTIFY are session features",
  UNLISTEN: "LISTEN/NOTIFY are session features",
  LOAD: "LOAD loads shared libraries into the server",
  PREPARE: "prepared statements are managed by safesql-mcp",
  EXECUTE: "EXECUTE runs a prepared statement whose text cannot be checked",
  DEALLOCATE: "prepared statements are managed by safesql-mcp",
  DISCARD: "DISCARD resets session state",
  CHECKPOINT: "CHECKPOINT is a server maintenance command",
  CLUSTER: "CLUSTER rewrites tables and takes exclusive locks",
  VACUUM: "VACUUM cannot run inside a transaction and VACUUM INTO writes files",
  GRANT: "privilege changes are out of scope; manage roles directly in the database",
  REVOKE: "privilege changes are out of scope; manage roles directly in the database",
  SECURITY: "SECURITY LABEL changes security metadata",
  IMPORT: "IMPORT FOREIGN SCHEMA reaches other servers",
  REASSIGN: "REASSIGN OWNED changes ownership",
};

/** Object types that CREATE/ALTER/DROP may never touch. */
const BLOCKED_OBJECTS = new Set([
  "DATABASE",
  "ROLE",
  "USER",
  "GROUP",
  "TABLESPACE",
  "EXTENSION",
  "SERVER",
  "SUBSCRIPTION",
  "PUBLICATION",
  "LANGUAGE",
  "SYSTEM",
  "EVENT",
  "OWNED",
  "FOREIGN",
  "SCHEMA",
  "POLICY",
  "MAPPING",
]);

/** Functions with side effects outside the transaction, or that run SQL hidden inside a string. */
const BLOCKED_FUNCTIONS: Record<Dialect, string[]> = {
  postgres: [
    "pg_read_file",
    "pg_read_binary_file",
    "pg_ls_dir",
    "pg_stat_file",
    "pg_ls_logdir",
    "pg_ls_waldir",
    "pg_ls_tmpdir",
    "pg_ls_archive_statusdir",
    "lo_import",
    "lo_export",
    "lo_unlink",
    "lo_from_bytea",
    "lo_put",
    "pg_terminate_backend",
    "pg_cancel_backend",
    "pg_reload_conf",
    "pg_rotate_logfile",
    "pg_switch_wal",
    "pg_promote",
    "pg_file_write",
    "pg_file_rename",
    "pg_file_unlink",
    "set_config",
    "dblink",
    "dblink_exec",
    "dblink_connect",
    "dblink_open",
    "dblink_send_query",
    "query_to_xml",
    "query_to_xmlschema",
    "query_to_xml_and_xmlschema",
    "cursor_to_xml",
    "cursor_to_xmlschema",
    "table_to_xml",
    "table_to_xml_and_xmlschema",
    "schema_to_xml",
    "schema_to_xml_and_xmlschema",
    "database_to_xml",
    "database_to_xml_and_xmlschema",
    "pg_advisory_lock",
    "pg_advisory_xact_lock",
    "pg_advisory_lock_shared",
    "pg_try_advisory_lock",
    "pg_create_restore_point",
    "pg_create_logical_replication_slot",
    "pg_create_physical_replication_slot",
    "pg_drop_replication_slot",
    "pg_logical_emit_message",
    "pg_notify",
    "txid_current",
    "pg_current_xact_id",
  ],
  sqlite: ["load_extension", "readfile", "writefile", "edit", "fts3_tokenizer", "sqlite_dbpage"],
};

/** PRAGMAs that only read. Any PRAGMA with "=" is rejected. */
const READ_PRAGMAS = new Set([
  "table_info",
  "table_xinfo",
  "table_list",
  "index_list",
  "index_info",
  "index_xinfo",
  "foreign_key_list",
  "foreign_key_check",
  "database_list",
  "collation_list",
  "function_list",
  "module_list",
  "pragma_list",
  "compile_options",
  "page_count",
  "page_size",
  "freelist_count",
  "user_version",
  "schema_version",
  "application_id",
  "encoding",
  "journal_mode",
  "integrity_check",
  "quick_check",
  "foreign_keys",
  "auto_vacuum",
  "cache_size",
  "data_version",
  "max_page_count",
]);

const DML_KEYWORDS = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT"]);
const DDL_KEYWORDS = new Set(["CREATE", "ALTER", "DROP", "TRUNCATE", "GRANT", "REVOKE"]);

function blocked(message: string, hint?: string): SafeSqlError {
  return new SafeSqlError("BLOCKED", message, hint);
}

/** Analyze one SQL statement. Throws BLOCKED for anything that is never allowed. */
export function analyzeSql(input: string, dialect: Dialect): Analysis {
  if (!input?.trim()) throw new SafeSqlError("BAD_INPUT", "The SQL is empty.");
  let statements: ReturnType<typeof splitStatements>;
  try {
    statements = splitStatements(input, dialect);
  } catch (err) {
    if (err instanceof LexError) throw new SafeSqlError("BAD_INPUT", `Could not read the SQL: ${err.message}`);
    throw err;
  }
  if (statements.length === 0) throw new SafeSqlError("BAD_INPUT", "The SQL only contains comments.");
  if (statements.length > 1)
    throw blocked(
      `Only one statement per call is allowed, found ${statements.length}.`,
      "Send each statement in its own call. This prevents a harmless SELECT from smuggling in a second statement.",
    );
  const { text, tokens } = statements[0]!;
  const identifiers = new Set<string>();
  for (const t of tokens) {
    if (t.type === "word" || t.type === "ident") identifiers.add((t.type === "word" ? t.text : t.value).toLowerCase());
  }
  checkFunctions(tokens, dialect);
  const base = { sql: text, tokens, identifiers };
  return { ...base, ...classify(tokens, dialect) };
}

function checkFunctions(tokens: Token[], dialect: Dialect) {
  const deny = BLOCKED_FUNCTIONS[dialect];
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i]!;
    const next = tokens[i + 1]!;
    if ((t.type === "word" || t.type === "ident") && next.text === "(") {
      const name = (t.type === "word" ? t.text : t.value).toLowerCase();
      if (deny.includes(name) || (dialect === "postgres" && name.startsWith("dblink")))
        throw blocked(`Function ${name}() is blocked: it has effects outside the query or runs SQL that cannot be checked.`);
    }
  }
}

type Classified = Omit<Analysis, "sql" | "tokens" | "identifiers">;

function words(tokens: Token[]): Token[] {
  return tokens.filter((t) => t.type === "word");
}

function classify(tokens: Token[], dialect: Dialect): Classified {
  const first = tokens[0]!;
  if (first.type === "punct" && first.text === "(") {
    // "(SELECT ...) UNION (SELECT ...)"
    const inner = tokens.find((t) => t.type === "word");
    if (inner && inner.value === "SELECT") return readOrEscalate(tokens, "SELECT");
  }
  if (first.type !== "word") throw new SafeSqlError("BAD_INPUT", `The statement starts with "${first.text}", expected a SQL keyword.`);
  const verb = first.value;

  if (ALWAYS_BLOCKED[verb]) {
    throw blocked(`${verb} is not allowed: ${ALWAYS_BLOCKED[verb]}.`);
  }
  if (verb === "EXPLAIN") return classifyExplain(tokens, dialect);
  if (verb === "PRAGMA") return classifyPragma(tokens, dialect);
  if (verb === "WITH") {
    const main = tokens.find(
      (t, i) =>
        i > 0 && t.depth === 0 && t.type === "word" && (READ_VERBS.has(t.value) || WRITE_VERBS.has(t.value) || t.value === "SELECT"),
    );
    if (!main) throw new SafeSqlError("BAD_INPUT", "WITH clause without a main SELECT/INSERT/UPDATE/DELETE.");
    if (WRITE_VERBS.has(main.value)) return dml(tokens, main.value);
    return readOrEscalate(tokens, "SELECT");
  }
  if (READ_VERBS.has(verb)) {
    if (verb === "SHOW" && dialect === "sqlite") throw new SafeSqlError("BAD_INPUT", "SQLite has no SHOW command.");
    return readOrEscalate(tokens, verb);
  }
  if (WRITE_VERBS.has(verb)) return dml(tokens, verb);
  if (DDL_VERBS.has(verb)) return ddl(tokens, verb, dialect);
  const known = [...READ_VERBS, ...WRITE_VERBS, ...DDL_VERBS, "WITH", "EXPLAIN", ...(dialect === "sqlite" ? ["PRAGMA"] : [])];
  const close = suggest(verb, known, 1);
  throw new SafeSqlError(
    "BAD_INPUT",
    `Unknown or unsupported statement "${first.text}".`,
    close.length ? `Did you mean ${close[0]}?` : "Reads start with SELECT or WITH.",
  );
}

/** A read verb whose body still contains DML or locking clauses is not a read. */
function readOrEscalate(tokens: Token[], verb: string): Classified {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type !== "word") continue;
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    if (t.value === "UPDATE" && prev?.type === "word" && (prev.value === "FOR" || prev.value === "NO" || prev.value === "KEY")) {
      throw blocked("SELECT ... FOR UPDATE/SHARE takes row locks and is not allowed in read queries.");
    }
    if ((t.value === "SHARE" || t.value === "KEY") && prev?.value === "FOR")
      throw blocked("SELECT ... FOR SHARE takes row locks and is not allowed in read queries.");
    if (DML_KEYWORDS.has(t.value)) {
      return dml(tokens, t.value);
    }
    if (DDL_KEYWORDS.has(t.value)) {
      throw blocked(`Found ${t.value} inside a ${verb} statement.`, "Send schema changes as their own statement.");
    }
    if (t.value === "INTO" && t.depth === 0 && verb === "SELECT" && !tokens.slice(0, i).some((x) => x.value === "INSERT"))
      throw blocked("SELECT ... INTO creates a table; use CREATE TABLE ... AS in admin mode instead.");
    if (t.value === "REPLACE" && next?.text !== "(") return dml(tokens, "REPLACE");
  }
  return { kind: "read", verb };
}

function targetAfter(tokens: Token[], i: number): string | undefined {
  const parts: string[] = [];
  let j = i;
  while (j < tokens.length) {
    const t = tokens[j]!;
    if (t.type === "word" || t.type === "ident") {
      parts.push(t.type === "word" ? t.text : t.value);
      if (tokens[j + 1]?.text === ".") {
        j += 2;
        continue;
      }
      break;
    }
    break;
  }
  return parts.length ? parts.join(".") : undefined;
}

const SKIP_BEFORE_TARGET = new Set(["OR", "ROLLBACK", "ABORT", "REPLACE", "FAIL", "IGNORE", "INTO", "FROM", "ONLY", "TOP"]);

function dml(tokens: Token[], verb: string): Classified {
  const idx = tokens.findIndex((t) => t.type === "word" && t.value === verb);
  let j = idx + 1;
  while (j < tokens.length && tokens[j]!.type === "word" && SKIP_BEFORE_TARGET.has(tokens[j]!.value)) j++;
  const target = targetAfter(tokens, j);
  const result: Classified = { kind: "write", verb, target };
  // WHERE checks for every UPDATE/DELETE in the statement (including data-modifying CTEs)
  let hasWhere = true;
  let trivial = false;
  let sawFilterable = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type !== "word" || (t.value !== "UPDATE" && t.value !== "DELETE")) continue;
    const prev = tokens[i - 1];
    if (prev?.type === "word" && (prev.value === "ON" || prev.value === "FOR")) continue; // ON DELETE / FOR UPDATE
    if (t.value === "UPDATE" && prev?.type === "word" && prev.value === "DO") continue; // ON CONFLICT DO UPDATE
    if (t.value === "UPDATE" && prev?.type === "word" && prev.value === "THEN") continue; // MERGE ... THEN UPDATE
    if (t.value === "DELETE" && prev?.type === "word" && prev.value === "THEN") continue;
    sawFilterable = true;
    const where = findClause(tokens, i, "WHERE");
    if (where === -1) {
      hasWhere = false;
      continue;
    }
    if (isTrivialWhere(tokens, where)) trivial = true;
  }
  if (sawFilterable) {
    result.hasWhere = hasWhere;
    result.trivialWhere = trivial;
  }
  return result;
}

/** Index of the first `keyword` at the same depth after position i, before the scope closes. */
function findClause(tokens: Token[], i: number, keyword: string): number {
  let balance = 0;
  for (let j = i + 1; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (t.text === "(") balance++;
    else if (t.text === ")") {
      if (balance === 0) return -1; // the scope that contains the statement closes
      balance--;
    } else if (balance === 0 && t.type === "word" && t.value === keyword) return j;
  }
  return -1;
}

const WHERE_END = new Set(["RETURNING", "ORDER", "LIMIT", "GROUP"]);

function isTrivialWhere(tokens: Token[], whereIdx: number): boolean {
  const clause: Token[] = [];
  let balance = 0;
  for (let j = whereIdx + 1; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (t.text === "(") balance++;
    else if (t.text === ")") {
      if (balance === 0) break;
      balance--;
    } else if (balance === 0 && t.type === "word" && WHERE_END.has(t.value)) break;
    clause.push({ ...t, depth: balance - (t.text === "(" ? 1 : 0) });
  }
  // split on top-level OR
  const operands: Token[][] = [[]];
  for (const t of clause) {
    if (t.depth === 0 && t.type === "word" && t.value === "OR") operands.push([]);
    else operands[operands.length - 1]!.push(t);
  }
  return operands.some((op) => isTautology(op));
}

function isTautology(operand: Token[]): boolean {
  let toks = operand;
  // strip wrapping parentheses
  while (toks.length >= 2 && toks[0]!.text === "(" && toks[toks.length - 1]!.text === ")") toks = toks.slice(1, -1);
  if (toks.length === 0) return false;
  const text = toks.map((t) => (t.type === "word" ? t.value : t.text)).join(" ");
  if (text === "TRUE" || text === "NOT FALSE" || /^[1-9]\d*$/.test(text) || text === "'t'") return true;
  const eq = toks.findIndex((t) => t.text === "=" || t.text === "<>" || t.text === "!=" || t.value === "IS");
  if (eq <= 0) return false;
  const left = toks
    .slice(0, eq)
    .map((t) => t.text)
    .join(" ");
  const right = toks
    .slice(eq + 1)
    .map((t) => t.text)
    .join(" ");
  const op = toks[eq]!.text;
  if (op === "=" && left === right) return true;
  if ((op === "<>" || op === "!=") && /^\d+$/.test(left) && /^\d+$/.test(right) && left !== right) return true;
  return false;
}

function ddl(tokens: Token[], verb: string, dialect: Dialect): Classified {
  const w = words(tokens);
  const objectWords: string[] = [];
  for (const t of w.slice(1, 6)) {
    if (
      [
        "OR",
        "REPLACE",
        "TEMP",
        "TEMPORARY",
        "UNIQUE",
        "UNLOGGED",
        "IF",
        "NOT",
        "EXISTS",
        "MATERIALIZED",
        "GLOBAL",
        "LOCAL",
        "RECURSIVE",
        "VIRTUAL",
      ].includes(t.value)
    )
      continue;
    objectWords.push(t.value);
    break;
  }
  const object = objectWords[0] ?? "";
  if (verb === "ALTER" && (object === "SYSTEM" || object === "DEFAULT"))
    throw blocked(`ALTER ${object} is not allowed: it changes server or default privileges.`);
  if (BLOCKED_OBJECTS.has(object))
    throw blocked(
      `${verb} ${object} is not allowed.`,
      "Only tables, views, indexes, sequences, types, triggers and functions can be changed.",
    );
  if (verb === "TRUNCATE") {
    let j = 1;
    while (tokens[j]?.type === "word" && (tokens[j]!.value === "TABLE" || tokens[j]!.value === "ONLY")) j++;
    return { kind: "ddl", verb, target: targetAfter(tokens, j), destructive: true };
  }
  if (verb === "COMMENT" || verb === "REFRESH" || verb === "ANALYZE" || verb === "REINDEX") {
    return { kind: "ddl", verb, target: verb === "COMMENT" ? undefined : targetAfter(tokens, 1) };
  }
  if (tokens.some((t) => t.type === "word" && t.value === "CONCURRENTLY"))
    throw blocked("CONCURRENTLY cannot run inside a transaction, so it cannot be previewed or rolled back.");
  if (dialect === "postgres" && verb === "CREATE" && (object === "FUNCTION" || object === "PROCEDURE" || object === "TRIGGER")) {
    // allowed in admin mode; code inside cannot be inspected, so treat as destructive
    return { kind: "ddl", verb: `${verb} ${object}`, destructive: true };
  }
  let j = 1;
  while (
    j < tokens.length &&
    tokens[j]!.type === "word" &&
    [
      "OR",
      "REPLACE",
      "TEMP",
      "TEMPORARY",
      "UNIQUE",
      "UNLOGGED",
      "IF",
      "NOT",
      "EXISTS",
      "MATERIALIZED",
      "GLOBAL",
      "LOCAL",
      "VIRTUAL",
      object,
    ].includes(tokens[j]!.value)
  )
    j++;
  const target = targetAfter(tokens, j);
  const destructive =
    verb === "DROP" || verb === "TRUNCATE" || (verb === "ALTER" && w.some((t) => t.value === "DROP" || t.value === "RENAME"));
  return { kind: "ddl", verb: object ? `${verb} ${object}` : verb, target, destructive };
}

function classifyPragma(tokens: Token[], dialect: Dialect): Classified {
  if (dialect !== "sqlite") throw new SafeSqlError("BAD_INPUT", "PRAGMA is SQLite only.");
  if (tokens.some((t) => t.text === "="))
    throw blocked("PRAGMA assignments are not allowed: they can disable safety settings.", "Read-only pragmas such as table_info(x) work.");
  const nameTok = tokens[1]?.type === "word" && tokens[2]?.text === "." ? tokens[3] : tokens[1];
  const name = (nameTok?.text ?? "").toLowerCase();
  if (!READ_PRAGMAS.has(name))
    throw blocked(`PRAGMA ${name} is not on the read-only allowlist.`, `Allowed: ${[...READ_PRAGMAS].slice(0, 12).join(", ")}, ...`);
  return { kind: "read", verb: "PRAGMA" };
}

function classifyExplain(tokens: Token[], dialect: Dialect): Classified {
  let i = 1;
  let analyze = false;
  const optionWords = new Set(["ANALYZE", "ANALYSE", "VERBOSE", "QUERY", "PLAN"]);
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t.type === "word" && optionWords.has(t.value)) {
      if (t.value === "ANALYZE" || t.value === "ANALYSE") analyze = true;
      i++;
      continue;
    }
    if (t.text === "(" && dialect === "postgres") {
      // option list
      let j = i + 1;
      while (j < tokens.length && tokens[j]!.text !== ")") {
        const o = tokens[j]!;
        if (o.type === "word" && (o.value === "ANALYZE" || o.value === "ANALYSE")) {
          const v = tokens[j + 1];
          analyze = !(v && v.type === "word" && (v.value === "FALSE" || v.value === "OFF"));
        }
        j++;
      }
      i = j + 1;
      continue;
    }
    break;
  }
  const inner = tokens.slice(i).map((t) => ({ ...t }));
  if (!inner.length) throw new SafeSqlError("BAD_INPUT", "EXPLAIN needs a statement to explain.");
  const innerClass = classify(inner, dialect);
  if (innerClass.kind !== "read" && analyze) return { ...innerClass, verb: `EXPLAIN ANALYZE ${innerClass.verb}`, explainAnalyze: true };
  return { kind: "read", verb: "EXPLAIN", explainAnalyze: analyze };
}

/** Remove a trailing semicolon and whitespace. */
export function stripTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;\s*$/, "").trim();
}
