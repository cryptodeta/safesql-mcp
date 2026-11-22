# Contributing

Thanks for helping! Bug reports, new safety checks, engine support and docs fixes are all welcome.
Please report security issues privately through GitHub's "Report a vulnerability" button rather than a
public issue.

## Setup

```bash
git clone https://github.com/cryptodeta/safesql-mcp
cd safesql-mcp
npm install
npm run check        # lint + typecheck + tests + build + smoke test
```

Requirements: Node.js 22.16 or newer. PostgreSQL tests run when `SAFESQL_TEST_PG_URL` points at a server
where the user may create databases (each test run creates and drops its own database):

```bash
docker run -d --name pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:17-alpine
SAFESQL_TEST_PG_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
```

## Layout

```
packages/
  core/     @safesql/core - engine, SQL guard, policies, drivers, formatting (no MCP dependency)
    src/lexer.ts          SQL tokenizer (comments, strings, dollar quotes, identifiers)
    src/guard.ts          statement classification and blocking rules
    src/policy.ts         allow/deny lists, redaction
    src/engine.ts         SafeSql: tools' logic, limits, confirm tokens, audit
    src/drivers/          sqlite.ts (+ worker source) and postgres.ts
    test/                 unit tests and engine tests (SQLite always, PostgreSQL when configured)
  server/   safesql-mcp - MCP tools, resources, prompts, stdio/HTTP transports, CLI, init, doctor
examples/   demo database, PostgreSQL seed SQL, sample config
scripts/    smoke.mjs (end-to-end stdio + HTTP test of the built CLI)
```

The core package is bundled into the published `safesql-mcp` package by tsup.

## Useful scripts

| Command                           | What it does                                                    |
| --------------------------------- | --------------------------------------------------------------- |
| `npm test`                        | All tests (PostgreSQL tests skip without `SAFESQL_TEST_PG_URL`) |
| `npm run test:pg`                 | PostgreSQL engine tests only                                    |
| `npm run lint` / `npm run format` | Biome lint / auto-fix                                           |
| `npm run typecheck`               | TypeScript, strict                                              |
| `npm run build`                   | Bundle the CLI and library                                      |
| `npm run smoke`                   | Start the built server over stdio and HTTP and call tools       |
| `npm run demo`                    | Rebuild `examples/shop.db`                                      |

Try the server interactively with the MCP Inspector:

```bash
npm run build
npx @modelcontextprotocol/inspector node packages/server/dist/cli.js examples/shop.db
```

## Guidelines

- Safety first: a new feature must not weaken the read path. Reads always go through the guard and the
  engine-level read-only connection or transaction.
- Every new blocking rule or bypass fix needs a test in `guard.test.ts` and, where possible, an engine test
  that proves the database itself refuses it.
- Keep tool output compact. Prefer one line per item and plain text over JSON.
- Errors should say what went wrong and how to fix it (`SafeSqlError` with a `hint`).
- English only in code, docs and messages.
- Add a CHANGELOG entry under "Unreleased".

## Releasing (maintainers)

```bash
npm run check
npm version <patch|minor|major> -w safesql-mcp   # also bump packages/server/src/version.ts
npm publish -w safesql-mcp --access public
```
