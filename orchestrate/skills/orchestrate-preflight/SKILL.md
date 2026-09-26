---
name: orchestrate-preflight
description: Runs deterministic beads, worktrunk, and orchestration preflight checks; use before dispatching workers or when asked to run orchestration preflight.
---

# Orchestrate Preflight

TRIGGER
+ Before dispatching any worker for an orchestrated run
+ When asked to run the orchestration preflight
- A single local change → use the direct workflow instead

## Workflow

1. Record one immutable run base SHA, then run:
   `python3 skill://orchestrate-preflight/preflight.py --json --base BASE_SHA`
   The preflight discovers and runs the installed Beads and Worktrunk preflights automatically. `--packages-root`, `--beads-preflight`, and `--worktrunk-preflight` are overrides for a monorepo checkout only.
2. For a monorepo checkout, resolve override paths from the package root, not from a child worker's current directory. The orchestrator runs this lead-level preflight once per run before dispatch; child workers MUST NOT rerun it from linked worktrees and inherit `execution_preflight` and `base_sha` instead.
3. Read the JSON `checks` array. Sibling checks are prefixed `beads.` and `worktrunk.`; each check has `id`, `status`, `detail`, and `fix`.
4. `claim-pools` runs `bd config get claim.pools` in the repository's configured Beads environment and verifies all six exact aliases: `pool:implementer`, `pool:implementer-high`, `pool:work-reviewer`, `pool:researcher`, `pool:shepherd`, and `pool:operator`. A missing or failed configuration check is `fail`; its fix is `bd config set claim.pools "pool:implementer,pool:implementer-high,pool:work-reviewer,pool:researcher,pool:shepherd,pool:operator"`.
5. For every `fail` check with a non-empty `fix`, the lead MUST apply that fix when applicable, then rerun the complete preflight with the same immutable `base_sha`; dispatch remains blocked until the rerun has no blocking `fail`. NEVER waive, downgrade, or proceed on the original failed result. If a fix is missing, unsafe, unsupported, or not applicable in the current package/root, stop and report `BLOCKED` with the check, detail, and reason; an unapplicable fix is never a waiver.
6. Record the final verdict in the governing run or epic bead metadata as `execution_preflight`, and record the same run SHA as `base_sha`.
7. Dispatch only when `ok` is `true`. A `fail` check blocks dispatch; `warn` and `skip` checks do not.

## Rules

MUST run this once before the first worker dispatch; a missing beads or worktrunk sibling is a blocking `fail` whose fix installs it.
MUST pass the same recorded `base_sha` to every worker's `wt switch --base` command.
MUST apply every applicable reported fix and rerun the complete preflight before dispatch; NEVER waive a failed check. If the fix cannot be applied, stop and report the exact blocker.
DEFAULT treat every sibling `fail` as a run-level failure; the script computes `ok` from all merged checks.
NOT pass `--apply` without explicit authorization for hook changes; this does not waive other applicable fixes, which still require apply and rerun.
