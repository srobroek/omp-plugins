---
name: sniff
description: Audit code for smells, map to refactoring.guru, and produce a vetted refactoring plan. Use when asked to sniff, audit quality, or plan a refactor.
---

# Sniff

Audit code smells, map surviving findings to refactoring.guru, and produce an
adversarially-vetted plan. Edit code only after explicit approval in step 7.

## Trigger gates

Before reading code or dispatching `bloodhound`, resolve two decisions:

1. **Target.** If unnamed, ask first for the kind: whole repo, language/area,
   directory/module, files, uncommitted changes, commit, range/branch, or PR.
   Then ask for the required path/ref. Kinds compose. Never assume whole repo.
2. **Install set.** After stack detection, use `sniff_install_tools` `probe` and
   target references to present every viable analyzer. Default-on tools start
   selected; opt-in tools start unselected with their reason. Wait before install.

Non-interactive runs use the named target, never install without authorization,
and record unavailable selected analyzers as coverage gaps.

## Workflow

LOAD `skill://sniff/references/workflow.md` before starting. Run in order:

1. Resolve and reduce the target with `references/targeting.md`; detect every
   first-party language, framework, format, and contract.
2. Build the exact analyzer plan from `references/languages/index.md`; inventory
   and honor each analyzer's project configuration before execution.
3. Run every analyzer through `sniff_run_analyzer`. Its per-invocation preflight
   and execution are atomic. Direct Bash/Eval/Hub runs provide no valid coverage.
4. Read tool-invisible smells using the detected language references. Small target:
   read inline. Large target: parallel `bloodhound` slices via `scout-brief.md`.
5. Map findings through `references/refactoring-catalog.md`.
6. Run `refactor-challenger` with `references/adversarial-brief.md`; apply every
   KEEP/DOWNGRADE/DROP verdict.
7. Report with `references/report-template.md`. Apply only explicitly approved
   low-risk changes, then rerun the affected analyzer invocations.

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
