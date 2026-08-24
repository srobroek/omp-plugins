# Sniff Workflow

The full procedure behind `SKILL.md`. Run the steps in order. Each step names
its stop/report point -- do not silently merge steps.

## Step 0 -- Scope the run

Confirm with the user (or infer from the request) which scope mode applies:

- **quick** -- error handling, obvious smells, hardcoded values, naming only.
  Skip the full tool sweep (step 3 runs only already-installed tools) and skip
  the adversarial pass (step 6). Use for a fast read.
- **full** (default) -- every step below.
- **plan-only** -- steps 1 to 6; never apply in step 7, even on approval.

Also establish the **target** (resolved in step 0.5). **There is no default
target** -- if the user did not name one, ask in **two steps**, and wait:

1. **Target KIND** -- present the full taxonomy every time: `whole repo` ·
   `language/area filter` (just Rust, just the frontend, …) · `directory/module`
   · `file(s)` · `uncommitted changes` · `commit` · `commit range / branch
   compare` · `PR`. A `language/area filter` is a distinct kind, NOT a
   `directory/module`: "just Rust" = every `.rs` wherever it lives, "the
   frontend" may span dirs -- resolve by detected-language / area glob, not one
   path. Don't drop the ref kinds (commit/range/branch/PR) when the tree is clean.
