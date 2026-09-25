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

1. Before preflight, read `rule://beads-ledger`; if it does not resolve, report `BLOCKED: beads companion not loaded`, dispatch nothing, and run no `bd` write.
2. Read the goal, acceptance criteria, repository state, and verification command.
3. Create the parent and dependency DAG in beads before dispatch; make dependencies and research evidence durable on beads.
4. Give every dispatchable bead its role's claim-pool assignment (`pool:implementer`, `pool:implementer-high`, `pool:work-reviewer`, `pool:researcher`, `pool:shepherd`, or `pool:operator`), `execution_*` metadata, acceptance and routing context before dispatch; populate git anchors as they become known.
5. Explicitly instruct every main-agent, lead, parent, and sub-lead worker to pull its role queue; follow `rule://orchestrate-process` for the exact pull, claim, worktree, evidence, review, repair, and conflict protocol.
6. Choose one-tier or two-tier topology from achievable coordination load: non-contending concurrent workers, internal DAG depth, and the lead's evidence bottleneck. Never choose two-tier from epic count alone.
7. For two-tier work, retain `task.maxRecursionDepth=3`; the default 2 cannot contain root, orchestrator, worker, and helper.
8. Dispatch one worker per needed role in one task batch. Every worker brief MUST pass the lead's runtime id as `<leadId>` and MUST tell the worker to report only with `write agent://<leadId>`, NEVER `write agent://all`; a worker MAY confirm the id against the `Parent` shown by `read history://<own-id>`. Workers pull their role queue, claim with `bd update ID --claim`, and call the registered `pool_wait` tool with the exact pool and lead-owned epic id whenever the filtered queue is empty. `pool_wait` blocks in-process without a model turn; workers yield only after its timeout or an error. The lead then YIELDS so OMP parks it and wakes it for each result or message.
9. When a lead wakes, consume what arrived, resolve missing evidence, and YIELD again while work remains open. Never poll to discover completion; follow the root-only `wait` rule in `rule://orchestrate-process`.
10. After work-reviewer approval, the owning epic orchestrator integrates each worker itself: verify the source worktree `git rev-parse HEAD` equals the exact approved head, run `git merge-tree --write-tree EPIC_HEAD WORKER_HEAD`, create one implementer fix bead and stop on any conflict, then run `wt merge EPIC_BRANCH --no-squash --no-ff` from the source worktree. Retry a merge-policy refusal only with both explicit flags, never plain `wt merge`; record `merge_sha` on the work bead and close it natively. In two-tier runs, sub-epic orchestrators merge their workers and the root lead owns the root epic.
11. After all workers are integrated and the epic verification passes, spawn exactly one shepherd for the epic only when an epic-to-default PR exists or is required. The shepherd opens or refreshes that PR, verifies exact-head bot review and `gh pr checks`, calls `delivery_land`, performs native receipt-bead close-out, and calls `delivery_cleanup`. Do not spawn a shepherd when no epic-to-default PR exists. Tier1 single-epic runs still land their epic through the shepherd; in two-tier runs only the root lead's shepherd lands to default.
12. Verify the repository-wide command yourself after review and integration, then close the parent only when verification and durable evidence pass.

## Topologies

| Situation | Choice |
|---|---|
| Coordination load fits one lead and workers do not contend | One-tier: this session is the lead; drive the full DAG. |
| Coordination load has non-contending concurrent workers, meaningful internal DAG depth, and a lead evidence bottleneck | Two-tier: dispatch one orchestrator per independently coordinated stream; each owns its child DAG. |

## Rules

MUST use the pull-based protocol in `rule://orchestrate-process`, not direct assignment or prompt-only state.
MUST make independent review precede every merge.
MUST keep durable decisions, acceptance evidence, review findings, and closure reasons on beads or authoritative decision carriers; use `write agent://AGENT_ID` for live coordination, with workers restricted to their passed lead id and never broadcasting, as required by `rule://orchestrate-process`.
NOT close a parent from worker claims alone; the lead runs the repository-wide command.
