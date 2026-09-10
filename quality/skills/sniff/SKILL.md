---
name: sniff
description: Audit code for smells, map to refactoring.guru, and produce a vetted refactoring plan. Use when asked to sniff, audit quality, or plan a refactor.
---

# Sniff

Audit code smells, map surviving findings to refactoring.guru, and produce an
adversarially-vetted plan. Edit code only after explicit approval in step 7.

## Approval gates

Target resolution, stack detection, configuration reads, and read-only availability
probes are allowed before tool-set approval. Do not install tools, run substantive
scans, or dispatch a `bloodhound` until target and tool-set approval are established.

1. **Target.** If unnamed, ask first for the kind: whole repo, language/area,
   directory/module, files, uncommitted changes, commit, range/branch, or PR.
   Then ask for the required path/ref. Kinds compose. Never assume whole repo.
2. **Install set.** After stack detection, use `sniff_install_tools` `probe` and
   target references to present every viable analyzer. Default-on tools start
   selected; opt-in tools start unselected with their reason. Wait before install.

For a **non-interactive** run, use the target and installed tool set explicitly
authorized by the user or delegated brief; record gaps and never install tools.
Missing scope or tool-set authorization remains blocked; unavailability is not consent.

This SKILL is a router. Load the referenced file for each step; do not inline its content.

**Skill dir vs. target dir.** Tools run with cwd = the *target* repo, but this skill's
shipped assets live under `skill://sniff/` (`references/semgrep-rules/`).
Read those via `skill://sniff/<path>`. When a tool needs a filesystem path (semgrep
`--config`), resolve the installed skill directory once and pass an absolute path.

## Workflow

LOAD `skill://sniff/references/workflow.md` before starting. Run in order:

1. **Resolve target & detect stack.** If user did not name a target, STOP and ask.
   LOAD `skill://sniff/references/targeting.md`: resolve to an explicit file list + base ref, decide
   in-place vs. isolated checkout (`isolated: true` / Worktrunk lease), and confirm scope. Detect every language/format
   present in the target and map each to `skill://sniff/references/languages/index.md`.
2. **Probe & propose the full tool set (mandatory blocking checkpoint, interactive runs).**
   Run `sniff_install_tools` (mode `probe`), enumerate every viable tool per detected
   language as a tiered table. **Stop and wait** unless the brief already authorizes that set.
   See `skill://sniff/references/tooling.md` + `skill://sniff/references/installer.md`.
   - **2.5. Inventory project lint config FIRST.** Before substantive scans, find and read
     every config that governs it. **Honor it** -- a rule the project disabled is advisory
     at most, never a regression. See `skill://sniff/references/workflow.md` Step 2.5.
3. **Tool-driven detection.** Run every selected analyzer through
   `sniff_run_analyzer`, honoring the Step 2.5 configuration. Its preflight and
   exact-path execution are atomic; record unavailable analyzers as coverage gaps.
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

## Rules

MUST Use real analyzers; no low-precision grep fallback for smell detection.
MUST Exact-file checksum/diff is allowed only as the duplication floor.
MUST Keep steps 1 to 6 read-only.
MUST Scope analyzers by local, relational, global, or baseline class.
MUST Headline base-ref breaking changes; skip and record invalid scoped global runs.
MUST Resolve shipped assets through `skill://sniff/`; pass absolute paths to tools.
MUST Run every selected analyzer only through `sniff_run_analyzer`; never invoke it through Bash, Eval, Hub, or a hand-built command.
MUST Pass selected hosted packages and the exact documented analyzer completion exits to `sniff_run_analyzer`.
MUST Prefix each Bash command during a sniff run with `OMP_SNIFF_ACTIVE=1`; this command-local marker activates the direct-analyzer advisory and grants no analyzer execution authority.
DEFAULT Load only references needed by the detected stack.

Modes: **quick** skips the full sweep/challenge; **full** runs all steps;
**plan-only** never applies changes. Debug annotations are off unless requested.

## References

| File | Load when |
|------|-----------|
| `references/workflow.md` | Always, before step 1 |
| `references/targeting.md` | Target resolution/reduction |
| `references/tooling.md` | Tool class, overlap, invocation |
| `references/installer.md` | Approved installation |
| `references/languages/index.md` | Stack routing |
| `references/languages/<lang>.md` | Detected target reading |
| `references/scout-brief.md` | `bloodhound` dispatch |
| `references/refactoring-catalog.md` | Mapping |
| `references/adversarial-brief.md` | Challenge |
| `references/report-template.md` | Report |

## Agents

| Agent | Role |
|-------|------|
| `bloodhound` | Read-only language-slice detector |
| `refactor-challenger` | Read-only pragmatism critic |
