import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { Engine } from "./types.js";

/** Deterministic PRNG so the demo data is identical everywhere. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = [
  "Ava",
  "Liam",
  "Noah",
  "Emma",
  "Olivia",
  "Arjun",
  "Fatima",
  "Yuki",
  "Mateo",
  "Zara",
  "Chen",
  "Amara",
  "Lucas",
  "Sofia",
  "Omar",
  "Nia",
  "Ivan",
  "Leila",
  "Kofi",
  "Mei",
];
const LAST = [
  "Smith",
  "Khan",
  "Garcia",
  "Tanaka",
  "Okafor",
  "Rossi",
  "Silva",
  "Ahmed",
  "Novak",
  "Kim",
  "Haddad",
  "Müller",
  "Nguyen",
  "Patel",
  "Costa",
];
const COUNTRIES = ["US", "GB", "DE", "IN", "BD", "JP", "BR", "NG", "FR", "CA", "AU", "ES"];
const CATEGORIES: Record<string, string[]> = {
  Electronics: [
    "USB-C Cable",
    "Wireless Mouse",
    "Mechanical Keyboard",
    "27in Monitor",
    "Webcam HD",
    "Bluetooth Speaker",
    "Noise-Cancelling Headphones",
    "Power Bank",
  ],
  Books: ["SQL Basics", "Data Modeling Patterns", "The Query Optimizer", "Practical Statistics", "Designing Data Apps"],
  Home: ["Coffee Mug", "Desk Lamp", "Plant Pot", "Throw Blanket", "Wall Clock", "Notebook Set"],
  Outdoors: ["Water Bottle", "Trail Backpack", "Camping Mug", "Rain Jacket", "Headlamp"],
  Office: ["Standing Desk Mat", "Ergonomic Chair Cushion", "Cable Organizer", "Whiteboard Markers"],
};
const STATUSES = ["delivered", "delivered", "delivered", "shipped", "processing", "cancelled", "refunded"];

function q(v: string | number | null): string {
  if (v === null) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${v.replaceAll("'", "''")}'`;
}

function day(base: number, offsetDays: number): string {
  return new Date(base + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/** DDL + INSERT statements for a small online shop: customers, products, orders, order_items, api_keys. */
