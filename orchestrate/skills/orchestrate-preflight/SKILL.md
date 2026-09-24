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
3. `model-roles` verifies the eight shipped orchestrate agents have string-valued `task.agentModelOverrides` entries and resolvable string-valued `modelRoles` selectors; malformed mappings, malformed model-list output, and stale `orc-*` override keys fail the check and are not aliased.
4. Record the verdict in the governing run or epic bead metadata as `execution_preflight`, and record the same run SHA as `base_sha`.
5. Dispatch only when `ok` is `true`. A `fail` check blocks dispatch; `warn` and `skip` checks do not.

If a sibling beads or worktrunk preflight is `skip` because its package or check is absent, the companion is unavailable: stop and report; do not dispatch workers.

## Rules

MUST run this once before the first worker dispatch, even when one sibling package is absent.
MUST pass the same recorded `base_sha` to every worker's `wt switch --base` command.
DEFAULT treat every sibling `fail` as a run-level failure; the script computes `ok` from all merged checks.
NOT use `--apply` unless hook approval changes are explicitly authorized; it forwards `--apply` only to the worktrunk sibling.
