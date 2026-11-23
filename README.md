# safesql-mcp

**Safe SQL for AI assistants. SQLite and PostgreSQL in one zero-config MCP server, read-only by default.**

[![npm](https://img.shields.io/npm/v/safesql-mcp?logo=npm)](https://www.npmjs.com/package/safesql-mcp)
[![npm downloads](https://img.shields.io/npm/dm/safesql-mcp)](https://www.npmjs.com/package/safesql-mcp)
[![CI](https://github.com/cryptodeta/safesql-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/cryptodeta/safesql-mcp/actions/workflows/ci.yml)
[![Release](https://github.com/cryptodeta/safesql-mcp/actions/workflows/release.yml/badge.svg)](https://github.com/cryptodeta/safesql-mcp/actions/workflows/release.yml)
[![GitHub release](https://img.shields.io/github/v/release/cryptodeta/safesql-mcp)](https://github.com/cryptodeta/safesql-mcp/releases)
[![Docker](https://img.shields.io/badge/docker-ghcr.io%2Fcryptodeta%2Fsafesql--mcp-2496ED?logo=docker&logoColor=white)](https://github.com/cryptodeta/safesql-mcp/pkgs/container/safesql-mcp)
![license](https://img.shields.io/badge/license-MIT-blue)
![node](https://img.shields.io/badge/node-%3E%3D22.16-brightgreen)

An [MCP](https://modelcontextprotocol.io) server that lets Claude, Cursor, VS Code, Windsurf and other AI
tools explore and query your databases without being able to damage them. Point it at a SQLite file or a
`postgres://` URL and you are done.

```text
You:    Which countries bring in the most revenue from delivered orders?
Claude: (calls query)
        5 rows in 3 ms
        country | customers | revenue
        FR | 19 | 32265.61
        DE | 17 | 30375.97
        BR | 19 | 26634.39
        ...
```

## Install

Requires Node.js 22.16 or newer. Published on [npmjs.org](https://www.npmjs.com/package/safesql-mcp),
[GitHub Packages](https://github.com/cryptodeta/safesql-mcp/pkgs/npm/safesql-mcp) and [ghcr.io](https://github.com/cryptodeta/safesql-mcp/pkgs/container/safesql-mcp);
every [GitHub Release](https://github.com/cryptodeta/safesql-mcp/releases) also has the npm tarball attached.

```bash
# Run without installing (npmjs.org)
npx -y safesql-mcp --help

# Or install globally
npm i -g safesql-mcp
safesql-mcp --version

# GitHub Packages (needs a GitHub token with read:packages, even for public packages)
npm login --scope=@cryptodeta --auth-type=legacy --registry=https://npm.pkg.github.com
npm i -g @cryptodeta/safesql-mcp --registry=https://npm.pkg.github.com

# Docker (Streamable HTTP on http://localhost:3000/mcp)
docker run -d -p 3000:3000 -e SAFESQL_HTTP_TOKEN=change-me \
  -e DATABASE_URL=postgres://reader:secret@host:5432/app ghcr.io/cryptodeta/safesql-mcp
```

Add it to your AI app (more clients and options in [Client configuration](#client-configuration)):

**Claude Desktop** (`claude_desktop_config.json`) and **Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "safesql": { "command": "npx", "args": ["-y", "safesql-mcp", "/absolute/path/to/app.db"] }
  }
}
```

**VS Code** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "safesql": { "type": "stdio", "command": "npx", "args": ["-y", "safesql-mcp", "/absolute/path/to/app.db"] }
  }
}
```

Or let it write the config for you: `npx -y safesql-mcp init claude /absolute/path/to/app.db` (also `cursor`, `vscode`, `windsurf`,
`claude-code`, `all`).

## Why this one

The official Postgres and SQLite reference servers were archived in 2025, and most replacements either
handle a single engine, dump large JSON blobs into the context window, or trust the model not to run
`UPDATE` without a `WHERE`. safesql-mcp is built around three ideas:

- **Safety is enforced by the database, not by hope.** Reads run on a SQLite connection opened read-only
  with `query_only`, or inside a PostgreSQL `READ ONLY` transaction with `statement_timeout`. A SQL guard on
  top blocks multi-statement smuggling, `SET`, `COPY`, `DO`, `ATTACH`, file and network functions and more.
  Writes are opt-in, previewed in a rolled-back transaction, and need a confirm token.
- **Token-efficient output.** The whole schema of the demo database (6 tables, keys, types, nullability,
  foreign keys and row counts) is 701 characters. The same schema as `information_schema.columns` JSON is
  31,695 characters (45x more). Results are compact pipe tables with row, byte and cell caps.
- **One drop-in server for several databases.** `npx -y safesql-mcp ./app.db postgres://...` connects both at
  once. No config file, no API keys, no native build step (SQLite uses Node's built-in `node:sqlite`).

## Quickstart (1 minute)

You need Node.js 22.16 or newer.

```bash
npx -y safesql-mcp demo                                   # creates ./safesql-demo.db (a small online shop)
npx -y safesql-mcp init claude ./safesql-demo.db          # or: cursor, vscode, windsurf, claude-code, all
```

Restart the app and ask: _"Give me a tour of this database"_ or _"Which products sell best in Germany?"_

Use your own database instead:

```bash
npx -y safesql-mcp init cursor ./data/app.sqlite
npx -y safesql-mcp init claude "postgres://reader:secret@localhost:5432/app"
npx -y safesql-mcp init all main=./app.db analytics=postgres://reader@db/warehouse
```

Check everything is wired up correctly (connection, read-only enforcement, role privileges):

```bash
npx -y safesql-mcp doctor ./app.db
```

> Prefer running from source? `git clone https://github.com/cryptodeta/safesql-mcp && cd safesql-mcp && npm install && npm run build`,
> then use `node /path/to/safesql-mcp/packages/server/dist/cli.js` wherever this README says `npx -y safesql-mcp`.

## Client configuration

`init` writes these for you (and keeps a `.bak` of the old file). On Windows it uses `"command": "cmd"`
with `"args": ["/c", "npx", "-y", "safesql-mcp", ...]`.

<details open>
<summary><b>Claude Desktop</b></summary>

`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "safesql": { "command": "npx", "args": ["-y", "safesql-mcp", "/absolute/path/to/app.db"] }
  }
}
```
</details>

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add safesql -- npx -y safesql-mcp /absolute/path/to/app.db
```
</details>

<details>
<summary><b>Cursor</b></summary>

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "safesql": {
      "command": "npx",
      "args": ["-y", "safesql-mcp"],
      "env": { "DATABASE_URL": "postgres://reader:secret@localhost:5432/app" }
    }
  }
}
```
</details>

<details>
<summary><b>VS Code</b></summary>

`.vscode/mcp.json`:

```json
{
  "servers": {
    "safesql": { "type": "stdio", "command": "npx", "args": ["-y", "safesql-mcp", "${workspaceFolder}/app.db"] }
  }
}
```
</details>

<details>
<summary><b>Windsurf</b></summary>

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "safesql": { "command": "npx", "args": ["-y", "safesql-mcp", "/absolute/path/to/app.db"] }
  }
}
```
</details>

Tip: keep passwords out of config files by using `env` with `DATABASE_URL` or `SAFESQL_DB_<NAME>`.

## Tools

| Tool              | What it does                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `list_databases`  | Connected databases, engine, mode, limits and policy (credentials hidden)                                                          |
| `list_tables`     | Tables and views with row counts, filter by schema or pattern                                                                      |
| `describe_table`  | Columns, types, PK, FKs, defaults, indexes, "referenced by"; several tables per call                                               |
| `schema_overview` | Entire schema in one compact block within a character budget                                                                       |
| `search_schema`   | Find tables/columns by name or comment, with did-you-mean                                                                          |
| `sample_rows`     | A few (or random) rows, optional columns and filter                                                                                |
| `query`           | One read statement with bind params, row/byte/time caps, `offset` paging, table/markdown/csv/json output, or a saved query by name |
| `explain`         | Query plan plus plain-language hints (full scans, missing indexes, sorts, bad estimates); `analyze=true` for real timings on reads |
| `profile_table`   | Per-column nulls, distinct, min/max/avg, top values and data-quality notes                                                         |
| `relationships`   | Foreign keys as a Mermaid `erDiagram` or a list, optionally around one table                                                       |
| `export_query`    | Save full results to CSV, JSON, JSONL or Markdown inside the export directory                                                      |
| `saved_queries`   | List, save and delete named read queries                                                                                           |
| `audit_log`       | Recent statements, row counts, timings, errors and blocked attempts                                                                |
| `execute`         | Only in write/admin mode: INSERT/UPDATE/DELETE (and DDL in admin mode) with dry run and confirm token                              |

Also: MCP **resources** `safesql://databases`, `safesql://{db}/schema`, `safesql://{db}/table/{table}`, and
**prompts** `explore_database`, `optimize_query`, `data_quality_check`, `safe_change`.

### Sample outputs

`schema_overview` on the demo database:

```text
shop (sqlite, read mode): 6 tables/views. Legend: * = primary key, → = foreign key, ? = nullable, ~n = rows
api_keys ~40: id* int, customer_id int→customers, label text, token text, created_at text
customer_revenue (view): id int?, name text?, country char(2)?, orders any?, revenue any?
customers ~200: id* int, name text, email text, country char(2), created_at text, password_hash text
order_items ~2540: order_id* int→orders, product_id* int→products, quantity int, unit_price real
orders ~1000: id* int, customer_id int→customers, status text, created_at text, total real
products ~28: id* int, name text, category text, price real, in_stock bool
```

Secrets are masked automatically, even when aliased:

```text
2 rows in 0 ms
name | email | password_hash
Lucas Silva | lucas.silva1@example.com | [redacted]
Arjun Kim | arjun.kim2@example.com | [redacted]
Redacted: password_hash
```

`explain` with hints:

```text
SCAN order_items
USE TEMP B-TREE FOR ORDER BY

Hints:
- Full scan of order_items (~2540 rows). If the query filters or joins on a column of order_items, an index on that column avoids reading every row.
- Sorting in a temporary B-tree for ORDER BY. An index whose columns match the ORDER BY order removes this step.
```

A write in `--write` mode (step 1, dry run):

```text
DRY RUN (rolled back, nothing changed): UPDATE would affect 5 rows in shop.
Preview of affected rows (after the change):
id | name | category | price | in_stock
9 | SQL Basics | Books | 102.98 | 1
10 | Data Modeling Patterns | Books | 139.48 | 1
11 | The Query Optimizer | Books | 91.23 | 1
…
To apply it, show this preview to the user and, if they agree, call execute again with the same SQL and confirm="BAowmRSn" (valid 10 min, single use).
```

Errors say what to do next:

```text
Error [BLOCKED]: DELETE without a WHERE clause would change every row of orders.
Hint: Add a WHERE clause. If changing every row is really intended, pass allow_full_table=true (a dry run is still required).

Error [SQL_ERROR]: no such table: ordrs
Hint: Did you mean "orders"?
```

## Safety model

Every statement passes through these layers. Each one alone blocks the common accidents; together they
make the read path safe even if one layer had a bug.

1. **SQL guard** (tokenizer that understands comments, strings, quoted identifiers and dollar quoting):
   exactly one statement per call; classifies it as read, write or DDL; always blocks `SET`/`RESET`,
   transaction control, `COPY`, `DO`, `CALL`, `LOCK`, `ATTACH`/`DETACH`, `VACUUM`, `GRANT`/`REVOKE`,
   `PREPARE`/`EXECUTE`, PRAGMA assignments, `SELECT ... FOR UPDATE`, `SELECT ... INTO`, roles, databases,
   extensions and `ALTER SYSTEM`; blocks functions with side effects or hidden SQL (`pg_read_file`,
   `lo_export`, `dblink`, `set_config`, `query_to_xml`, `pg_terminate_backend`, `load_extension`,
   `writefile`, ...). Data-modifying CTEs and `EXPLAIN ANALYZE <write>` are treated as writes.
2. **Engine-level read-only.** SQLite reads use a separate connection opened with `readOnly: true` plus
   `PRAGMA query_only = ON` and `trusted_schema = OFF`. PostgreSQL reads run in
   `BEGIN TRANSACTION READ ONLY` with `SET LOCAL statement_timeout`, `lock_timeout` and
   `idle_in_transaction_session_timeout`, and take a snapshot before your SQL runs so the transaction cannot
   be switched back to read-write. Every read transaction is rolled back. `doctor` proves this by attempting
   a write on the read path and checking that the database refuses it.
3. **Hard limits.** Rows per page (default 100, `offset` to continue), bytes per response (60 KB), cell
   length (300 chars), and a timeout (15 s). PostgreSQL cancels with `statement_timeout`; SQLite runs in a
   worker thread that is terminated on timeout, so even a runaway recursive CTE stops on time.
4. **Policies.** `--allow-tables`, `--deny-tables` and `--deny-columns` (globs like `audit_*`, `*.ssn`) are
   checked against the query plan, not just the text: SQLite bytecode (`EXPLAIN`) and PostgreSQL
   `EXPLAIN (VERBOSE)` reveal every table and column a query touches, including through views, `SELECT *`,
   CTEs and subqueries. Denied tables and columns are hidden from all schema tools.
5. **Redaction.** Columns that look like secrets (`password`, `token`, `secret`, `api_key`, `ssn`,
   `card_number`, `cvv`, `salt`, ...) are replaced with `[redacted]`, matched by the result column's
   source column, so `SELECT password_hash AS x` is masked too. Add your own with `--redact-columns`, mask
   e-mails with `--mask-emails`, or turn auto-redaction off with `--no-redact`.
6. **Writes are opt-in and two-step.** Start with `--write` (data) or `--admin` (data and schema). The
   `execute` tool first runs the statement in a transaction, reports affected rows and a preview of the
   changed rows (via `RETURNING`), rolls back and returns a single-use token bound to that exact SQL and
   parameters. Only a second call with the token commits. `UPDATE`/`DELETE` need a real `WHERE` (`1=1`,
   `TRUE`, `x = x` and `... OR 1=1` do not count); changes above `--max-affected` (default 1000) are rolled
   back. The `execute` tool is not even registered while every database is read-only.
7. **Audit log.** Every statement, including blocked ones, is appended to `~/.safesql-mcp/audit.jsonl`
   (tool, SQL, row count, affected rows, duration, error). Bind parameter values are never logged.
8. **No credential leaks.** Connection URLs are shown with `***` for the password, and every tool response
   is scrubbed of known passwords.

### Hardening PostgreSQL (recommended)

The server already enforces read-only access, but a dedicated role adds a second, independent layer:

```sql
CREATE ROLE ai_reader LOGIN PASSWORD 'change-me';
GRANT pg_read_all_data TO ai_reader;          -- PostgreSQL 14+; otherwise GRANT SELECT per schema
ALTER ROLE ai_reader SET statement_timeout = '15s';
```

`doctor` warns when the configured role is a superuser or can write to tables.

## Configuration

Databases come from (in order) a config file, command-line arguments, `SAFESQL_DB_<NAME>` variables and
finally `DATABASE_URL`. Names default to the file name or database name; use `name=<url>` to choose.

| Option                       | Env                         | Default                      | Meaning                                          |
| ---------------------------- | --------------------------- | ---------------------------- | ------------------------------------------------ |
| `--write` / `--admin`        | `SAFESQL_MODE`              | read                         | Allow data changes / also schema changes         |
| `--max-rows <n>`             | `SAFESQL_MAX_ROWS`          | 100                          | Rows per query page (max 10,000)                 |
| `--timeout <ms>`             | `SAFESQL_TIMEOUT_MS`        | 15000                        | Statement timeout                                |
| `--max-affected <n>`         | `SAFESQL_MAX_AFFECTED_ROWS` | 1000                         | Larger writes are rolled back                    |
|                              | `SAFESQL_MAX_BYTES`         | 60000                        | Approximate bytes of rows per response           |
| `--allow-tables <list>`      |                             |                              | Only these tables are visible                    |
| `--deny-tables <list>`       |                             |                              | Hide these tables                                |
| `--deny-columns <list>`      |                             |                              | Hide these columns (`users.password_hash,*.ssn`) |
| `--redact-columns <list>`    |                             |                              | Mask these columns in results                    |
| `--no-redact`                |                             | auto                         | Turn off automatic secret masking                |
| `--mask-emails`              | `SAFESQL_MASK_EMAILS=1`     | off                          | `jane@x.com` becomes `j***@x.com`                |
| `--export-dir <dir>`         | `SAFESQL_EXPORT_DIR`        | `~/safesql-exports`          | Where `export_query` writes                      |
| `--audit-log <file\|off>`    | `SAFESQL_AUDIT_LOG`         | `~/.safesql-mcp/audit.jsonl` | JSONL audit log                                  |
| `--config <file>`            | `SAFESQL_CONFIG`            | `./safesql.config.json`      | JSON config file                                 |
| `--http`, `--port`, `--host` | `PORT`, `HOST`              | 3000, 127.0.0.1              | Streamable HTTP transport                        |
| `--token <t>`                | `SAFESQL_HTTP_TOKEN`        |                              | Require `Authorization: Bearer <t>` on `/mcp`    |

A config file gives per-database settings, `${ENV}` interpolation and saved queries
(see [`examples/safesql.config.json`](examples/safesql.config.json)):

```json
{
  "databases": {
    "shop": { "url": "./shop.db", "denyColumns": ["customers.password_hash"] },
    "warehouse": { "url": "${WAREHOUSE_URL}", "allowTables": ["reporting.*"], "timeoutMs": 30000 },
    "staging": { "url": "postgres://app@localhost/staging", "mode": "write", "maxAffectedRows": 100 }
  },
  "queries": {
    "daily_signups": {
      "db": "warehouse",
      "sql": "SELECT date_trunc('day', created_at) d, count(*) FROM reporting.users GROUP BY 1 ORDER BY 1 DESC LIMIT 30"
    }
  }
}
```

## HTTP and Docker

```bash
npx -y safesql-mcp --http ./app.db --port 3000          # MCP endpoint: http://127.0.0.1:3000/mcp, health: /health

docker build -t safesql-mcp .
docker run -p 3000:3000 -e SAFESQL_HTTP_TOKEN=change-me -e DATABASE_URL=postgres://reader:pw@host/db safesql-mcp
docker run -p 3000:3000 -e SAFESQL_HTTP_TOKEN=change-me safesql-mcp --http examples/shop.db   # bundled demo data
```

The HTTP transport is stateless and shares one connection pool and schema cache across requests. Set a
token whenever the port is reachable by anyone but you.

## CLI

```bash
safesql-mcp demo [file]                      # sample SQLite shop database
safesql-mcp demo --sql postgres | psql "$URL"  # the same data for PostgreSQL
safesql-mcp schema ./app.db                  # compact schema overview
safesql-mcp query ./app.db "SELECT count(*) FROM users" --format csv
safesql-mcp doctor ./app.db postgres://...   # diagnose setup
safesql-mcp tools                            # list MCP tools
```

## Performance

Measured on a laptop-class Linux box with Node 24 (`node:sqlite`, SQLite 3.53) and PostgreSQL 17 on localhost:

| Operation                                                         | Time    |
| ----------------------------------------------------------------- | ------- |
| Indexed point query, SQLite, through the full guard + worker path | ~0.1 ms |
| Indexed point query, PostgreSQL (read-only transaction per query) | ~0.4 ms |
| `GROUP BY` over 500,000 SQLite rows                               | ~110 ms |
| `SELECT *` on 500,000 rows (capped at 100 rows)                   | ~1 ms   |

The published package is about 165 KB of JavaScript with four small runtime dependencies (`@modelcontextprotocol/sdk`,
`zod`, `pg` and `pg-cursor`), all pure JavaScript.

## Limitations

- **Engines:** SQLite and PostgreSQL only. MySQL/MariaDB are not supported yet.
- **Node.js 22.16+** is required because SQLite uses the built-in `node:sqlite` module (no native compile).
  On Node 22 it may be marked experimental; the server silences that warning.
- **Policies on PostgreSQL** are checked with `EXPLAIN (VERBOSE)`. Functions that read tables internally
  (for example user-defined `SECURITY DEFINER` functions) are not visible in the plan. If you need hard
  guarantees for sensitive tables, also restrict the database role.
- **Redaction** works on result columns that come straight from a table column (aliases included).
  An expression such as `upper(password)` is not masked; use `--deny-columns` for columns that must never
  be read.
- `SELECT *` on a table with a denied column is refused (with the list of allowed columns), not rewritten.
- **SQLite timeouts** terminate the worker thread, so the first query after a timeout reopens the file
  (a few milliseconds).
- `offset` paging re-runs the query and skips rows; for deep pagination prefer keyset filters
  (`WHERE id > ...`).

## Development

```bash
git clone https://github.com/cryptodeta/safesql-mcp && cd safesql-mcp
npm install
npm run check            # lint + typecheck + tests + build + stdio/HTTP smoke test
SAFESQL_TEST_PG_URL=postgres://postgres:postgres@localhost:5432/postgres npm test   # include PostgreSQL tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the layout and guidelines.

## Releasing

[`VERSION.md`](VERSION.md) holds the release version on its first line. To ship a release, add the notes to
`CHANGELOG.md`, bump that line and push to `main`. The `Release` workflow tags `vX.Y.Z`, creates the GitHub
Release and publishes to npmjs.org, GitHub Packages and ghcr.io only when the new version is greater than the
latest tag; an equal or lower version is a green no-op. Package versions are synced from `VERSION.md`
automatically (`node scripts/version.mjs sync` does the same locally).

### npmjs.org trusted publishing (no tokens)

npmjs.org releases use [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC), so there is no
`NPM_TOKEN` secret. npm only lets you add a trusted publisher to a package that already exists, so the first
version is published by hand:

1. First publish, from a clean checkout of `main` (Node 22.16+, logged in with `npm login`):

   ```bash
   git clone https://github.com/cryptodeta/safesql-mcp && cd safesql-mcp
   node scripts/version.mjs sync      # package.json versions come from VERSION.md
   npm ci
   npm run build
   cd packages/server
   npm publish --access public        # checks versions and dist/ first, copies README.md and LICENSE in
   ```

2. On npmjs.com open the package page, then **Settings** -> **Trusted Publisher** -> **GitHub Actions** and fill in:
   - Organization or user: `cryptodeta`
   - Repository: `safesql-mcp`
   - Workflow filename: `release.yml`
   - Environment name: leave empty

   Optionally set **Publishing access** to "Require two-factor authentication and disallow tokens".

3. From then on, bumping `VERSION.md` on `main` publishes through OIDC with provenance. To publish a version
   whose tag already exists (for example the one you published before step 2, or after a failed run), run the
   `Release` workflow manually with **republish** checked (`gh workflow run release.yml -f republish=true`).
   It never creates a second tag or release.

Until the package exists and the trusted publisher is set, the npmjs.org job ends green with a warning.
GitHub Packages and ghcr.io use the built-in `GITHUB_TOKEN` and need no setup.

## License

[MIT](LICENSE)
