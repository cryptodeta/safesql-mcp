# Examples

- `shop.db` - a small online shop in SQLite: 200 customers, 28 products, 1,000 orders, 2,540 order items,
  40 API keys and a `customer_revenue` view. Rebuild it with `npm run demo` or
  `npx -y safesql-mcp demo shop.db --force`. The data is generated with a fixed seed, so it is identical
  everywhere.
- `shop-postgres.sql` - the same data for PostgreSQL:
  `createdb shop && psql shop -f examples/shop-postgres.sql`
  (or `npx -y safesql-mcp demo --sql postgres | psql "$DATABASE_URL"`).
- `safesql.config.json` - a config file with several databases, policies and a saved query.

Things to ask your assistant once it is connected to `shop.db`:

- "Give me a tour of this database." (uses the `explore_database` prompt)
- "Which five customers spent the most on delivered orders?"
- "Show me the order statuses by month for 2026 as a table."
- "Why is `SELECT * FROM order_items WHERE product_id = 7` slow and how would you fix it?"
- "Check the data quality of the orders table."
- "Draw the relationships between the tables."
- "Export all delivered orders to delivered.csv."

Notice that `customers.password_hash` and `api_keys.token` come back as `[redacted]`, and that any attempt to
change data is refused unless the server was started with `--write`.
