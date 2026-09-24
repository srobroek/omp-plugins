# Orchestrate

Orchestrate runs a delivery DAG through ledger-backed role workers, independent review, and exact-head integration.

## Agents

The package ships seven role agents and one mechanical helper:

| Agent | Responsibility |
|---|---|
| `orchestrator` | Owns an epic, builds its bead DAG, dispatches workers, and verifies delivery. |
| `implementer` | Implements one scoped bead and records reproducible evidence. |
| `implementer-high` | Handles reasoning-heavy or troubleshooting work with root-cause evidence. |
| `work-reviewer` | Judges every acceptance criterion and queues actionable fixes. |
| `researcher` | Answers one scoped question with cited observations and inferences. |
| `shepherd` | Owns review rounds and the serialized PR merge queue. |
| `merger` | Integrates one independently reviewed branch at one exact verified head. |
| `operator` | Runs one exact, bounded mechanical command with explicit targets; stops on ambiguity and never acts destructively. |

Mechanical `agent:operator` beads route to `operator` as documented by the roles rule.

## Rules

### `orchestrate-process`

Defines pull-based ownership, preflight, durable Beads evidence, worktree isolation, review repair, and integration ownership. Results and peer messages auto-deliver; call `wait` only when completely blocked with no useful work left. Historical rationale: 55 of 89 lead waits returned nothing usable.

### `orchestrate-roles`

Maps `agent:KIND` routing labels to the role agents and `operator` and records which roles may delegate to which read-only or mechanical helpers.

## Skills

### `orchestrate`

Runs an orchestrated delivery DAG, choosing a one-tier or two-tier topology, dispatching pull-based workers, requiring independent review, and verifying the repository-wide result before closure.

### `orchestrate-preflight`

Runs deterministic Beads, Worktrunk, and orchestration checks before worker dispatch. Invoke it with the recorded base commit and sibling preflight paths; it returns structured checks and blocks dispatch on a failed check.

## Coordination

Live peer messages use `write agent://AGENT_ID` or `write agent://all`; process status uses `read proc://` or `read proc://ID`, and process cancellation uses `write proc://ID/kill`.
