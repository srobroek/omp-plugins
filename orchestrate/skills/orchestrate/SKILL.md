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
2. Write the bead DAG: parent, epics, features, and tasks with explicit dependencies.
3. Label every bead with its `role:` label before dispatch.
4. Dispatch one worker per needed role in ONE task batch.
5. Let workers pull ready beads for their own role, claim them, execute them, and yield evidence.
6. Consume every worker yield; resolve missing evidence before advancing.
7. Require independent review before a merge.
8. Send mechanical steps to the bundled `sonic` agent.
9. Verify the repository-wide command yourself after review and integration.
10. Close the parent only after verification passes and all evidence is recorded.

## Topologies

| Situation | Choice |
|---|---|
| One delivery stream | One-tier: this session is the lead; write and drive the full DAG. |
| Multiple independently deliverable streams | Two-tier: decompose into epics; dispatch one `orchestrator` per epic; each orchestrator decomposes its epic into features and tasks. |

Set `task.maxRecursionDepth` to `3` before dispatching the two-tier topology. One-tier works with the default `task.maxRecursionDepth` of `2`.

## Rules

MUST dispatch all needed roles in one batch.
MUST make independent review precede every merge.
MUST have the shepherd aggregate review findings into one fix bead.
DEFAULT use pull-based worker execution until no ready bead carries the worker role.
NOT close a parent from worker claims alone; the lead runs the repository-wide command.
