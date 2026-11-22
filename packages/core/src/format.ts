export type ResultFormat = "table" | "markdown" | "csv" | "json";

export function cellText(v: unknown, maxChars: number): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "object" && v !== null && "$blob" in v) return `<blob ${(v as { $blob: number }).$blob} bytes>`;
  let s = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (s.length > maxChars) s = `${s.slice(0, maxChars)}…(+${s.length - maxChars} chars)`;
  return s;
}

function compactCell(v: unknown, maxChars: number): string {
  return cellText(v, maxChars).replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/\|/g, "\\|");
}

function csvCell(v: unknown, maxChars: number): string {
  if (v === null || v === undefined) return "";
  const s = cellText(v, maxChars);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function jsonValue(v: unknown, maxChars: number): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string" && v.length <= maxChars) return v;
  return cellText(v, maxChars);
}

/** Render rows. "table" is the token-efficient default: a header line and one pipe-separated line per row. */
export function renderRows(columns: string[], rows: unknown[][], format: ResultFormat, maxCellChars: number): string {
  switch (format) {
    case "csv":
      return [columns.map((c) => csvCell(c, 10_000)).join(","), ...rows.map((r) => r.map((v) => csvCell(v, maxCellChars)).join(","))].join(
        "\n",
      );
    case "json":
      return JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, jsonValue(r[i], maxCellChars)]))));
    case "markdown":
      return [
        `| ${columns.map((c) => compactCell(c, 200)).join(" | ")} |`,
        `|${columns.map(() => "---").join("|")}|`,
        ...rows.map((r) => `| ${r.map((v) => compactCell(v, maxCellChars)).join(" | ")} |`),
      ].join("\n");
    default:
      return [columns.join(" | "), ...rows.map((r) => r.map((v) => compactCell(v, maxCellChars)).join(" | "))].join("\n");
  }
}

/** Full-fidelity serializers for export files (no cell truncation). */
export function serializeExport(columns: string[], rows: unknown[][], format: "csv" | "json" | "jsonl" | "markdown"): string {
  const big = Number.MAX_SAFE_INTEGER;
  if (format === "jsonl")
    return `${rows.map((r) => JSON.stringify(Object.fromEntries(columns.map((c, i) => [c, jsonValue(r[i], big)])))).join("\n")}\n`;
  if (format === "json")
    return `${JSON.stringify(
      rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, jsonValue(r[i], big)]))),
      null,
      2,
    )}\n`;
  return `${renderRows(columns, rows, format === "markdown" ? "markdown" : "csv", big)}\n`;
}

export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** Shorten long type names for compact schema output. */
export function shortType(t: string): string {
  return t
    .replace(/character varying/i, "varchar")
    .replace(/^character\((\d+)\)$/i, "char($1)")
    .replace(/timestamp(\(\d\))? without time zone/i, "timestamp")
    .replace(/timestamp(\(\d\))? with time zone/i, "timestamptz")
    .replace(/time without time zone/i, "time")
    .replace(/double precision/i, "float8")
    .replace(/^integer$/i, "int")
    .replace(/^INTEGER$/, "int")
    .replace(/^boolean$/i, "bool")
    .toLowerCase();
}
