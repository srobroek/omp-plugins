# Tool Catalog

The detection engine. The agent (or `bloodhound`) selects tools from here, runs
them with the listed invocation + machine-readable flag, respects project
config, and **skips + warns + records the install hint** for any absent tool.
There is no built-in grep fallback: detection uses real tools, and missing tools
become reported coverage gaps, not silent guesses.

Install via `scripts/install-tools.sh` (see `installer.md`). Probe first:
`install-tools.sh --probe`.

## Run-rules (apply to EVERY tool -- the per-target tables assume these)

Each tool in a target doc carries a **Run recipe** (exact command, config
handling, exit-code meaning, known-failure handling). These universal rules apply
to all of them so the recipes don't repeat them -- but a tool must still be
runnable from its recipe alone, not improvised:

1. **cwd + paths.** Tools run with cwd = the **target repo root** (or the
   worktree root for a ref target), NEVER a subdirectory. Pass the resolved file
   set as **explicit paths**; if a tool keeps state or resolves config by cwd
   (sqlfluff, eslint, stylelint), `cd` to the repo root once and pass absolute or
   repo-relative paths -- do not let a previous step's cwd leak in. Shipped assets
   (semgrep rules, configs) live at `skill://sniff/references/semgrep-rules/` and
   must be passed as an absolute filesystem path when a tool needs `--config`.
2. **Project config wins (Step 2.5).** If the repo configures the tool, run it so
   that config governs; the recipe's flags are the *no-project-config* form. A
   rule the project disabled is advisory at most.
3. **Exit codes are a contract, not failure.** For most linters, non-zero =
   "findings present", not "tool errored". Distinguish: 0 = clean · N = findings
   (parse the output) · a *crash/usage* error (bad flag, missing config, panic) =
   INVALID run → fix the invocation and re-run; never report a crash as "0
   findings / clean". A sub-second run that emitted nothing on a tool that should
   have compiled (clippy) is also INVALID.
4. **Don't emit default-noise the project never opted into.** When a tool's
   defaults are stricter than the repo's actual rules and there's no project
   config, suppress the defaults inline (e.g. yamllint with no `.yamllint`/
   `.editorconfig`: `yamllint -d "{extends: relaxed, rules: {line-length: disable, document-start: disable}}" -f parsable <paths>` -- GitHub workflows routinely exceed 80 cols; 80-col + document-start are NOT project rules). The per-tool recipe states its specific default-noise suppression.
5. **Flag exactly as written.** Tool flag styles differ (Go tools use single-dash
   `-format`, not `--format`; many use `--`). Copy the recipe's flags verbatim;
   do not normalize or guess a flag.

## Where the tiers live (source of truth)

**Per-target default-on / opt-in lists are authoritative in each target's doc**
(`references/languages/<target>.md`, its `## Tools` table with the **Tier**
column). This file is the **cross-cutting index + overlap map** -- the
cross-language tools, the precedence rules, the analysis classes, and what
subsumes what. When you build the Step-2 tool proposal: pull each detected
target's table from its doc, then add the cross-language default-on set below.

## Cross-language default-on set (offer on every run, any stack)

These cover dimensions per-language linters structurally miss; pre-select ON:

| Tool | Dimension | Class | Why it's not redundant |
|------|-----------|-------|------------------------|
| lizard | complexity (uniform, all langs) | local | one comparable CCN/length/param metric across every language, incl. those whose linter has none |
| scc | LOC + complexity triage | local | instant repo-shape map to aim the deep passes; COCOMO estimate |
| jscpd | cross-file / cross-language duplication | relational | the only clone detector spanning files AND formats (CSS, templates, configs); native linters never see cross-file dup |
| cspell | spelling across code + docs | local | offline, bundled dicts; identifier/comment/doc typos no linter catches |

Opt-in cross-language: **ast-grep** (structural search/rewrite -- needs custom
rules; also powers apply), **semgrep** (security-first; our shipped
`semgrep-rules/hardcoded-values.yml` is the one default use), **SonarQube CE**
(heavy server -- only for a standing quality gate), **tokei** (redundant w/ scc).

## Overlap map (don't double-count)

A meta-linter that already covers a dimension makes the point tool redundant --
drop the point tool to LOW/skip when its owner ran:

