---
name: sniff
description: Audit code for smells, map to refactoring.guru, and produce a vetted refactoring plan. Use when asked to sniff, audit quality, or plan a refactor.
---

# Sniff

Audit code for smells and non-idiomatic patterns, then produce a prioritized,
adversarially-vetted refactoring plan. Advisory by default -- code is edited
**only** on explicit user approval (see step 7).

## ⛔ STOP -- two questions before you touch the code

Do NOT detect the stack, run a tool, or dispatch a `bloodhound` until BOTH are
answered. These are blocking gates, not preferences.

1. **Which target?** If the user did not explicitly name one, ask in **two steps**:
   - **Step 1a -- pick the target KIND.** Offer every time:
     `whole repo` · `language/area filter` (e.g. just Rust, just the frontend) ·
     `directory/module` · `file(s)` · `uncommitted changes` · `commit` ·
     `commit range / branch compare` · `PR`.
     A `language/area filter` resolves by detected-language / area glob, not one path.
     Always offer ref kinds (commit/range/branch/PR) even on a clean tree.
   - **Step 1b -- pin the specifics.** Once they pick a kind that needs an argument,
     ask for it. Kinds **compose** -- "the Rust in this PR" = PR target filtered to `.rs`.
   Do **not** assume whole repo.
2. **Which tools?** After resolving the target, run
   `sniff_install_tools` (mode `probe`). Propose the full thorough tool set --
   every viable tool for **each detected target** -- as a tiered table (default-on
   pre-selected ON, opt-in shown OFF with reason), and **wait**. "go" = install every
   missing default-on tool and run all. A missing default-on tool is an install, or a
   recorded coverage gap if the user declines.

Only exception: a **non-interactive** run (CI / sub-agent with no user to ask). Then
skip the prompts, use the named target or whole-repo, proceed with installed tools, and
record gaps.

This SKILL is a router. Load the referenced file for each step; do not inline its content.

**Skill dir vs. target dir.** Tools run with cwd = the *target* repo, but this skill's
shipped assets live under `skill://sniff/` (`references/semgrep-rules/`).
Read those via `skill://sniff/<path>`. When a tool needs a filesystem path (semgrep
`--config`), resolve the installed skill directory once and pass an absolute path.

## Workflow

Run in order. Full procedure is in `skill://sniff/references/workflow.md` -- LOAD it before starting.

1. **Resolve target & detect stack.** If user did not name a target, STOP and ask.
   LOAD `skill://sniff/references/targeting.md`: resolve to an explicit file list + base ref, decide
   in-place vs. isolated checkout (`isolated: true` / Worktrunk lease), and confirm scope. Detect every language/format
   present in the target and map each to `skill://sniff/references/languages/index.md`.
2. **Probe & propose the full tool set (mandatory blocking checkpoint, interactive runs).**
   Run `sniff_install_tools` (mode `probe`), enumerate every viable tool per detected
   language as a tiered table. **Stop and wait.** Non-interactive runs skip the prompt.
   See `skill://sniff/references/tooling.md` + `skill://sniff/references/installer.md`.
   - **2.5. Inventory project lint config FIRST.** Before running any tool, find and read
     every config that governs it. **Honor it** -- a rule the project disabled is advisory
     at most, never a regression. See `skill://sniff/references/workflow.md` Step 2.5.
3. **Tool-driven detection.** For each detected language, run installed tools per
   `skill://sniff/references/tooling.md`, honoring the Step 2.5 config. Skip + warn + record an install
   hint for absent tools.
4. **Detection reading.** For smells tools cannot see, read the code guided by
   `skill://sniff/references/languages/<lang>.md`. Small target → read inline. Otherwise propose a
   `bloodhound` fan-out plan -- one hound per language as the floor, splitting oversized
   languages by subtree/crate. Build each Brief from `skill://sniff/references/scout-brief.md`;
   include the `skill://sniff/references/languages/<lang>.md` path
   in the Brief so the hound does not resolve it from the target repository.
5. **Map to refactoring.guru.** Attach smell name, pattern(s), technique(s), and URL
   from `skill://sniff/references/refactoring-catalog.md`. Fetch the full technique page only when
   step-by-step detail is needed.
6. **Adversarial pass.** Stress-test with `refactor-challenger`. Build its Brief from
   `skill://sniff/references/adversarial-brief.md`. Drop or downgrade findings it refutes.
7. **Report & (optional) apply.** Emit the prioritized plan via `skill://sniff/references/report-template.md`.
   If the user explicitly approves, apply **low-risk/mechanical** refactors only, then
   re-run step 3 checks to verify.

## Hard rules

MUST Detection uses real tools -- no built-in low-precision grep fallback for smell detection. If no tool is installed for a dimension, skip it and tell the user what to install.
MUST Exception: a deterministic exact-match pass (checksums or `diff -q`/`git diff --no-index`) is allowed for byte-identical duplicated files. This is a floor, not a ceiling -- also read parallel/mirrored files for conceptual duplication checksums miss.
MUST Never edit code in steps 1 to 6. Apply only in step 7, only on explicit approval, always followed by a verification re-run.
MUST Scope each tool by its analysis class (local/relational/global/baseline -- see `skill://sniff/references/tooling.md`).
MUST For ref targets, headline breaking-change findings vs. the base. Global analyses (dead code, cycles, unused deps) are skipped + noted in scoped runs.
DEFAULT Resolve language/area filters by detected-language glob, not by directory path.
DEFAULT Always offer commit/range/branch/PR target kinds even on a clean tree.
- Load language docs and the refactoring catalog lazily -- only what the detected stack needs.
- Rust: standard toolchain (clippy pedantic/nursery + rustc) covers most dimensions; do not over-tool. See `skill://sniff/references/languages/rust.md`.

## Scope modes

- **quick** -- error handling, hardcoded values, naming, error-path smells; skip the full tool sweep and adversarial pass.
- **full** (default) -- all steps above.
- **plan-only** -- steps 1 to 6; never apply, even on approval.

**Debug mode** (orthogonal -- combine with any scope mode): OFF by default. Turn ON only when the user explicitly asks to debug the sniff RUN itself. See `skill://sniff/references/workflow.md` → "Debug mode".

## References

| File | When to load |
|------|--------------|
| `skill://sniff/references/workflow.md` | Always, before step 1 |
| `skill://sniff/references/targeting.md` | Step 1: any non-whole-repo target |
| `skill://sniff/references/tooling.md` | Steps 2 to 3: tool catalog, invocation, overlap/gaps, analysis class |
| `skill://sniff/references/installer.md` | Step 2: install-flow contract and bundles |
| `skill://sniff/references/languages/index.md` | Step 1: route stack → language docs |
| `skill://sniff/references/languages/<lang>.md` | Step 4: per-language smells/idioms/tools |
| `skill://sniff/references/scout-brief.md` | Step 4: build the `bloodhound` Brief |
| `skill://sniff/references/refactoring-catalog.md` | Step 5: smell → pattern → technique + URLs |
| `skill://sniff/references/adversarial-brief.md` | Step 6: build the `refactor-challenger` Brief |
| `skill://sniff/references/report-template.md` | Step 7: prioritized plan format |

## Agents

| Agent | Role | Spawned |
|-------|------|---------|
| `bloodhound` | Read-only per-language smell detector | Step 4, per-language (large languages split across several), parallel |
| `refactor-challenger` | Read-only adversarial pragmatism critic | Step 6, once over the finding set |
