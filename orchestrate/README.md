# Orchestrate

Orchestrate runs a delivery DAG through ledger-backed role workers, independent review, and exact-head integration.

## Agents

The package ships seven role agents:

| Agent | Responsibility |
|---|---|
| `orchestrator` | Owns an epic, builds its bead DAG, dispatches workers, and verifies delivery. |
| `implementer` | Implements one scoped bead and records reproducible evidence. |
| `implementer-high` | Handles reasoning-heavy or troubleshooting work with root-cause evidence. |
| `work-reviewer` | Judges every acceptance criterion and queues actionable fixes. |
| `researcher` | Answers one scoped question with cited observations and inferences. |
| `shepherd` | Owns review rounds and the serialized PR merge queue. |
| `merger` | Integrates one independently reviewed branch at one exact verified head. |

Mechanical `agent:operator` beads route to the bundled `sonic` agent as documented by the roles rule.

## Rules

### `orchestrate-process`

Defines pull-based ownership, preflight, durable Beads evidence, worktree isolation, review repair, and integration ownership. It also requires targeted waiting: dispatched results auto-deliver, and a `hub wait` must name a specific job or peer.

### `orchestrate-roles`

Maps `agent:KIND` routing labels to the seven role agents and records which roles may delegate to which read-only or mechanical helpers.

## Skills

### `orchestrate`

Runs an orchestrated delivery DAG, choosing a one-tier or two-tier topology, dispatching pull-based workers, requiring independent review, and verifying the repository-wide result before closure.

### `orchestrate-preflight`

Runs deterministic Beads, Worktrunk, and orchestration checks before worker dispatch. Invoke it with the recorded base commit and sibling preflight paths; it returns structured checks and blocks dispatch on a failed check.

## Extension

### `wait-discipline`

Refuses a `hub wait` that names neither `ids` nor `from`. Such a call is an untargeted poll: subagent results auto-deliver and peer messages wake the lead, so the wait buys no dependency information while consuming another turn. Targeted waits remain allowed.
