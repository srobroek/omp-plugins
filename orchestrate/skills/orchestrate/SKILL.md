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
8. Dispatch one worker per needed role in one task batch. Every worker brief MUST pass the lead's runtime id as `<leadId>` and MUST tell the worker to report only with `write agent://<leadId>`, NEVER `write agent://all`; a worker MAY confirm the id against the `Parent` shown by `read history://<own-id>`. Workers keep pulling until no ready bead carries their pool alias. The lead then YIELDS so OMP parks it and wakes it for each result or message.
9. When a lead wakes, consume what arrived, resolve missing evidence, and YIELD again while work remains open. Never poll to discover completion; follow the root-only `wait` rule in `rule://orchestrate-process`.
10. After work-reviewer approval, create one `pool:shepherd` merge bead with `epic_id`, `source_branch`, exact `source_head`, `target`, `repo`, `review_citation`, and `pr` for PR work; add the work-to-merge dependency and ensure one shepherd per epic is running. Wake an idle shepherd with `write agent://ID` when a new merge bead appears.
11. Require the shepherd to verify exact-head evidence, serialize merges, record evidence, and leave conflicts open for the lead; use the existing delivery path for PR merges.
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