2. **Specifics** -- once they pick a kind that takes an argument, ask for it
   (which language(s)/area, which dir/file, which commit SHA, which base/head or
   branch, which PR#). `whole repo` and `uncommitted changes` need no follow-up.
3. **Kinds compose.** A language/area filter layers on any other kind -- "the Rust
   in this PR" is the PR file set intersected with `.rs`. Offer it as a
   refinement, and accept it combined with another kind.

Do not assume whole repo on a bare "sniff" -- it is the most expensive option and
rarely the intent. Resolve the chosen target in Step 0.5.

### Debug mode (orthogonal toggle -- combine with any scope mode)

Off by default. Turn ON only when the request is about **sniff's own behavior**
("debug the sniff", "why did sniff drop this file?") -- not when the user is
debugging their own code.

Debug changes only what is narrated, never what is decided: same findings, same
safety rules. Add one or two terse `[debug]` lines per step annotating the
decision that step made -- which reduction rules fired and their counts, the exact
command and exit code per tool (and the reason for each skip), the inline-vs-
fan-out basis, and the reason behind each KEEP/DOWNGRADE/DROP verdict.

## Step 0.5 -- Resolve the target scope

Do not reach this step without a target the user chose (see Step 0 -- never
default to whole repo silently). Once chosen: if the target is anything other
than the whole repo, resolve it before detecting the stack. LOAD
`references/targeting.md` and follow it to produce:

1. an explicit, deduplicated **file list** (drop deleted/binary/generated/vendored),
2. a **base ref** when the target is a diff/commit/range/branch/PR,
3. a **materialization** decision -- operate **in place** (working tree, module,
   files) or **check the ref out into a throwaway git worktree** (commit, range,
   branch, PR) so tools read the code as it is at that ref.

Echo the resolved file list (or count + sample) so the user confirms scope before
any tool runs. Every later step operates on this file list (and, for ref targets,
inside the worktree). Whole-repo runs skip this step.

**Report:** the target kind, resolved file count, base ref (if any), and whether
a worktree was created.

## Step 1 -- Reduce file set & detect stack

First, **reduce the file set -- on EVERY target, including whole-repo.** Apply the
file-set reduction in `references/targeting.md` (drop committed vendored/build/
tool dirs like `archive/`, `node_modules/`, `apm_modules/`, `.specify/`, `target/`;
drop generated files by header marker / lockfile name / `linguist-generated`;
drop binaries). `.gitignore` does not cover committed vendor/generated trees, so
this step is required even when the user said "the whole repo". Echo first-party
counts so exclusions are visible. Detecting languages **by the file types
actually present in the reduced set** -- never from languages merely *mentioned*
in prose, config, or dependency lists.

Then identify every language and format present in the reduced set and the config
that governs each (e.g. `Cargo.toml`, `go.mod`, `tsconfig.json`, `pyproject.toml`,
`.eslintrc*`, `.golangci.yml`, `.tflint.hcl`, and `.editorconfig` for
indent/line-length). A format counts as **detected** only if it carries
logic/contract/config a language doc targets -- pure-data JSON, prose Markdown,
and a metadata-only `package.json` (no JS/TS source) are NOT a detected stack.
Use `references/languages/index.md` to map each detected language to its doc.

**Empty-set early-exit (do NOT skip).** If reduction leaves no files in a
sniffable *source* language -- a docs-only / config-only / tooling-only target, or
a pure-deletion diff -- **STOP and report** e.g. "target reduced to N config/
generated files, no source code in scope -- nothing to sniff." Do **not** fall
back to whole-repo (that violates the chosen scope), and do **not** analyze
generated/tooling files to manufacture findings. This is the most common
fresh-agent trap on chore/migration/docs-only diffs.

**Report:** first-party file count (with what was excluded), the detected stack,
and which language docs you will use.

## Step 2 -- Probe and offer tools

**Non-interactive runs (no user to prompt -- CI, a sub-agent, an automated
invocation): never install and never block on a menu.** Run `--probe`, use the
tools that are already usable, and record every missing tool as a coverage gap.
The install menu below is interactive-only. (A tool reported `SHIM`/unrunnable by
the probe counts as missing -- do not try to use it.)

The interactive flow -- **mandatory, blocking checkpoint. Do NOT begin detection
(Step 3) until the user has confirmed the tool set.** The model is **propose the
full thorough set, user deselects** -- NOT "pick a depth" and NOT "the installed
tools looked adequate". Every viable tool for the detected stack is pre-selected
ON by default; the user trims, they don't opt in.

1. Run `scripts/install-tools.sh --probe`.
2. **Enumerate EVERY viable tool for each detected TARGET** -- this means every
   programming language AND every config/format/contract/infra target present:
   Terraform, Dockerfile, Kubernetes manifests, CI workflows, OpenAPI, GraphQL,
   Protobuf, SQL, shell, YAML/JSON/TOML, Markdown, CSS -- each has its own doc
   under `references/languages/` (the dir name is historical; it holds ALL target
   docs, not just languages -- see `references/languages/index.md`). Pull each
   detected target's tool table from its doc, plus the cross-language default-on
   set from `references/tooling.md`. Do not stop at programming languages and do
   not silently omit a target because it's "just config/infra" -- a Dockerfile or
   a `.tf` dir is a detected target with default-on tools (hadolint, tflint, …).
   A missing default-on tool is an *install*, not an omission.
3. Present a **tiered table per detected language**:

   ```
   <LANGUAGE>            installed?   dimension                 tier      action
     <tool>              ✓ / ✗ / SHIM <what it catches>         ON        (use / → install via <mgr>)
     <opt-in tool>       ✗            <dimension>               opt-in    off unless you want it
   ```
   - **default-on** tools are pre-checked ON (install the missing ones).
   - **opt-in** tools are shown but OFF, each with the one-line reason it's
     opt-in (nightly / redundant-with-X / heavy / security-only / needs-baseline),
     from the language doc.
   - Note **overlap** so a deselect is informed (e.g. "sonarjs already covers
     JS/TS complexity+dup, so lizard/jscpd add nothing here").
4. **STOP and wait.** Default action if the user just says "go" = install every
   missing **default-on** tool and run the full set. The user may deselect any
   ("skip type-coverage") or enable an opt-in ("add cargo-udeps"). Install with
   `install-tools.sh --install <bundle>...`. **Never auto-install without the
   confirmation; never silently drop a default-on tool.** If the user declines an
   install, proceed without it and record the **coverage gap** in the report.

**Report:** the resolved tool set per language (on / opt-in-skipped / gap), so the
coverage section is honest about what ran. If you reach Step 3 without having
enumerated and confirmed the full per-language set, you skipped a required step.

## Step 2.5 -- Inventory the project's existing lint config (MANDATORY, before any tool runs)

A tool run that ignores the repo's own configuration produces a flood of false
positives the maintainer already silenced -- the single worst failure mode of
this skill (e.g. forcing clippy `-W pedantic -W nursery` onto a repo that pins
`[lints.clippy]` yields hundreds of deliberately-allowed warnings). So before
Step 3, **find and read** every config that governs a detected tool, and let it
dictate the invocation:

- Rust: `[lints.clippy]` / `[lints.rust]` in `Cargo.toml` (workspace + crate),
  `clippy.toml`, `rust-toolchain.toml`.
- Python: `[tool.ruff]` (`select`/`ignore`/`extend-select`/`per-file-ignores`),
  `[tool.pylint]`, `[tool.mypy]`/`mypy.ini`, `setup.cfg`, `.flake8`.
- JS/TS: `eslint.config.*` / `.eslintrc*`, `biome.json`, `tsconfig.json`
  (`strict`, `compilerOptions`), `.prettierrc`.
- Go: `.golangci.yml`. Shell: `.shellcheckrc`. CSS: `.stylelintrc*`.
  YAML/MD: `.yamllint`, `.markdownlint*`. Cross-cutting: `.editorconfig`.

Rules:
- **Honor it.** Run each tool the way the repo configures it (ruff
  `--extend-select` not `--select`; clippy with NO extra `-W` when a clippy
  config exists; respect `per-file-ignores`, disabled rules, configured
  line-length/indent). The language docs' invocations are the *no-project-config*
  fallback, not an override.
- **A rule the project disabled is NOT a finding.** If you run a broader rule set
  than the project enables, mark anything that only fires under your widening as
  **advisory/low -- "the project opted out"**, never as a regression. Drop
  artifacts like `RUF100` unused-noqa whose referenced rule isn't in the
  project's own select.
- **Record the config you found** in the coverage note, so the report shows which
  rules were in force.

**Report:** the per-tool config inventory and how it shapes each invocation.

## Step 3 -- Tool-driven detection

**Before running each language's tools, read that language doc's *Pragmatism
notes* and *Idioms* sections** -- they tell you how to invoke the tool so it does
not generate noise the project doesn't want (e.g. `markdownlint` with no
`.markdownlint*` config emits MD013 line-length by default → pass `--disable
MD013`; honor `.editorconfig` indent/line-length before flagging yamllint/
markdownlint defaults). Suppressing default-noise at invocation is not the same
as the Step 6 pragmatism pass -- do both.

For each detected language, run the installed tools using the exact invocation
and machine-readable output flag from `references/tooling.md` and the language
doc. Rules:

- Respect the project's own tool config; do not override it. (This is why ruff
  uses `--extend-select` not `--select`, and clippy adds `-W pedantic` only when
  the repo pins no clippy config -- see the language docs.)
