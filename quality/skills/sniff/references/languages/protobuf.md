# Protocol Buffers -- Sniff Reference

One-line scope: Protobuf/gRPC contracts -- `*.proto` files (proto3 primarily).
The dominant concern is **wire-compatibility and backwards compatibility**;
this feeds the sniff report's back-compat column.

## Detect

How sniff knows a Protobuf contract is present.
- Files/extensions: `*.proto`; a `syntax = "proto3"` (or `"proto2"`) header;
  `service` definitions for gRPC.
- Config that governs it: `buf.yaml` / `buf.gen.yaml` / `buf.work.yaml`
  (Buf module + lint/breaking config), `.protolint.yaml`, and a baseline for
  breaking checks -- a git ref, a `buf.build` registry module, or an image
  (`buf build -o image.bin`).

## Tools

Primary first. buf is the AST linter **and** the breaking-change detector;
protolint is a lint-only alternative.

| Tool | Invocation | Covers | Tier | Installed via |
|------|-----------|--------|------|---------------|
| buf (lint) | **Run recipe.** `buf lint --error-format json` run from the proto module dir (the dir holding `buf.yaml`) or the repo root if the module is rooted there. Auto-reads `buf.yaml` for the configured lint rule set + ignores (project config governs); with none it applies buf's default rule set. **Exit:** 0 = clean · 1 = lint violations → parse the JSON lines (each has `path`/`start_line`/`type`/`message`) · a config/usage error (no `buf.yaml`, bad flag) = INVALID, never "clean". **Gotcha:** run from the module dir so relative `$ref`/import paths resolve. | AST-level style/naming/structure rules (snake_case fields, enum zero-value, package versioning, etc.) | default-on | `install-tools.sh --install api` |
| buf (breaking) | **Run recipe (opt-in, baseline target).** `buf breaking --against ".git#ref=<base-ref>,subdir=<proto-dir>"` -- the `--against` value is a buf input string, not a bare git ref; `subdir=` is required when protos live in a subdirectory (e.g. `buf breaking --against ".git#ref=main,subdir=proto"` from `proto/`). It can also take a built `image.bin` or a registry module. **Exit:** 0 = no breaking changes · **100 = breaking changes found** (this is the expected finding code, NOT an error -- parse stdout for the per-change lines and headline them in the back-compat column) · 1 / other = a real usage/config error = INVALID. | wire- and source-compat regression detection vs a baseline (git ref, image, or registry module) | opt-in (needs a baseline, CI) | `install-tools.sh --install api` |
| protolint | **Run recipe (opt-in -- redundant; prefer `buf lint`).** `protolint lint <files>` from repo root (pass explicit `.proto` paths); reads `.protolint.yaml` if present. **Exit:** 0 = clean · 1 = lint findings · other = INVALID. Skip entirely when buf is available -- `buf lint` already covers the same lint half; running both double-counts findings. | lint-only alternative (naming, ordering, style); no breaking-change detection | opt-in (redundant -- `buf lint` covers it) | `install-tools.sh --install api` |

Notes: buf is the meta-tool here -- `buf lint` covers naming/structure and
`buf breaking --against "<buf-input>"` is the authoritative wire-compat gate (it
classifies removed fields, renumbered fields, type changes, etc.). protolint
only overlaps the lint half; if buf is present, protolint is redundant.

The `--against` ref is a buf input string, not a bare git ref. Run it **from the
proto module dir** and point at the base in that same repo:
`buf breaking --against ".git#ref=<base-ref>,subdir=<proto-path>"` (the `subdir=`
is required when protos live in a subdirectory, e.g.
`buf breaking --against ".git#ref=main,subdir=proto"` from `proto/`). It can also
take a built `image.bin` or a registry module. **Exit 100 = breaking changes
found** (not an error) -- parse stdout for the per-change lines. Reserve a baseline
reference per spec so breaking checks are meaningful.

## Smell checklist

Beyond what tools flag. Wire-compat rules dominate -- group accordingly.

| Smell | What it looks like (Protobuf) | Idiomatic alternative |
|-------|-------------------------------|-----------------------|
| Reusing field numbers (DANGEROUS) | A deleted field's number reassigned to a new field | Never reuse a number; `reserved` the old number permanently |
| Not reserving removed fields | Field deleted without `reserved <n>;` / `reserved "name";` | Add `reserved` for both the number and the name on deletion |
| Changing field types | A field's type edited in place (`int32`→`string`, etc.) | Add a new field with a new number; keep/deprecate the old |
| Enum without zero default | `enum` whose first value is not `*_UNSPECIFIED = 0` | First value must be `FOO_UNSPECIFIED = 0` (proto3 default) |
| Required-like semantics | Treating fields as mandatory; relying on presence where proto3 has none | Design for optional/absent; use `optional` for explicit presence |
| Inconsistent naming | Fields not `snake_case`, messages/enums not `PascalCase`, enum values not `UPPER_SNAKE_CASE` | Follow the style guide casing rules |
| Giant messages | One message with dozens of fields covering many concerns | Split into focused messages; compose via nested/`message` fields |
| Missing package versioning | `package foo;` with no `v1`/`v2` segment | `package foo.v1;` so a v2 can coexist without breaking v1 |
| Careless proto2 semantics in proto3 | proto2 presence/`required` assumptions in a proto3 file | Use proto3 rules; `optional` for explicit field presence |

## Idioms & style authorities

- Protobuf Style Guide -- https://protobuf.dev/programming-guides/style/
- Proto3 / proto best practices -- https://protobuf.dev/programming-guides/proto3/
- Buf lint rules -- https://buf.build/docs/lint/rules
- Key conventions: never reuse field numbers; `reserved` removed numbers **and**
  names; enum zero value = `*_UNSPECIFIED`; `snake_case` fields,
  `PascalCase` messages, `UPPER_SNAKE_CASE` enum values; package versioning
  (`pkg.v1`) so incompatible changes ship as a new package.

## refactoring.guru mappings

The OO catalog maps **weakly** here -- Protobuf changes are governed by
wire-compat rules, not OO refactorings. Cite a smell only for vocabulary; the
real authority is the wire-compat rules above.

| This-language smell | refactoring.guru smell | Idiomatic refactoring |
|---------------------|------------------------|-----------------------|
| Same field group repeated across messages | Duplicate Code (`/smells/duplicate-code`) | Extract a shared `message` type and embed it |
| Giant catch-all message | Large Class (`/smells/large-class`) | Split into focused messages -- **but never renumber surviving fields** |

## Pragmatism notes (for the adversarial pass)

- **Adding a field with a new number is safe.** New fields with fresh numbers are
  wire-backwards-compatible -- old and new peers interoperate. Do not flag pure
  additions as breaking.
- **Renumber / reuse / retype is wire-breaking** -- old serialized data and old
  peers misread the field. **Always flag as breaking** in the back-compat column.
  Reusing a number is the most dangerous case (silent data corruption).
- **Field RENAME is source-breaking but wire-safe** -- the wire format keys on the
  number, not the name, so serialized data is unaffected, but generated code and
  JSON mapping break. Note the distinction explicitly; classify it as a
  source-compat break, not a wire break.
- Removing a field is wire-safe *only if* its number is `reserved` so it is never
  reused; flag a removal that omits `reserved`.
- `*_UNSPECIFIED = 0` is genuinely required in proto3 (the zero value is the
  default for an absent field) -- this is not pedantry.
- Don't recommend splitting a message if it would change surviving field numbers;
  the structural cleanup is not worth a wire break. Favor leaving numbers stable.
