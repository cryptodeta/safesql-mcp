import { describe, expect, it } from "vitest";
import { DEFAULT_SENSITIVE, maskEmail, Policy, ruleMatches } from "../src/policy.js";

describe("ruleMatches", () => {
  it("matches right-aligned dotted rules with globs", () => {
    expect(ruleMatches("users", ["public", "users"])).toBe(true);
    expect(ruleMatches("public.users", ["public", "users"])).toBe(true);
    expect(ruleMatches("other.users", ["public", "users"])).toBe(false);
    expect(ruleMatches("audit_*", ["main", "audit_log"])).toBe(true);
    expect(ruleMatches("users.pass*", ["public", "users", "password_hash"])).toBe(true);
    expect(ruleMatches("*.ssn", ["public", "people", "ssn"])).toBe(true);
    expect(ruleMatches("a.b.c.d", ["b", "c", "d"])).toBe(false);
    expect(ruleMatches("USERS", ["public", "users"])).toBe(true);
  });
});

describe("Policy", () => {
  const p = new Policy(
    {
      allowTables: ["orders", "customers", "audit.*"],
      denyTables: ["customers_backup"],
      denyColumns: ["customers.password_hash"],
      redactColumns: ["phone", "customers.notes"],
    },
    "postgres",
  );

  it("filters tables by allow and deny lists", () => {
    expect(p.tableAllowed("public", "orders")).toBe(true);
    expect(p.tableAllowed("public", "products")).toBe(false);
    expect(p.tableAllowed("audit", "events")).toBe(true);
    expect(p.restrictive).toBe(true);
    expect(new Policy({}, "sqlite").restrictive).toBe(false);
  });

  it("denies and redacts columns", () => {
    expect(p.columnDenied("public", "customers", "password_hash")).toBe(true);
    expect(p.columnDenied("public", "orders", "password_hash")).toBe(false);
    expect(p.columnRedacted("public", "customers", "phone")).toBe(true);
    expect(p.columnRedacted("public", "customers", "notes")).toBe(true);
    expect(p.columnRedacted("public", "orders", "notes")).toBe(false);
    expect(p.columnRedacted(undefined, undefined, "api_key")).toBe(true);
    expect(new Policy({ redact: "off" }, "sqlite").columnRedacted("main", "t", "api_key")).toBe(false);
  });

  it("finds denied names mentioned in SQL", () => {
    expect(p.lexicalViolation(new Set(["select", "password_hash", "customers"]))).toBe("customers.password_hash");
    expect(p.lexicalViolation(new Set(["customers_backup"]))).toBe("customers_backup");
    expect(p.lexicalViolation(new Set(["orders", "total"]))).toBeUndefined();
  });

  it("checks planner-reported access", () => {
    expect(p.accessViolation(["public.orders"], ["public.orders.total"], "public")).toBeUndefined();
    expect(p.accessViolation(["public.products"], [], "public")).toBe("table public.products");
    expect(p.accessViolation(["customers"], ["customers.password_hash"], "public")).toBe("column customers.password_hash");
    expect(new Policy({ denyTables: ["x"] }, "sqlite").accessViolation(["sqlite_schema"], [], "main")).toBeUndefined();
  });

  it("knows common secret column names", () => {
    for (const n of [
      "password",
      "password_hash",
      "passwd",
      "api_key",
      "apikey",
      "access_token",
      "client_secret",
      "ssn",
      "card_number",
      "cvv",
      "salt",
      "private_key",
    ])
      expect(DEFAULT_SENSITIVE.test(n), n).toBe(true);
    for (const n of ["name", "email", "passenger", "total", "status", "compass"]) expect(DEFAULT_SENSITIVE.test(n), n).toBe(false);
  });

  it("masks emails", () => {
    expect(maskEmail("jane.doe@example.com")).toBe("j***@example.com");
    expect(maskEmail("contact: a@b.io, c.d@e.org")).toBe("contact: a***@b.io, c***@e.org");
    expect(maskEmail(42)).toBe(42);
    expect(new Policy({ maskEmails: true }, "sqlite").isEmailColumn("billing_email")).toBe(true);
  });
});
