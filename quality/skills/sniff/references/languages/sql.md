# SQL -- Sniff Reference

One-line scope: SQL source -- `.sql` files (queries, views, stored routines) and
migration files (`migrations/`, Flyway `V*__*.sql`, Alembic, dbt models). N+1 and
query-construction smells live in application code; this doc notes them but the
host-language doc owns the surrounding code.

## Detect

How sniff knows SQL is present: key files, extensions, config.
- Files/extensions: `*.sql`; dbt `models/**/*.sql`; migration dirs
  (`migrations/`, `db/migrate/`, Flyway `V<n>__<name>.sql`, Alembic `versions/`).
- Config that governs it: `.sqlfluff` (dialect, rules, templater), `dbt_project.yml`,
  `pyproject.toml [tool.sqlfluff]`. The dialect MUST be read from config or the
  connection string -- passing the wrong `--dialect` produces false positives.

## Tools

| Tool | Invocation | Covers | Tier | Installed via |
|------|-----------|--------|------|---------------|
| sqlfluff | **Run recipe:** `cd` to the repo root FIRST (sqlfluff resolves `.sqlfluff`/`setup.cfg` and templater state from cwd -- a leaked subdir cwd from a prior step is the "ran against frontend/" bug), then pass **absolute or repo-root-relative** paths: `sqlfluff lint --format json --dialect <d> <abs-paths>`. **`--dialect` is MANDATORY** -- sqlfluff errors without it unless `.sqlfluff` sets one; detect the dialect (postgres/mysql/sqlite/bigquery/snowflake/ansi) from the repo, else default `ansi`. **Exit:** 0 clean · 1 = lint violations (parse JSON) · 2 = usage/config error → INVALID. | dialect-aware style + anti-patterns (`SELECT *`, implicit joins, ambiguous refs, layout) | default-on | `install-tools.sh --install sql` |
| squawk | `squawk <migration.sql>` | dangerous Postgres migrations (locking ALTER, table rewrite, NOT NULL without default) | opt-in (only when Postgres migration files are present) | `install-tools.sh --install sql` |
| jscpd | `jscpd --reporters json --silent --min-tokens 50 <path>` | cross-file query duplication (no native SQL dup detector) | default-on | `install-tools.sh --install dup` |

Notes: sqlfluff is primary and is dialect-aware (`postgres`, `bigquery`,
`snowflake`, `mysql`, `tsql`, `ansi`, …) -- always pass the project's real dialect.
squawk is Postgres-only and targets migration safety, not query style; run it on
migration files on deep passes. jscpd is the dup floor since SQL has no native
copy-paste detector. None of these understand the live schema, so missing-index
and N+1 judgments come from the smell checklist, not a tool. **sqlint is
redundant with sqlfluff -- do not add it.**

## Smell checklist

| Smell | What it looks like (this language) | Idiomatic alternative |
|-------|-----------------------------------|-----------------------|
| `SELECT *` | `SELECT * FROM orders` in app/view code | Explicit column list -- stable contract, avoids over-fetch |
| Implicit (comma) join | `FROM a, b WHERE a.id = b.a_id` | Explicit `FROM a JOIN b ON a.id = b.a_id` |
| Non-sargable predicate | `WHERE date(created) = '...'` or `WHERE upper(name) = ...` -- function on indexed column kills index use | Range on raw column: `WHERE created >= '...' AND created < '...'` |
| Missing WHERE | `UPDATE accounts SET active = 0` / `DELETE FROM logs` with no filter | Always scope writes; require an explicit `WHERE` in review |
| N+1 query | Loop in app code issuing one query per row (visible in host code, not the `.sql`) | Single `JOIN`/`IN (...)`/batch fetch; note in the host-language doc |
| Correlated subquery as filter | `WHERE EXISTS (SELECT 1 FROM b WHERE b.a_id = a.id)` run per row | Rewrite as a `JOIN` or semi-join when the planner won't |
| Missing index on FK/filter | FK or hot `WHERE`/`JOIN` column with no supporting index | Add index on the FK / high-selectivity filter column |
| Ambiguous column ref | `SELECT id FROM a JOIN b ...` where both have `id` | Qualify every column: `a.id` |
| `DISTINCT` masking a join | `SELECT DISTINCT ...` added to hide row fan-out from a bad join | Fix the join cardinality; `DISTINCT` is the symptom |
| Dangerous migration | `ALTER TABLE big ADD COLUMN c int NOT NULL` (rewrite + long lock); `ALTER ... TYPE`; non-`CONCURRENTLY` index build | Add nullable + backfill + set NOT NULL; `CREATE INDEX CONCURRENTLY`; squawk flags these |

## Idioms & style authorities

- SQL Style Guide (Simon Holywell) -- https://www.sqlstyle.guide/
- Mozilla SQL Style Guide -- https://docs.telemetry.mozilla.org/concepts/sql_style.html
- Dialect docs (authoritative for sargability/index behavior): PostgreSQL --
  https://www.postgresql.org/docs/current/
- Key conventions: explicit column lists, never `SELECT *` in persisted code;
  explicit `JOIN ... ON`; keep predicates sargable (no function/expression on the
  indexed side); uppercase keywords + consistent layout; qualify columns in
  multi-table queries; factor complex logic into named CTEs.

## refactoring.guru mappings

The catalog is OO-oriented -- **most SQL smells are performance/correctness, not
classic OO smells**, so cite the dialect docs or the SQL style guide for those and
use the catalog only for true duplication/length structure:

| This-language smell | refactoring.guru smell | Idiomatic refactoring |
|---------------------|------------------------|-----------------------|
| Same subquery/join block pasted across queries | Duplicate Code (`/smells/duplicate-code`) | Extract into a `VIEW` or shared CTE (the SQL analogue of Extract Method) |
| 200-line query with nested derived tables | Long Method (`/smells/long-method`) | Decompose into named `WITH` CTEs (`/refactoring/techniques/composing-methods`) for readability |
| `SELECT *`, non-sargable predicate, missing index | (no catalog entry) | Cite SQL Style Guide / dialect docs -- performance/correctness, not an OO refactor |

## Pragmatism notes (for the adversarial pass)

- `SELECT *` is fine in ad-hoc/exploratory queries, REPL sessions, and
  `EXISTS (SELECT *)`; flag it only in persisted views, app queries, and
  migrations.
- Not every subquery is a smell -- correlated subqueries sometimes plan better
  than a join, and the planner may already rewrite them; don't assume a join is
  faster without `EXPLAIN`.
- Small/static lookup tables don't need an index on every column -- full scans of
  a few hundred rows are cheap; weigh index write cost.
- CTE-vs-subquery and `DISTINCT` choices can be planner-dependent (some engines
  materialize CTEs); a "fix" that helps Postgres may hurt another dialect.
- Migration warnings from squawk assume large tables under load; on a tiny or
  empty table a "rewriting" ALTER is harmless.
