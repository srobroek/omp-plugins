# JSON -- Sniff Reference

One-line scope: JSON data/config -- `.json` files (and JSONC/JSON5 variants).
Covers the format itself: structure, keys, schema conformance. Application code
that *produces* JSON is owned by its host-language doc.

## Detect

How sniff knows JSON is present: key files, extensions, config.
- Files/extensions: `*.json`, `*.jsonc`, `*.json5`; common configs `package.json`,
  `tsconfig.json`, `*.schema.json`, `.eslintrc.json`, lockfiles (treat lockfiles
  as generated -- see Pragmatism).
- Config that governs it: `biome.json`/`biome.jsonc` (formatter + linter),
  `$schema` field inside the file, a project schema dir (`schemas/*.json`),
  `.vscode/settings.json` `json.schemas` mappings.

## Tools

| Tool | Invocation | Covers | Tier | Installed via |
|------|-----------|--------|------|---------------|
| biome | **Run recipe.** `npx biome lint --reporter=json <files>` from repo root -- pass the resolved `.json`/`.jsonc` paths explicitly. Auto-reads `biome.json`/`biome.jsonc` from the repo for enabled rules + formatter settings; with no config biome applies its built-in recommended rules (dup-key detection is on by default). **Exit:** 0 = clean · 1 = lint diagnostics found → parse the JSON `diagnostics` array · any usage/crash (e.g. `npx` cannot resolve biome, bad config) = INVALID, never "clean". **Gotcha:** the binary is `@biomejs/biome`; if `npx biome` is not provisioned record a coverage gap rather than guessing a path. | duplicate keys, formatting, basic structure | default-on | `install-tools.sh --install data` |
| check-jsonschema | **Run recipe (opt-in).** `check-jsonschema --schemafile <schema> <files>` from repo root -- `<schema>` is a local schema path or a registered URL, `<files>` the explicit JSON paths to validate against it. No project config of its own; the schema you pass IS the config (resolve it from the file's `$schema` field or a known schema-backed config like GitHub workflows / Renovate). **Exit:** 0 = conforms · 1 = validation errors → parse the per-instance error output · 2 = usage error (missing/unresolvable schema) = INVALID, fix the `--schemafile`. Only run when a schema actually exists; absent one, this is not a finding. | schema conformance against a JSON Schema | opt-in (only when a `$schema` field or a known schema-backed config -- GitHub workflows, Renovate, etc. -- is present) | `install-tools.sh --install data` |

Notes: biome is the primary format linter and catches the high-value duplicate-key
case plus formatting; it also covers JSON inside JS/TS projects already using
biome. check-jsonschema is the conformance gate when a schema exists (point
`--schemafile` at a local schema or a registered URL). **jq is NOT a linter and is
excluded from the tool tiers** -- it is for ad-hoc exploration and one-off
extraction in the analysis itself (`jq -e <filter> <file>`); never treat jq exit
codes as lint findings. No grep fallback; if biome is absent, record a coverage
gap.

## Smell checklist

| Smell | What it looks like (this language) | Idiomatic alternative |
|-------|-----------------------------------|-----------------------|
| Duplicate keys | `{"timeout": 30, "timeout": 60}` -- last wins silently | One key per object; biome flags this |
| No schema for config | Hand-edited config with no `$schema` and no CI validation | Author/adopt a JSON Schema; validate in CI with check-jsonschema |
| Inconsistent key casing | Mix of `camelCase`, `snake_case`, `kebab-case` in one file | Pick one casing per file/contract and hold it |
| Deeply nested structure | 6+ levels of objects to reach a scalar | Flatten where the data is not inherently hierarchical; use a `$ref`'d sub-schema |
| Large committed JSON | A 5k-line generated blob checked in and hand-touched | Generate at build time or store as a fixture, not source |
| Comments-in-JSON hack | `"//": "explanation"` or `_comment` keys to fake comments | Move to JSON5/JSONC (if tooling allows) or YAML, which support real comments |
| Trailing comma / syntax | `[1, 2, 3,]` -- invalid in strict JSON | Remove; or switch the file to JSON5/JSONC explicitly |
| Number that should be a string | 64-bit IDs / monetary values as JSON numbers -- lose precision past 2^53 | Quote as strings (`"id": "90071992547409921"`); enforce via schema `type` |

## Idioms & style authorities

- JSON specification -- https://www.json.org/
- JSON Schema -- https://json-schema.org/
- Key conventions: schema-validate any config humans edit; one consistent key
  casing per contract; no duplicate keys; prefer flat structure where the data is
  not inherently nested; quote identifiers that exceed safe integer precision;
  strict JSON has no comments -- use JSONC/JSON5 or YAML if you need them.

## refactoring.guru mappings

JSON is a data format -- **classic OO mappings are limited**; most findings are
format/structure issues better cited to the JSON Schema spec than the catalog.

| This-language smell | refactoring.guru smell | Idiomatic refactoring |
|---------------------|------------------------|-----------------------|
| Same group of keys repeated across many objects | Data Clumps (`/smells/data-clumps`) | Define the cluster once as a JSON Schema definition and `$ref` it (the format analogue of Introduce Parameter Object / Extract Class) |
| Duplicate keys, casing drift, comment hacks | (no catalog entry) | Cite the JSON spec / JSON Schema -- pure format issues, not OO refactors |

## Pragmatism notes (for the adversarial pass)

- Not all JSON needs a schema -- a tiny fixture, a one-off test input, or an
  obvious 5-key config doesn't warrant authoring a schema; reserve the demand for
  configs that are widely edited or shared.
- Nesting is sometimes inherent to the data (a real tree, an AST dump); depth is
  not automatically a smell -- judge against the domain.
- Lockfiles (`package-lock.json`, `composer.lock`) and other generated JSON are
  not authored source -- do not flag their formatting, key order, or size.
- Casing is dictated by external APIs/protocols; matching an upstream's
  `snake_case` is correct even if the rest of the repo is `camelCase`.
- **Honor `.editorconfig` before flagging indentation.** Tools won't read it; a
  declared `[*.json] indent_size` overrides a linter's default expectation, so a
  mismatch there is config-driven, not a smell.
