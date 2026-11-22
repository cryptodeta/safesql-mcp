/**
 * A small SQL tokenizer that understands the parts of SQLite and PostgreSQL syntax that matter for
 * safety: comments (nested block comments), single-quoted and E'' strings, quoted identifiers ("", ``, []),
 * dollar-quoted strings ($tag$...$tag$), numbers, parameters ($1, ?, :name) and punctuation.
 */
export type TokenType = "word" | "ident" | "string" | "number" | "param" | "punct" | "semicolon";

export interface Token {
  type: TokenType;
  /** Raw text. For words this is the original spelling. */
  text: string;
  /** Uppercased text for words, unquoted name for quoted identifiers. */
  value: string;
  start: number;
  end: number;
  /** Parenthesis depth at the token. */
  depth: number;
}

const WORD_START = /[A-Za-z_\u0080-\uffff]/;
const WORD_CHAR = /[A-Za-z0-9_$\u0080-\uffff]/;

export class LexError extends Error {}

export type Dialect = "sqlite" | "postgres";

export function tokenize(sql: string, dialect: Dialect = "sqlite"): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let depth = 0;
  const n = sql.length;
  const push = (type: TokenType, start: number, end: number, value?: string) => {
    const text = sql.slice(start, end);
    tokens.push({ type, text, value: value ?? (type === "word" ? text.toUpperCase() : text), start, end, depth });
  };
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "-" && next === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (c === "/" && next === "*") {
      let level = 1;
      let j = i + 2;
      while (j < n && level > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          level++;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          level--;
          j += 2;
        } else j++;
      }
      if (level > 0) throw new LexError("Unterminated /* comment.");
      i = j;
      continue;
    }
    // E'...' strings with backslash escapes (PostgreSQL), X'..' blobs, N'..', B'..'
    if (/[eExXnNbBuU]/.test(c) && next === "'") {
      const backslash = c === "e" || c === "E";
      const end = scanQuoted(sql, i + 1, "'", backslash);
      push("string", i, end);
      i = end;
      continue;
    }
    if (c === "'") {
      const end = scanQuoted(sql, i, "'", false);
      push("string", i, end);
      i = end;
      continue;
    }
    if (c === '"' || (c === "`" && dialect === "sqlite")) {
      const end = scanQuoted(sql, i, c, false);
      push("ident", i, end, sql.slice(i + 1, end - 1).replaceAll(c + c, c));
      i = end;
      continue;
    }
    if (c === "[" && dialect === "sqlite") {
      const close = sql.indexOf("]", i);
      if (close === -1) throw new LexError("Unterminated [identifier].");
      push("ident", i, close + 1, sql.slice(i + 1, close));
      i = close + 1;
      continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        if (close === -1) throw new LexError(`Unterminated dollar-quoted string ${tag}.`);
        push("string", i, close + tag.length);
        i = close + tag.length;
        continue;
      }
      const p = /^\$\d+/.exec(sql.slice(i));
      if (p) {
        push("param", i, i + p[0].length);
        i += p[0].length;
        continue;
      }
    }
    if (c === "?" && dialect === "sqlite") {
      let j = i + 1;
      while (j < n && /\d/.test(sql[j]!)) j++;
      push("param", i, j);
      i = j;
      continue;
    }
    if ((c === ":" || c === "@") && next && WORD_START.test(next) && sql[i - 1] !== ":") {
      let j = i + 1;
      while (j < n && WORD_CHAR.test(sql[j]!)) j++;
      push("param", i, j);
      i = j;
      continue;
    }
    if (/\d/.test(c) || (c === "." && next && /\d/.test(next))) {
      const m = /^(0x[0-9a-fA-F_]+|\d[\d_]*(\.\d*)?([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)/.exec(sql.slice(i))!;
      push("number", i, i + m[0].length);
      i += m[0].length;
      continue;
    }
    if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < n && WORD_CHAR.test(sql[j]!)) j++;
      push("word", i, j);
      i = j;
      continue;
    }
    if (c === ";") {
      push("semicolon", i, i + 1);
      i++;
      continue;
    }
    if (c === "(") {
      push("punct", i, i + 1);
      depth++;
      i++;
      continue;
    }
    if (c === ")") {
      depth = Math.max(0, depth - 1);
      push("punct", i, i + 1);
      i++;
      continue;
    }
    // multi-char operators
    const op = /^(::|<>|!=|<=|>=|\|\||->>|->|=>|#>>|#>|@>|<@)/.exec(sql.slice(i));
    if (op) {
      push("punct", i, i + op[0].length);
      i += op[0].length;
      continue;
    }
    push("punct", i, i + 1);
    i++;
  }
  return tokens;
}

function scanQuoted(sql: string, start: number, quote: string, backslash: boolean): number {
  let j = start + 1;
  while (j < sql.length) {
    const ch = sql[j];
    if (backslash && ch === "\\") {
      j += 2;
      continue;
    }
    if (ch === quote) {
      if (sql[j + 1] === quote) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  throw new LexError(`Unterminated ${quote === "'" ? "string literal" : "quoted identifier"}.`);
}

/** Split into statements on top-level semicolons, keeping CREATE TRIGGER ... BEGIN ... END bodies together. */
export function splitStatements(sql: string, dialect: Dialect = "sqlite"): { text: string; tokens: Token[] }[] {
  const tokens = tokenize(sql, dialect);
  const out: { text: string; tokens: Token[] }[] = [];
  let cur: Token[] = [];
  let blockDepth = 0;
  const flush = () => {
    if (cur.length) {
      out.push({ text: sql.slice(cur[0]!.start, cur[cur.length - 1]!.end), tokens: cur });
    }
    cur = [];
  };
  for (const t of tokens) {
    if (t.type === "semicolon" && blockDepth === 0) {
      flush();
      continue;
    }
    if (t.type === "word") {
      const isTrigger = cur.some((x) => x.type === "word" && x.value === "TRIGGER");
      if (t.value === "BEGIN" && isTrigger) blockDepth++;
      else if (t.value === "CASE" && blockDepth > 0) blockDepth++;
      else if (t.value === "END" && blockDepth > 0) blockDepth--;
    }
    cur.push(t);
  }
  flush();
  return out;
}
