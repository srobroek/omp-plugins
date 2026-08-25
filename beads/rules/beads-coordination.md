---
name: beads-coordination
description: Swarms and merge slots: building the work DAG, validating it, and serialising integration across concurrent agents.
---

# Beads Swarms and Merge Slots

SPAWN HANDOFF
MUST Pass the bead id in the spawn prompt so the worker claims it
  (`bd update <id> --claim`). An unpassed id leaves the bead unclaimed, and a
  parallel worker may take the same work.

SWARMS
MUST Use an epic or poured molecule and its dependency edges as the work DAG;
  a swarm marker does not create tasks, workers, claims, or another state store.
MUST Run `bd swarm validate <root> --json` after graph construction, after each
  structural change, during recovery, and before close-out.
MUST Stop on `swarmable=false`; inspect warnings because external dependencies,
  disconnected nodes, multiple endpoints, and empty graphs may remain warnings.
MUST Dispatch epic work with `bd ready --parent <epic> --unassigned --json`
  and molecule work with `bd ready --mol <molecule> --unassigned --json`; never
  dispatch from an unscoped repository-wide ready query.
DEFAULT `bd swarm status <root> --json` is a coarse progress view that omits
  external blockers, gates, deferral, and custom state.
DEFAULT Create a swarm marker with `bd swarm create` only when durable
  coordinator discovery through `bd swarm list`, coordinator replacement, or
  an external scheduler requires a discoverable coordination handle.
NOT Create a swarm for an ordinary delegated task or merely to make the epic
  persistent; the epic or molecule is already durable.

MERGE SLOT
MUST Use the project database's single merge slot only to serialize integration;
  approval order remains in the workflow, and human approval remains a gate.
MUST Acquire atomically without `--wait` using one stable holder identity;
  stop and report when another holder owns the slot.
NOT Treat Beads 1.1.0 waiters as a FIFO queue: `--wait` records an advisory
  waiter but does not block, transfer ownership, or remove stale waiters.
MUST Recheck approval and integration anchors after acquisition, then release
  with the same explicit `--holder` value after recording the merge outcome.
MUST Recover a stale holder by checking slot state, recorded anchors, remote
  state, and merge ancestry before release; Beads 1.1.0 has no lease,
  heartbeat, timeout, or automatic stale-holder recovery.

SYNC BOUNDARIES
DEFAULT Use one authority-aware pull before cross-machine claims or fan-out and
  one authority-aware push after durable updates at machine handoff.
MUST When authority is absent, record the pending sync and report the exact
  command instead of running it.