export function demoStatements(engine: Engine): string[] {
  const r = rng(42);
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)]!;
  const pk = engine === "postgres" ? "integer PRIMARY KEY" : "INTEGER PRIMARY KEY";
  const money = engine === "postgres" ? "numeric(10,2)" : "REAL";
  const ts = engine === "postgres" ? "date" : "TEXT";
  const out: string[] = [
    `CREATE TABLE customers (id ${pk}, name text NOT NULL, email text NOT NULL UNIQUE, country char(2) NOT NULL, created_at ${ts} NOT NULL, password_hash text NOT NULL)`,
    `CREATE TABLE products (id ${pk}, name text NOT NULL, category text NOT NULL, price ${money} NOT NULL, in_stock boolean NOT NULL DEFAULT ${engine === "postgres" ? "true" : "1"})`,
    `CREATE TABLE orders (id ${pk}, customer_id integer NOT NULL REFERENCES customers(id), status text NOT NULL DEFAULT 'processing', created_at ${ts} NOT NULL, total ${money} NOT NULL DEFAULT 0)`,
    `CREATE TABLE order_items (order_id integer NOT NULL REFERENCES orders(id), product_id integer NOT NULL REFERENCES products(id), quantity integer NOT NULL CHECK (quantity > 0), unit_price ${money} NOT NULL, PRIMARY KEY (order_id, product_id))`,
    `CREATE TABLE api_keys (id ${pk}, customer_id integer NOT NULL REFERENCES customers(id), label text NOT NULL, token text NOT NULL, created_at ${ts} NOT NULL)`,
    "CREATE INDEX idx_orders_customer ON orders(customer_id)",
    "CREATE INDEX idx_orders_created ON orders(created_at)",
    "CREATE VIEW customer_revenue AS SELECT c.id, c.name, c.country, count(o.id) AS orders, coalesce(sum(o.total), 0) AS revenue FROM customers c LEFT JOIN orders o ON o.customer_id = c.id AND o.status NOT IN ('cancelled', 'refunded') GROUP BY c.id, c.name, c.country",
  ];
  const base = Date.UTC(2025, 0, 1);
  const customers: string[] = [];
  for (let id = 1; id <= 200; id++) {
    const first = pick(FIRST);
    const last = pick(LAST);
    const email = `${first.toLowerCase()}.${last.toLowerCase().replace("ü", "u")}${id}@example.com`;
    const hash = `$2b$10$${Math.floor(r() * 1e16).toString(36)}${Math.floor(r() * 1e16).toString(36)}`;
    customers.push(
      `(${id}, ${q(`${first} ${last}`)}, ${q(email)}, ${q(pick(COUNTRIES))}, ${q(day(base, Math.floor(r() * 400)))}, ${q(hash)})`,
    );
  }
  out.push(`INSERT INTO customers (id, name, email, country, created_at, password_hash) VALUES ${customers.join(", ")}`);
  const products: { id: number; price: number }[] = [];
  const productRows: string[] = [];
  let pid = 1;
  for (const [cat, names] of Object.entries(CATEGORIES)) {
    for (const name of names) {
      const price = Math.round((5 + r() * 195) * 100) / 100;
      products.push({ id: pid, price });
      productRows.push(
        `(${pid}, ${q(name)}, ${q(cat)}, ${price}, ${r() < 0.9 ? (engine === "postgres" ? "true" : 1) : engine === "postgres" ? "false" : 0})`,
      );
      pid++;
    }
  }
  out.push(`INSERT INTO products (id, name, category, price, in_stock) VALUES ${productRows.join(", ")}`);
  const orders: string[] = [];
  const items: string[] = [];
  for (let id = 1; id <= 1000; id++) {
    const customer = 1 + Math.floor(r() ** 1.6 * 200);
    const n = 1 + Math.floor(r() * 4);
    const chosen = new Set<number>();
    let total = 0;
    while (chosen.size < n) chosen.add(1 + Math.floor(r() * products.length));
    for (const p of chosen) {
      const qty = 1 + Math.floor(r() * 3);
      const price = products[p - 1]!.price;
      total += qty * price;
      items.push(`(${id}, ${p}, ${qty}, ${price})`);
    }
    orders.push(
      `(${id}, ${customer}, ${q(pick(STATUSES))}, ${q(day(base, 30 + Math.floor(r() * 640)))}, ${Math.round(total * 100) / 100})`,
    );
  }
  out.push(`INSERT INTO orders (id, customer_id, status, created_at, total) VALUES ${orders.join(", ")}`);
  for (let i = 0; i < items.length; i += 500)
    out.push(`INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ${items.slice(i, i + 500).join(", ")}`);
  const keys: string[] = [];
  for (let id = 1; id <= 40; id++) {
    keys.push(
      `(${id}, ${1 + Math.floor(r() * 200)}, ${q(pick(["default", "ci", "mobile", "zapier"]))}, ${q(`sk_live_${Math.floor(r() * 1e16).toString(36)}${Math.floor(r() * 1e16).toString(36)}`)}, ${q(day(base, Math.floor(r() * 600)))})`,
    );
  }
  out.push(`INSERT INTO api_keys (id, customer_id, label, token, created_at) VALUES ${keys.join(", ")}`);
  return out;
}

/** Create the demo SQLite database at `path` (replacing it when `overwrite`). */
export function createDemoDatabase(path: string, overwrite = false): { path: string; tables: number } {
  if (existsSync(path)) {
    if (!overwrite) throw new Error(`${path} already exists. Pass --force to replace it.`);
    rmSync(path);
  }
  mkdirSync(dirname(path), { recursive: true });
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec("BEGIN");
    for (const s of demoStatements("sqlite")) db.exec(s);
    db.exec("COMMIT");
    db.exec("ANALYZE");
  } finally {
    db.close();
  }
  return { path, tables: 5 };
}