- For any catalog tool that is **not** installed (or reported `SHIM`/unrunnable
  by the probe), skip it, warn, and record an install hint -- never fail the run.
- Collect findings verbatim (tool, rule id, file:line, message). Do not yet
  prioritize.
- **Re-filter tool output through the Step-1 reduced set -- on every run,
  including whole-repo.** Directory-taking tools (clippy per-package, `semgrep .`,
  config-file linters) do NOT honor your file list, so they surface findings in
  generated/vendored files you already dropped. Intersect every tool's findings
  with the reduced set before reporting; reduction is both an input scope AND an
  output filter.

**When the run is scoped** (target is not the whole repo), apply each tool's
**analysis class** from `references/tooling.md` (per `targeting.md`):

- **local** tools → pass the target file list directly.
- **relational** tools (duplication, coupling) → run over target + context,
  report only links touching a target file.
- **global** tools (dead code, cycles, unused deps) → **skip and note** ("needs
  whole-project context; scoping to a diff reports false positives -- run a full
  sniff"). Never file-scope a global tool.
- **baseline** tools (breaking-change) → run against the base ref; **headline**
  any contract break as a top-severity report section.

In **quick** mode, run only tools already installed; do not prompt to install.

## Step 4 -- Detection reading

Tools miss design-level smells: poor names, low cohesion, wrong abstraction
level, non-idiomatic constructs, conceptual duplication. Read the code for these,
guided by `references/languages/<lang>.md` (its smell checklist + idioms).

Decide inline-vs-fan-out, then -- if fanning out -- **propose a fan-out plan and
let the user adjust it** (don't silently fix it at one hound per language; a
29k-LOC Rust crate set deserves more than one hound, a 12-file repo deserves
none).

**First, the inline gate (no proposal needed):**
- **You are already a sub-agent** (spawned by another skill) → always read inline;
  you can't spawn. This wins over everything else.
- **Small target** -- single language ≤ 50 files AND ≤ 10k LOC, or a multi-language
  target with only a handful of files per language → **read inline**. Don't spawn
  3 agents for 12 files.

**Otherwise, propose a plan and confirm (interactive runs):**
1. Compute a default split from the resolved per-language counts: **one hound per
   language**, and **split any single language that exceeds the threshold
   (~50 files / ~10k LOC) into N hounds by subtree/crate/dir**, so no one hound
   carries an oversized slice. Cap total parallelism at a sane number (≈8).
2. **Show the proposed plan** -- e.g. `Rust 29k LOC/141 files → 3 hounds (core /
   cli / gui); Vue+TS 7k/63 → 1 hound`. State the file/LOC basis.
3. **Let the user adjust** -- more/fewer hounds, a different split, or "just
   inline it". Accept their change; then spawn. (Non-interactive runs skip the
   confirmation and use the computed default.)