- **Complexity:** clippy / golangci(gocyclo,gocognit) / ruff(C901) / eslint+sonarjs
  each own their language → **lizard** only fills languages without a native one.
- **Duplication:** golangci(`dupl`) for Go, eslint-plugin-sonarjs for JS/TS →
  **jscpd** fills everything else (Python, SQL, CSS, templates, cross-file).
- **Dead code (within-file):** rustc / golangci(unused) / ruff(F401,F841) →
  native. **Whole-program** dead code needs a separate tool: **deadcode**(Go),
  **vulture**(Python), **knip**(JS/TS). These do NOT overlap the meta-linters.
- **Cycles / architecture:** **dependency-cruiser**(JS/TS) -- no meta-linter sees
  the module graph; madge is the lighter cycles-only fallback.
- **`any`-leakage:** typescript-eslint `no-unsafe-*` (per-site) + **type-coverage**
  (one % metric) -- complementary, keep both.

## How to read this catalog

Each tool lists: **mechanism** (predicts precision: dataflow > AST > token >
regex), **dimensions** it covers, the **invocation** to run, **overlap** (what it
duplicates, so you don't recommend redundant installs), and an **analysis class**
that decides how it scopes to a bounded target (see `targeting.md`).

Precedence rule: prefer a language's own meta-linter over stacking point tools.
Rust/Go/Python/JS each collapse to one primary tool that covers several
dimensions. Add cross-language tools only to cover what the primary misses.

### Analysis class (drives scoped/diff/PR runs)

Tag each tool with one class; `targeting.md` turns the class into a scoping rule.

- **local** -- finding lives inside one file/function → pass the target file list
  directly (honest, faster).
- **relational** -- finding is a *link* between target and other code (duplication,
  coupling) → scan target + repo context, report only links touching the target.
- **global** -- project-wide invariant (dead code, cycles, unused deps) →
  file-scoping yields false positives, so **skip in scoped mode + note it**;
  run only on whole-repo (or whole-repo-then-filter on request).
- **baseline** -- the analysis *is* a comparison vs. a ref (breaking-change) →
  native to diff/PR/range targets; run against the base ref and headline it.

In a whole-repo run, class does not matter (everything runs). It only governs
bounded targets.

---

## Cross-language meta-tools (install once, broad coverage)

### semgrep -- AST pattern + intra-file dataflow, 30+ languages
- **Dimensions:** anti-patterns, security, hardcoded values, custom smells.
- **Class:** local (intra-file rules) -- scope to the file list.
- **Invocation:** the shipped ruleset is under `skill://sniff/references/semgrep-rules/`,
  not the target repo -- and Step 3 runs tools with cwd = the target (or a worktree).
  So ALWAYS pass it as an absolute path, or semgrep silently matches nothing (the
  worst failure: looks clean). Resolve the installed sniff skill directory, then:
  `semgrep --config "$SNIFF_SKILL_DIR/references/semgrep-rules/hardcoded-values.yml" --json <files>`
  Registry sweep (no shipped asset, network): `semgrep --config auto --json <files>`.
  The same rule applies to any bundled-asset path: absolutize against the installed
  skill directory before use, because cwd is the target, not the skill.
- **Overlap:** the writable layer; complements every native linter. Highest
  leverage single cross-language install. Replaces any grep-based hardcoded-value
  scan with AST-aware matching (ignores consts, enums, test files).

### lizard -- complexity metrics, language-agnostic
- **Dimensions:** cyclomatic complexity, function length, parameter count, token count.
- **Class:** local -- scope to the file list.
- **Invocation:** `lizard --csv .` or `lizard -w .` (warnings only). Thresholds:
  `lizard -C 10 -L 50 -a 5` (ccn / length / args).
- **Overlap:** the complexity floor when a native meta-linter is absent.
  Redundant with golangci-lint(gocyclo), ruff(C901), clippy, sonarjs -- use it for
  languages without those.

### scc -- LOC + complexity estimate, very fast
- **Dimensions:** triage/hotspot ranking (size × complexity), not smells.
- **Class:** local -- scope to the file list.
- **Invocation:** `scc --by-file --format json .`
- **Overlap:** none; used in step 1/triage to aim deeper passes.

### jscpd -- token-based duplication, 150+ formats
- **Dimensions:** copy-paste duplication.
- **Class:** relational -- scan target + repo context, report blocks touching the
  target (diff-only would miss target↔existing duplication).
- **Invocation:** `jscpd --reporters json --silent --min-tokens 50 <path>`
- **Overlap:** redundant with golangci-lint(`dupl`) for Go and
  eslint-plugin-sonarjs for TS. **Install only for languages/formats without
  native dup detection** (Python, SQL, configs, cross-file template dup).

---

## Per-language primary tools

### Rust -- clippy (rustc-integrated, type + MIR aware)
- **Dimensions:** idioms, complexity, dead code, perf, footguns -- nearly all.
- **Class:** local for its lints (scope by filtering to target paths); but
  `cargo-machete`/`cargo-udeps` (unused deps) and clippy's dead-code lints are
  **global** -- skip those in scoped mode.
- **Invocation:** `cargo clippy --message-format=json` first (honors project
  `[lints.clippy]`/`clippy.toml`); append `-- -W clippy::pedantic -W clippy::nursery`
  **only** when the repo pins no clippy config -- else you override the Hard Rule
  and flood a curated repo. See `languages/rust.md`.
- **Overlap:** subsumes almost everything. Rust needs little else. Add
  `cargo-machete` (unused deps: `cargo machete`) and, on a deep run,
  `cargo-udeps` (nightly, compiler-accurate unused deps). Don't over-tool Rust.

### Go -- golangci-lint (runner over ~50 analyzers, one AST parse)
- **Dimensions:** complexity (gocyclo/gocognit), dup (dupl), dead code
  (unused/deadcode), idioms (revive), bugs (staticcheck), security (gosec),
  magic numbers (mnd), unchecked errors (errcheck), unused params (unparam).
- **Class:** mostly local -- runs per-package, so scope to target dirs then
  **filter JSON to target paths**. Its `unused`/`deadcode` linters are global;
  disable them in scoped mode (`--disable unused,deadcode`) or ignore those
  findings + note the gap.
- **Invocation:** `golangci-lint run --out-format json ./...`
- **Overlap:** makes jscpd/lizard redundant for Go. `go vet` is built-in and
  already wrapped. The single Go entry point.

### Python -- ruff (primary) + secondary design/type tools
- **ruff** -- AST linter reimplementing flake8/isort/pyupgrade/mccabe/bugbear +
  pylint subset. `ruff check --extend-select C901,B,SIM,PL,RUF,UP --output-format json .`
  Use `--extend-select`, NOT `--select`: defaults are only E/F, but `--select`
  would discard the repo's pinned rules + line-length and flood it; `--extend-select`
  keeps project config and adds the design/complexity rules. See `languages/python.md`.
  **Class:** local -- scope to the file list. (Only `F401` unused-*import* is
  truly per-file safe. An unused module-level *function/class* is NOT safe to
  call dead from a single-file scope -- it may be imported elsewhere; that's
  vulture/global territory, skip it in a scoped run.)
- **pylint** -- unique *refactoring* smells (R09xx: too-many-branches/args/locals,
  duplicate-code). `pylint --output-format json <pkg>`. Slower; deep runs only.
  **Class:** local for R09xx; `duplicate-code` is relational.
- **vulture** -- dead code. `vulture <path> --min-confidence 80`.
  **Class:** global -- skip in scoped mode + note.
- **mypy / pyright** -- type smells. `mypy --no-error-summary <pkg>` /
  `pyright --outputjson`. **Class:** local (per-file diagnostics), but needs the
  whole package importable to resolve types -- run on the package, filter to target.
- **Overlap:** ruff covers most of flake8-family; pylint adds design smells ruff
  lacks; vulture adds dead-code ruff does not fully cover.

### JS / TS -- ESLint + typescript-eslint (project-local)
- **Dimensions:** idioms, complexity, dup, bugs, framework rules.
- **Plugins:** `eslint-plugin-sonarjs` (cognitive complexity, duplicated
  branches), `eslint-plugin-unicorn` (modernization), framework plugins
  (react/react-hooks, vue, svelte, jsx-a11y).
- **Invocation:** `npx eslint --format json .`
- **Class:** eslint/`tsc` are **local** (scope to file list -- `tsc` needs the
  project but reports per-file). `knip` (dead files/exports/deps) and `madge`
  (cycles) are **global** -- skip in scoped mode + note. `type-coverage` is local.
- **Also:** `tsc --noEmit --strict` (type smells), `knip` (dead files/exports/
  deps: `npx knip --reporter json`), `madge --circular --json src` (cycles),
  `type-coverage --detail` (`any` leakage). `biome` is a fast formatter+linter
  alternative covering JSON too: `npx biome lint --reporter=json`.
- **Overlap:** ESLint+sonarjs make jscpd/lizard redundant for JS/TS.

---

## Format & functional validators

| Target | Tool | Class | Invocation | Mechanism / notes |
|--------|------|-------|-----------|-------------------|
| Shell | shellcheck | local | `shellcheck -f json <files>` | dataflow on var use/quoting; essential |
| Shell | shfmt | local | `shfmt -d .` | formatting diff |
| SQL | sqlfluff | local | `sqlfluff lint --format json --dialect <d> <path>` | dialect-aware anti-patterns |
| SQL | squawk | local | `squawk <migration.sql>` | dangerous-migration linter (Postgres); deep runs |
| CSS/SCSS | stylelint | local | `npx stylelint --formatter json "**/*.{css,scss}"` | AST; add `declaration-strict-value` for magic numbers |
| JSON | biome | local | `npx biome lint --reporter=json <files>` | dup keys, formatting |
| JSON | check-jsonschema | local | `check-jsonschema --schemafile <s> <f>` | schema conformance |
| YAML (format) | yamllint | local | `yamllint -f parsable .` | Norway/truthy, dup keys, indent |
| TOML | taplo | local | `taplo lint` / `taplo fmt --check` | lint + fmt + schema |
| OpenAPI | spectral | local | `spectral lint -f json <spec>` | rule-based on resolved spec graph |
| OpenAPI | vacuum | local | `vacuum lint -d <spec>` | faster spectral alternative |
| OpenAPI | oasdiff | **baseline** | `oasdiff breaking <base> <head>` | breaking-change vs. base ref (ref targets) |
| GraphQL | graphql-eslint | local | via ESLint config | SDL smells |
| GraphQL | graphql-inspector | **baseline** | `graphql-inspector diff <old> <new>` | breaking-change detection |
| Protobuf | buf | local + **baseline** | `buf lint` (local) / `buf breaking --against "<buf-input>"` (baseline; e.g. `.git#ref=<base-ref>,subdir=<proto-dir>`) | AST lint + breaking-change |
| Terraform | tflint | local | `tflint -f json` | provider-aware rules |
| Terraform | trivy/checkov | local | `trivy config --format json .` / `checkov -d . -o json` | misconfig |
| Dockerfile | hadolint | local | `hadolint -f json <Dockerfile>` | AST; embeds shellcheck for RUN |
| Kubernetes | kube-linter | local | `kube-linter lint --format json <path>` | limits, probes, runAsNonRoot |
| Kubernetes | kubeconform | local | `kubeconform -output json <files>` | schema validity |
| CI (GHA) | actionlint | local | `actionlint -format '{{json .}}'` | workflow AST + embeds shellcheck |
| CI (GHA) | zizmor | local | `zizmor --format json <workflow>` | security dataflow (PR-target injection) |
| CI (GHA) | pinact | local | `pinact run --check` | action pinned-to-SHA check |
| Docs | markdownlint-cli2 | local | `markdownlint-cli2 "**/*.md"` | markdown smells |
| Docs | lychee | local | `lychee --format json .` | dead-link check |

## Security / misconfig (cross-cutting)

| Tool | Invocation | Covers |
|------|-----------|--------|
| trivy | `trivy fs --scanners misconfig,vuln,secret --format json .` | IaC misconfig, CVEs, secrets -- one tool, TF+Docker+k8s |
| checkov | `checkov -d . -o json` | deep IaC policy checks |
| gitleaks / trufflehog | (the **secrets-scan** package wraps these) | credential detection |

For credential detection prefer the repo's existing `secrets-scan` package
rather than re-running scanners here; this catalog includes gitleaks only so the
installer can provision it where absent.

## Apply path (step 7)

Low-risk refactors are applied by the **main thread / coder**, using its
knowledge of the codebase -- not by a deterministic rewriter. (ast-grep
`sg run -p <pat> -r <rewrite>` exists for structural rewrites but is
intentionally not a dependency; the agent decides edits per the verified plan.)
