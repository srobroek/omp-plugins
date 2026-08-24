# OpenAPI 3.x / Swagger -- Sniff Reference

One-line scope: OpenAPI/Swagger API contracts -- `openapi.{yaml,json}`,
`swagger.{yaml,json}`, and split specs joined via `$ref`. The dominant concern
is **contract design and backwards compatibility**; this feeds the sniff
report's back-compat column.

## Detect

How sniff knows an OpenAPI/Swagger contract is present.
- Files/extensions: `openapi.yaml` / `openapi.json` / `swagger.yaml` /
  `swagger.json`; any `.yaml`/`.json` whose root has `openapi: 3.x` or
  `swagger: "2.0"`; split specs where `paths`/`components` are pulled in by
  `$ref` (e.g. `paths/*.yaml`, `components/schemas/*.yaml`).
- Config that governs it: `.spectral.yaml` / `.spectral.json` (ruleset),
  `vacuum.conf.yaml` / a `--ruleset` file, and CI steps invoking `spectral` or
  `vacuum`. A vendored prior spec (e.g. `openapi.prev.yaml`, a git ref, or a
  published version) is the baseline for breaking-change checks.

## Tools

Primary first. Run on the **resolved** spec (all `$ref`s dereferenced) so rules
see the full graph. Spectral and vacuum overlap heavily -- run one as the linter.

| Tool | Invocation | Covers | Tier | Installed via |
|------|-----------|--------|------|---------------|
| vacuum | **Run recipe (use ONE of vacuum/spectral).** `vacuum lint -d -o json <spec>` from repo root -- `<spec>` is the root spec path (vacuum resolves `$ref`s itself); `-d` = full details, `-o json` = machine-readable. Auto-reuses a project ruleset if present (`.spectral.yaml`/`.spectral.json` or `.vacuum.yaml`/`vacuum.conf.yaml`); with none it applies its built-in recommended OWASP/OAS rules. `vacuum report <spec>` produces a shareable report variant. **Exit:** 0 = no errors · non-zero = rule violations → parse the JSON `resultSet`/results (each has `message`/`severity`/path) · a parse/usage failure (unresolvable `$ref`, bad ruleset) = INVALID. **Gotcha:** point at the root spec, not a split fragment, or rule coverage is partial. | rule-based design smells, naming, missing schemas/operationId, governance rulesets (Go, fast on large specs; `-d` = details) | default-on (preferred linter) | `install-tools.sh --install api` |
| spectral | **Run recipe (alternative -- use ONE of vacuum/spectral, not both).** `spectral lint -f json <spec>` from repo root -- `<spec>` is the root spec (spectral resolves `$ref`s). Auto-reads `.spectral.yaml`/`.spectral.json` from the repo; with none it falls back to the built-in `spectral:oas` ruleset. **Exit:** 0 = clean · 1 = results at or above the failure severity → parse the JSON array (`code`/`message`/`severity`/`range`) · a usage/resolution error = INVALID, never "clean". Run this only when vacuum is not the chosen linter. | same rule classes as vacuum; the meta-linter for Node-centric repos | default-on (alternative -- use ONE of vacuum/spectral, not both) | `install-tools.sh --install api` |
| openapi-spec-validator | **Run recipe.** `openapi-spec-validator <spec>` from repo root -- `<spec>` is the root spec path; it auto-detects the OAS version from the document. No project config (it validates against the bundled OAS schema). **Exit:** 0 = structurally valid · non-zero = the document violates the OAS schema → read the printed validation errors · this is a validity gate only, not a style/smell finding. A crash on an unreadable/unresolvable file is INVALID, not "valid". | strict spec-validity (structural conformance to the OAS schema), not style | default-on | `install-tools.sh --install api` |
| oasdiff | **Run recipe (opt-in, baseline target).** `oasdiff breaking <base> <revision>` from repo root -- `<base>` is the prior spec (vendored `openapi.prev.yaml`, a checkout of a git ref, or a published version) and `<revision>` is the current spec. No project config; the baseline you pass IS the comparison. **Exit:** 0 = no breaking changes · non-zero = breaking changes found → parse the per-change output (headline these in the back-compat column) · a failure to load either spec = INVALID. Only run when a real baseline exists; without one, diff manually per the Pragmatism notes. | breaking-change detection vs a baseline spec (removed paths/fields, narrowed types, newly-required request fields) | opt-in (needs a CI baseline -- prior spec / git ref / published version) | `install-tools.sh --install api` |

Notes: vacuum and spectral are the meta-linters -- both flag missing
`operationId`, missing descriptions, unused/duplicate components, and invalid
examples against the same rule classes. They use a compatible ruleset format, so
**pick exactly one** (vacuum preferred for speed on large specs; spectral for
Node-centric repos that already wire it in) -- running both is redundant.
openapi-spec-validator only answers "is this a valid OAS document" -- keep it for
the validity gate, not for smells. **Breaking-change detection is not built into
the linters**: run `oasdiff` against the baseline (opt-in -- needs a CI baseline
spec, git ref, or published version) to catch removed paths/operations, removed
response fields, narrowed types, and newly-required request fields; without a
baseline, diff manually -- see Pragmatism notes. If the project already pins a
Spectral ruleset, respect it rather than imposing defaults.

