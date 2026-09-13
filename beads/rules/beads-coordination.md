---
name: beads-coordination
description: "Swarms and merge slots: building the work DAG, validating it, and serialising integration across concurrent agents."
---

# Beads Swarms and Merge Slots

## Delegation

For non-orchestrated delegation, pass the bead id and scope so the worker can
claim the intended work before acting. When using `skill://orchestrate`, workers
pull their own queues; do not activate that protocol with a bead-id message.

## Swarms

MUST Use an epic or poured molecule and its dependency edges as the work DAG;
a swarm marker does not create tasks, claims, or another state store.
MUST Run `bd swarm validate <root> --json` after graph construction, after each
structural change, during recovery, and before close-out.
MUST Stop on `swarmable=false`; inspect warnings because external dependencies,
disconnected nodes, multiple endpoints, and empty graphs may remain warnings.
MUST Dispatch epic work with `bd ready --parent <epic> --unassigned --json` and
molecule work with `bd ready --mol <molecule> --unassigned --json`; never dispatch
from an unscoped repository-wide ready query.
DEFAULT `bd swarm status <root> --json` is a coarse progress view and omits
external blockers, gates, deferral, and custom state.
DEFAULT Create a swarm marker only when durable coordinator discovery,
coordinator replacement, or an external scheduler needs a handle.
NOT Create a swarm for an ordinary delegated task or merely to make an epic
persistent; the epic or molecule is already durable.

## Merge slot

MUST Use the project's single merge slot only to serialize integration; approval
order remains in the workflow and human approval remains a gate.
MUST Acquire atomically with one stable holder identity. The `--wait` behavior
is enforced by `beads-merge-slot-never-wait`.
MUST Recheck approval and integration anchors after acquisition, then release
with the same explicit `--holder` after recording the merge outcome.
MUST Recover a stale holder by checking slot state, recorded anchors, remote
state, and merge ancestry. Beads has no lease, heartbeat, timeout, or automatic
stale-holder recovery for the merge slot.
