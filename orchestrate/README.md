# Orchestrate

Orchestrate runs a delivery DAG through ledger-backed role workers, independent review, and exact-head integration.

## Agents

The package ships six role agents and one mechanical helper:

| Agent | Responsibility |
|---|---|
| `orchestrator` | Owns an epic, builds its bead DAG, dispatches workers, and verifies delivery. |
| `implementer` | Implements one scoped bead and records reproducible evidence. |
| `implementer-high` | Handles reasoning-heavy or troubleshooting work with root-cause evidence. |
| `work-reviewer` | Judges every acceptance criterion and queues actionable fixes. |
| `researcher` | Answers one scoped question with cited observations and inferences. |
| `shepherd` | Pulls one epic's merge-bead queue, verifies exact heads, and serializes integration. |
| `operator` | Runs one exact, bounded mechanical command with explicit targets; stops on ambiguity and never acts destructively. |

Mechanical `agent:operator` beads route to `operator` as documented by the roles rule.

## Rules

### `orchestrate-process`

Defines pull-based ownership, preflight, durable Beads evidence, worktree isolation, review repair, and integration ownership. Leads yield after dispatching workers; OMP parks them and wakes them for worker results or messages. Root-only `wait` is reserved for a depth-0 session that is completely blocked. Never poll to discover completion. Historical rationale: 55 of 89 lead waits returned nothing usable.

### `orchestrate-roles`

Maps `agent:KIND` routing labels to the role agents and `operator` and records which roles may delegate to which read-only or mechanical helpers.

## Skills

### `orchestrate`

Runs an orchestrated delivery DAG, choosing a one-tier or two-tier topology, dispatching pull-based workers, requiring independent review, and verifying the repository-wide result before closure.

### `orchestrate-preflight`

Runs deterministic Beads, Worktrunk, and orchestration checks before worker dispatch. Invoke it with the recorded base commit and sibling preflight paths; it returns structured checks and blocks dispatch on a failed check.

## Coordination

Live peer messages use `write agent://AGENT_ID`; process status uses `read proc://` or `read proc://ID`, and process cancellation uses `write proc://ID/kill`. Every worker brief passes its lead runtime id; workers report only with `write agent://<leadId>` and never broadcast with `write agent://all`.
