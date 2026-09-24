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
   `python3 skills/orchestrate-preflight/preflight.py --json --packages-root PACKAGES_ROOT --beads-preflight BEADS/skills/beads-preflight/preflight.py --worktrunk-preflight WORKTRUNK/skills/worktrunk-preflight/preflight.py --base BASE_SHA`
2. Read the JSON `checks` array. Sibling checks are prefixed `beads.` and `worktrunk.`; each check has `id`, `status`, `detail`, and `fix`.
3. `claim-pools` runs `bd config get claim.pools` in the repository's configured Beads environment and verifies all six exact aliases: `pool:implementer`, `pool:implementer-high`, `pool:work-reviewer`, `pool:researcher`, `pool:shepherd`, and `pool:operator`. A missing or failed configuration check is `fail`; its fix is `bd config set claim.pools "pool:implementer,pool:implementer-high,pool:work-reviewer,pool:researcher,pool:shepherd,pool:operator"`.
4. Record the verdict in the governing run or epic bead metadata as `execution_preflight`, and record the same run SHA as `base_sha`.
5. Dispatch only when `ok` is `true`. A `fail` check blocks dispatch; `warn` and `skip` checks do not.

The session-side `read rule://beads-ledger` check determines whether the Beads companion is loaded; an on-disk sibling preflight cannot establish this. If that rule does not resolve, report `BLOCKED: beads companion not loaded`, dispatch nothing, and run no `bd` write. If the worktrunk preflight is `skip` because its package or check is absent, the companion is unavailable: stop and report; do not dispatch workers.

## Rules

MUST run this once before the first worker dispatch, even when one sibling package is absent.
MUST pass the same recorded `base_sha` to every worker's `wt switch --base` command.
DEFAULT treat every sibling `fail` as a run-level failure; the script computes `ok` from all merged checks.
NOT use `--apply` unless hook approval changes are explicitly authorized; it forwards `--apply` only to the worktrunk sibling.
