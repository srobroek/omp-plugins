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
Use the epic or molecule dependency graph as the durable work DAG. The orchestration harness owns dispatch and claim choreography; read `rule://beads-lifecycle` for lifecycle gates.

DEFAULT `bd swarm status <root> --json` is a coarse progress view and omits
external blockers, gates, deferral, and custom state.
DEFAULT Create a swarm marker only when durable coordinator discovery,
coordinator replacement, or an external scheduler needs a handle.
NOT Create a swarm for an ordinary delegated task or merely to make an epic
persistent; the epic or molecule is already durable.

## Merge slot
Use the project's merge slot only to serialize integration. Acquire and release it through the configured beads tooling; the harness owns holder identity and wait behavior. See `rule://beads-carriers` for durable outcome recording.
