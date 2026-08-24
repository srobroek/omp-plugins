# TOML -- Sniff Reference

One-line scope: TOML config -- `.toml` files, including well-known formats
`Cargo.toml`, `pyproject.toml`, `rustfmt.toml`, `.taplo.toml`. Covers the format:
table style, keys, schema conformance.

## Detect

How sniff knows TOML is present: key files, extensions, config.
- Files/extensions: `*.toml`; well-known `Cargo.toml`, `Cargo.lock` (generated --
  see Pragmatism), `pyproject.toml`, `poetry.lock`, `rustfmt.toml`,
  `netlify.toml`.
- Config that governs it: `.taplo.toml`/`taplo.toml` (formatter + lint rules +
  schema associations), `[tool.*]` blocks inside `pyproject.toml`.

## Tools

| Tool | Invocation | Covers | Tier | Installed via |
|------|-----------|--------|------|---------------|
| taplo | **Run recipe:** always pass **explicit file paths** and disable online schema fetch -- `taplo lint --no-schema <files>`. Bare `taplo lint` (no paths) globs the cwd and the schema fetch over the network can **panic on macOS** (taplo 0.10) -- `--no-schema` + explicit files avoids it. If you want schema validation for `Cargo.toml`/`pyproject.toml`, run a second pass without `--no-schema` only on those files and treat a network/panic failure as a skipped check, not a finding. **Exit:** 0 clean · non-zero = lint problems (or, if it crashed, INVALID -- re-run with `--no-schema`). | syntax, duplicate keys, schema conformance (built-in catalog for Cargo/pyproject) | default-on | `install-tools.sh --install data` |
| taplo | **Run recipe:** `taplo format --check <files>` (note: subcommand is `format`, `fmt` is an alias; pass explicit paths). Reports formatting drift; advisory. **Exit:** 0 already-formatted · non-zero = would reformat. | formatting/style diff (table style, alignment, key order) | default-on | `install-tools.sh --install data` |

Notes: taplo is the single tool -- it lints, formats, and validates against
schemas in one binary. `taplo lint` ships an online schema catalog (the JSON
Schema Store) and will validate `Cargo.toml`/`pyproject.toml` automatically when
it recognizes them; `--schema <url>` forces a specific schema. `taplo fmt --check`
reports style drift without writing. No grep fallback; if taplo is absent, record
a coverage gap.

## Smell checklist

| Smell | What it looks like (this format) | Idiomatic alternative |
|-------|----------------------------------|-----------------------|
| Inconsistent table style | Same data sometimes `[server]` block, sometimes inline `server = { host = ... }` | Pick one per section; inline tables for small flat values, header tables for grouped config |
| Deeply nested tables | `[a.b.c.d.e]` chains that are hard to scan | Flatten where not inherently hierarchical; group at one or two levels |
| Duplicate keys | Same key defined twice in a table -- invalid TOML | One key per table; taplo flags this |
| Array-of-tables misuse | `[[deps]]` used where a single inline array or a keyed table fits better, or vice versa | `[[x]]` only for repeated homogeneous records; a fixed set is a table/inline array |
| Missing schema | `Cargo.toml`/`pyproject.toml` not validated against its known schema | Let `taplo lint` apply the catalog schema, or set `--schema` / a `.taplo.toml` association |
| Redundant quoting | `"key" = 1` where the bare key `key = 1` is legal | Bare keys for identifier-shaped keys; quote only when chars require it |
| Dotted-key inconsistency | Mixing `a.b = 1` dotted keys with explicit `[a]` `b = 1` for the same table | One style per table; don't split a table across dotted and header forms |

## Idioms & style authorities

- TOML specification -- https://toml.io/en/
- Taplo documentation -- https://taplo.tamasfe.dev/
- Key conventions: one consistent table style per section; inline tables for
  small flat groups, header tables `[x]` for larger ones; bare keys unless
  characters force quoting; validate well-known files (`Cargo.toml`,
  `pyproject.toml`) against their schema; keep nesting shallow; don't mix dotted
  and header forms for one table.

## refactoring.guru mappings

TOML is a config format -- **mappings are mostly format-level**; cite the TOML
spec / taplo rather than the OO catalog for syntax and style findings.

| This-format smell | refactoring.guru smell | Idiomatic refactoring |
|-------------------|------------------------|-----------------------|
| The same option block repeated across sections | Duplicate Code (`/smells/duplicate-code`) | Factor into a shared section/table **where the format allows** -- TOML has no anchors, so often the dedup must happen in the tool that consumes the file, not the TOML itself |
| Inconsistent table style, redundant quoting, deep nesting | (no catalog entry) | Cite the TOML spec / taplo -- pure format, not an OO refactor |

## Pragmatism notes (for the adversarial pass)

- TOML is intentionally verbose for config clarity -- explicit `[section]`
  headers and one-key-per-line are a feature, not boilerplate to "DRY up." Don't
  push to collapse a readable header table into a cramped inline table.
- Nesting depth is a judgment call -- `[tool.ruff.lint.per-file-ignores]` in a
  `pyproject.toml` is normal and dictated by the consuming tool; don't flag depth
  that the schema requires.
- Lockfiles (`Cargo.lock`, `poetry.lock`) are generated -- never flag their style,
  key order, or size.
- Table-vs-inline and dotted-vs-header are partly taste; only flag *inconsistency
  within one file*, not a project's deliberate house style.
- TOML has no anchor/alias mechanism, so "extract the duplicate" advice that works
  for YAML often doesn't apply -- don't recommend a TOML feature that doesn't exist.
