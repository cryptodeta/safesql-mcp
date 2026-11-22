import { describe, expect, it } from "vitest";
import { cellText, formatCount, renderRows, serializeExport, shortType } from "../src/format.js";
import { distance, suggest } from "../src/suggest.js";

describe("renderRows", () => {
  const cols = ["id", "note"];
  const rows = [
    [1, "a|b\nc"],
    [2, null],
    [3, { $blob: 12 }],
  ];

  it("table format is compact and escapes separators", () => {
    expect(renderRows(cols, rows, "table", 100)).toBe("id | note\n1 | a\\|b\\nc\n2 | NULL\n3 | <blob 12 bytes>");
  });

  it("markdown, csv and json", () => {
    expect(renderRows(cols, rows, "markdown", 100).split("\n")[1]).toBe("|---|---|");
    expect(renderRows(cols, [[1, 'say "hi", ok']], "csv", 100)).toBe('id,note\n1,"say ""hi"", ok"');
    expect(JSON.parse(renderRows(cols, rows, "json", 100))).toEqual([
      { id: 1, note: "a|b\nc" },
      { id: 2, note: null },
      { id: 3, note: "<blob 12 bytes>" },
    ]);
  });

  it("truncates long cells", () => {
    expect(cellText("x".repeat(50), 10)).toBe(`${"x".repeat(10)}…(+40 chars)`);
  });

  it("serializes exports without truncation", () => {
    const long = "y".repeat(1000);
    expect(serializeExport(["a"], [[long]], "csv")).toBe(`a\n${long}\n`);
    expect(serializeExport(["a"], [[1], [2]], "jsonl")).toBe('{"a":1}\n{"a":2}\n');
    expect(JSON.parse(serializeExport(["a"], [[1]], "json"))).toEqual([{ a: 1 }]);
  });
});

describe("helpers", () => {
  it("formats counts", () => {
    expect(formatCount(null)).toBe("?");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(9999)).toBe("9999");
    expect(formatCount(25_400)).toBe("25k");
    expect(formatCount(2_500_000)).toBe("2.5M");
  });

  it("shortens type names", () => {
    expect(shortType("character varying(20)")).toBe("varchar(20)");
    expect(shortType("timestamp with time zone")).toBe("timestamptz");
    expect(shortType("character(2)")).toBe("char(2)");
    expect(shortType("INTEGER")).toBe("int");
  });

  it("suggests close names", () => {
    expect(distance("orders", "ordrs")).toBe(1);
    expect(suggest("ordrs", ["orders", "order_items", "customers"])).toEqual(["orders"]);
    expect(suggest("customer", ["customers", "products"])).toEqual(["customers"]);
    expect(suggest("zzz", ["orders"])).toEqual([]);
  });
});
