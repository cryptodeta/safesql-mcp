import { describe, expect, it } from "vitest";
import { splitStatements, tokenize } from "../src/lexer.js";

describe("tokenize", () => {
  it("skips line and nested block comments", () => {
    const t = tokenize("SELECT 1 -- DROP TABLE x\n /* a /* nested */ DELETE */ FROM t");
    expect(t.map((x) => x.value)).toEqual(["SELECT", "1", "FROM", "T"]);
  });

  it("keeps strings, escaped quotes and E-strings intact", () => {
    const t = tokenize("SELECT 'it''s; DROP', E'a\\'; b' FROM t", "postgres");
    expect(t.filter((x) => x.type === "string").map((x) => x.text)).toEqual(["'it''s; DROP'", "E'a\\'; b'"]);
    expect(t.some((x) => x.type === "semicolon")).toBe(false);
  });

  it("handles dollar quoting and parameters in PostgreSQL", () => {
    const t = tokenize("SELECT $$; DELETE$$, $tag$x;y$tag$, $1 FROM t", "postgres");
    expect(t.filter((x) => x.type === "string")).toHaveLength(2);
    expect(t.filter((x) => x.type === "param").map((x) => x.text)).toEqual(["$1"]);
  });

  it("reads quoted identifiers per dialect", () => {
    const s = tokenize('SELECT "a""b", `c`, [d e] FROM t', "sqlite");
    expect(s.filter((x) => x.type === "ident").map((x) => x.value)).toEqual(['a"b', "c", "d e"]);
    const p = tokenize("SELECT arr[1], data ? 'k' FROM t", "postgres");
    expect(p.filter((x) => x.type === "ident")).toHaveLength(0);
    expect(p.filter((x) => x.type === "param")).toHaveLength(0);
  });

  it("tracks parenthesis depth", () => {
    const t = tokenize("SELECT (a + (b)) FROM t");
    expect(t.find((x) => x.text === "b")!.depth).toBe(2);
    expect(t.find((x) => x.value === "FROM")!.depth).toBe(0);
  });

  it("throws on unterminated strings and comments", () => {
    expect(() => tokenize("SELECT 'abc")).toThrow(/Unterminated/);
    expect(() => tokenize("SELECT /* abc")).toThrow(/Unterminated/);
    expect(() => tokenize("SELECT $x$ abc", "postgres")).toThrow(/Unterminated/);
  });
});

describe("splitStatements", () => {
  it("splits on top-level semicolons only", () => {
    expect(splitStatements("SELECT ';'; SELECT 2;").map((s) => s.text)).toEqual(["SELECT ';'", "SELECT 2"]);
  });

  it("keeps trigger bodies together", () => {
    const sql = "CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET x = 1; INSERT INTO c VALUES (CASE WHEN 1 THEN 2 END); END";
    expect(splitStatements(sql)).toHaveLength(1);
  });

  it("ignores empty statements and comments", () => {
    expect(splitStatements(" ; -- hi\n ;")).toHaveLength(0);
  });
});