When you fan out: build each Brief from `skill://sniff/references/scout-brief.md` -- pass the
**resolved target file list** (and the worktree path, for ref targets) as the
Scope so each agent reads only the target. The language-reference field MUST be
`skill://sniff/references/languages/<lang>.md` (or the installed skill's absolute
path to that file), because the agent's cwd is the target repository. Collect
each agent's structured findings.

**Don't re-run tools the hound was handed (no double-run).** Step 3 already ran
the static-analysis tools -- config-correct, per the Step 2.5 inventory. So in
each Brief, **pass that language's Step-3 findings** and tell the hound the tools
have already run: its job is the **reading layer** (design smells tools can't
see) plus **verifying/contextualizing** the handed findings -- NOT re-running
clippy/ruff/eslint. Re-running wastes a compile and risks a *different*
(config-blind) invocation than Step 3 used. Only ask a hound to run a tool itself
when Step 3 did **not** cover it for that language (e.g. quick mode skipped it,
or a tool became available only inside the worktree).

Every finding must cite a specific `file:line`. No guessing.

**Report:** consolidated raw findings (tool-driven + reading), deduplicated.

## Step 5 -- Map to refactoring.guru

For **every** finding that maps to a catalog smell, attach from
`references/refactoring-catalog.md` -- and these go in the report's structured
columns, NOT just prose:

- the **smell** name + its canonical refactoring.guru **URL**,
- the recommended **refactoring pattern/technique** + its **URL**.

This is required per row: the report plan table's "Smell → refactoring (guru
URL)" cell must be filled for each finding that has a catalog mapping -- a finding
where the field is blank or the URL only appears in surrounding prose is
incomplete. Findings with no catalog analogue (e.g. a pure runtime bug, a
tool-specific lint) say "--" explicitly rather than being left ambiguous.

Use the baked catalog as the index. Fetch the full technique page (via the
web-fetch/fetcher tool) **only** when a finding needs step-by-step mechanics the
index summary does not give. Do not fetch on every finding.

## Step 6 -- Adversarial pass (pragmatism filter)

Stress-test the recommendation set with the `refactor-challenger` agent before
presenting anything. Build its Brief from `references/adversarial-brief.md`:
pass the findings + evidence, **not** your reasoning or preferred plan.

**If you cannot spawn a sub-agent** (you are already a sub-agent, or spawning is
unavailable), do the pass **inline**: re-read each KEEP candidate against the
language doc's *Pragmatism notes* and assign KEEP / DOWNGRADE / DROP yourself,
adopting the challenger's skeptical stance. (Mirror the inline/fan-out choice in
Step 4.) Do not skip the pass just because you can't spawn.

The challenger (or your inline pass) returns KEEP / DOWNGRADE / DROP verdicts.
Apply them:

- **DROP** -- remove (false positive, or the fix makes the code worse).
- **DOWNGRADE** -- keep but deprioritize / lower severity.
- **KEEP** -- carry into the plan.

This is where pragmatism is enforced: no parameter object for a one-arg
function, no pattern applied by rote, no fighting the language's idiom. Skip
this step only in **quick** mode.

## Step 7 -- Report and (optional) apply

1. Emit the prioritized plan using `references/report-template.md`: every
   surviving finding with **impact, value, cost, severity, and
   backwards-compatibility**, ordered so the highest value-per-cost is first.
2. **Apply is opt-in and explicit.** Do nothing to the code unless the user
   names what to apply. When they do, and the mode is not plan-only:
   - apply **only low-risk/mechanical** refactors (rename, extract function,
     inline variable, guard clause, dead-code removal) -- never behavior-changing
     or public-surface changes without a separate explicit go-ahead,
   - re-run the relevant step-3 checks to verify nothing regressed,
   - report what changed and the verification result.
3. Anything risky stays advisory in the plan.

**Final output contract:** summary counts, the prioritized plan table, the
coverage/gaps note (which tools ran, which were skipped and why), and -- if
anything was applied -- the diff summary plus verification result.
