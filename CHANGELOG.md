# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-23

### Added

- One MCP server for SQLite (`node:sqlite`, no native build) and PostgreSQL (`pg`), with several named
  databases at once from CLI arguments, `DATABASE_URL`, `SAFESQL_DB_<NAME>` or `safesql.config.json`.
- 14 tools: `list_databases`, `list_tables`, `describe_table`, `schema_overview`, `search_schema`,
  `sample_rows`, `query`, `explain`, `profile_table`, `relationships`, `export_query`, `saved_queries`,
  `audit_log`, and `execute` (only registered in write/admin mode).
- MCP resources (`safesql://databases`, `safesql://{db}/schema`, `safesql://{db}/table/{table}`) and prompts
  (`explore_database`, `optimize_query`, `data_quality_check`, `safe_change`).
- Read-only by default, enforced by the engine: SQLite read connection with `readOnly` + `query_only`,
  PostgreSQL `READ ONLY` transactions with `statement_timeout`, `lock_timeout` and a pinned snapshot.
- SQL guard: single statement per call, statement classification, blocked commands and side-effect
  functions, data-modifying CTE and `EXPLAIN ANALYZE` detection, trivial-`WHERE` detection.
- Row, byte, cell and time caps with `offset` paging; SQLite queries run in a worker thread that is
  terminated on timeout.
- Planner-based table/column policies (`allowTables`, `denyTables`, `denyColumns`) using SQLite bytecode
  and PostgreSQL `EXPLAIN (VERBOSE)`.
- Automatic redaction of secret-looking columns by source column, custom redaction and e-mail masking.
- Two-step writes: dry run in a rolled-back transaction with affected-row count and `RETURNING` preview,
  single-use confirm tokens bound to the SQL and parameters, required `WHERE`, max affected rows,
  admin mode for DDL.
- JSONL audit log of every statement (parameter values are never logged); credential scrubbing.
- Plain-language plan hints for SQLite and PostgreSQL; table profiling; Mermaid ER diagrams;
  CSV/JSON/JSONL/Markdown export confined to an export directory; saved queries.
- Did-you-mean suggestions for databases, tables, columns and SQL keywords.
- CLI: `init` for Claude Desktop, Claude Code, Cursor, VS Code and Windsurf; `doctor`; `demo`
  (SQLite file or PostgreSQL SQL); `query`; `schema`; `tools`.
- stdio and stateless Streamable HTTP transports with optional bearer token and `/health`.
- Dockerfile, GitHub Actions CI on Linux (with PostgreSQL 13 and 17), macOS and Windows, stdio/HTTP smoke test.
