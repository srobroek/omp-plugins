---
name: orchestrate
description: Runs a delivery DAG through ledger-backed role workers. Use when asked to orchestrate this project or run this as a DAG.
---

# Orchestrate

TRIGGER
+ "orchestrate this project"
+ "run this as a DAG"
- A single local change → handle it directly

## Workflow

1. Read the goal, acceptance criteria, repository state, and verification command.
2. Create the parent and dependency DAG in beads before dispatch; make dependencies and research evidence durable on beads.
3. Give every dispatchable bead its `agent:KIND` routing label, `execution_*` metadata, acceptance and routing context before dispatch; populate git and lease anchors as they become known.
4. Explicitly instruct every main-agent, lead, parent, and sub-lead worker to pull its role queue; follow `rule://orchestrate-process` for the exact pull, claim, worktree, evidence, review, repair, and conflict protocol.
5. Choose one-tier or two-tier topology from achievable coordination load: non-contending concurrent workers, internal DAG depth, and the lead's evidence bottleneck. Never choose two-tier from epic count alone.
6. For two-tier work, retain `task.maxRecursionDepth=3`; the default 2 cannot contain root, orchestrator, worker, and helper.
7. Dispatch one worker per needed role in one task batch. Workers keep pulling until no ready bead carries their role.
8. Consume every worker yield, resolve missing evidence, and repeat review/fix rounds until every criterion passes.
9. Require independent review before integration; only the lead resolves a merger-reported conflict.
10. Verify the repository-wide command yourself after review and integration, then close the parent only when verification and durable evidence pass.

## Topologies

| Situation | Choice |
|---|---|
| Coordination load fits one lead and workers do not contend | One-tier: this session is the lead; drive the full DAG. |
| Coordination load has non-contending concurrent workers, meaningful internal DAG depth, and a lead evidence bottleneck | Two-tier: dispatch one orchestrator per independently coordinated stream; each owns its child DAG. |

## Rules

MUST use the pull-based protocol in `rule://orchestrate-process`, not direct assignment or prompt-only state.
MUST make independent review precede every merge.
MUST keep durable decisions, acceptance evidence, review findings, and closure reasons on beads or authoritative decision carriers; use `hub` for live coordination.
NOT close a parent from worker claims alone; the lead runs the repository-wide command.