## Smell checklist

Beyond what the linter flags by default. Group by category.

| Smell | What it looks like (OpenAPI) | Idiomatic alternative |
|-------|------------------------------|-----------------------|
| Missing `operationId` | Operations with no stable `operationId` | Add a unique, stable `operationId` per operation (drives SDK/codegen method names) |
| Inconsistent naming | Mixed `camelCase`/`snake_case`/`kebab-case` across path segments, params, and schema props | Pick one convention; Zalando recommends `snake_case` for query/JSON, lowercase hyphenated path segments |
| Missing response schemas | `responses` with a status but no `content.schema`; only `200` documented | Define a schema per documented status; describe the response body shape |
| Missing error responses | No `4xx`/`5xx` defined, or each operation invents its own error shape | One shared error model component (e.g. RFC 9457 `application/problem+json`) referenced everywhere |
| Unbounded arrays | `type: array` with no `maxItems` | Add `maxItems` (and pagination) to bound response/request size |
| Missing pagination | List endpoints return whole collections, no `limit`/`cursor`/`page` params | Cursor- or page-based pagination params + envelope; document defaults and caps |
| Inline schemas | Large request/response schemas defined inline, duplicated across operations | Extract to `components/schemas` and `$ref` (only when reused or large -- see Pragmatism) |
| No examples | Operations/schemas with no `example`/`examples` | Add representative examples (linters validate examples against the schema) |
| Missing security schemes | `securitySchemes` empty, or operations with no `security` and no documented public exemption | Declare schemes in `components.securitySchemes`; apply per-operation or globally |
| `additionalProperties` unset | Object schemas silently allow arbitrary extra properties | Set `additionalProperties: false` for closed contracts, or type it explicitly for maps |
| Versioning inconsistency | Version in path (`/v1/...`) for some routes, header/media-type for others | Pick one versioning strategy and apply it uniformly |
| Breaking change | Removed/renamed field, narrowed type, new required request field, removed/changed status code, tightened enum | Treat as a major version; flag in back-compat column (see Pragmatism) |

## Idioms & style authorities

- OpenAPI Specification -- https://spec.openapis.org/oas/latest.html
- Spectral rulesets & `spectral:oas` -- https://docs.stoplight.io/docs/spectral
- Zalando RESTful API Guidelines -- https://opensource.zalando.com/restful-api-guidelines/
- Key conventions: reuse via `$ref` to `components` (schemas, responses,
  parameters); a single shared error model; consistent naming and pagination;
  semantic versioning where additive = minor, removal/retype = major; document
  every status, security scheme, and example.

## refactoring.guru mappings

Most "refactorings" here are **contract-design moves**, not code rewrites -- the
OO catalog maps loosely. Cite the smell for vocabulary, but the fix is a spec
edit.

| This-language smell | refactoring.guru smell | Idiomatic refactoring |
|---------------------|------------------------|-----------------------|
| Same inline schema repeated across operations | Duplicate Code (`/smells/duplicate-code`) | Extract a `components/schemas` entry and `$ref` it everywhere |
| Long flat parameter list on an operation | Long Parameter List (`/smells/long-parameter-list`) | Move related params into a request body object (Introduce Parameter Object) |
| Same group of fields recurring across schemas | Data Clumps (`/smells/data-clumps`) | Extract a shared schema component and compose via `$ref`/`allOf` |

## Pragmatism notes (for the adversarial pass)

- **Additive is safe; removal/retype is breaking.** Adding a new optional field,
  a new endpoint, a new optional query param, or a new enum value to a *request*
  is backwards-compatible. Removing or renaming a field, narrowing a type
  (`string`→`integer`), making a previously-optional request field required,
  changing/removing a status code, or removing an enum value from a *response*
  is breaking -- **always flag in the back-compat column**.
- Adding a required field to a **request** breaks existing clients; adding a
  field to a **response** is safe only if clients tolerate unknown fields
  (the usual contract). Note the direction.
- Not every inline schema must be extracted. A small, single-use schema is fine
  inline; only extract on reuse or genuine size. Don't flag one-off inline
  objects as "duplication."
- `additionalProperties: false` is correct for closed contracts but **wrong for
  forward-compatible** designs where clients should ignore unknown fields -- do
  not blanket-recommend it.
- Version-in-path vs header is a legitimate design choice; flag only the
  *inconsistency* within one spec, not the strategy itself.
- A missing `maxItems` on a tiny, fixed enum-like array is not a real unbounded
  risk -- reserve the flag for collections that grow with data.
