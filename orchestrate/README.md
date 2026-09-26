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
| `shepherd` | Lands one integrated epic branch into the default branch after exact-head bot review and green `gh pr checks`; runs delivery tools, native close-out, and cleanup. It never merges workers into an epic. |
| `operator` | Runs one exact, bounded mechanical command with explicit targets; stops on ambiguity and never acts destructively. |

Claim-pool beads route to `operator` as documented by the roles rule. Pools are configured with `pool:implementer`, `pool:implementer-high`, `pool:work-reviewer`, `pool:researcher`, `pool:shepherd`, and `pool:operator`.
## Pool coordination

Pull-based roles keep their process alive when a filtered ready queue is empty by calling the registered `pool_wait` tool with the exact pool and lead-owned epic id. It polls `bd ready --assignee POOL --json` in-process, filters exact `metadata.epic_id`, and returns a ready record, a bounded timeout, or a structured Beads error without consuming a model turn. Pull-based worker, review, researcher, and operator roles yield run-level summaries with verdict: DRAINED|BLOCKED; the epic orchestrator yields DELIVERED|BLOCKED, and the landing shepherd yields COMPLETE|BLOCKED, using their role-specific schemas.

The epic orchestrator integrates approved worker heads into its own epic and closes each work bead with its merge SHA. The shepherd is spawned once per epic only after integration and verification when an epic-to-default PR exists or is required; tier1 single-epic runs use it to land the epic, while two-tier runs use only the root lead's shepherd for the default landing. No PR means no shepherd unless landing is explicitly required; in that case the shepherd opens the PR.

## Rules

### `orchestrate-process`

Defines pull-based ownership, preflight, durable Beads evidence, worktree isolation, review repair, and integration ownership. Leads yield after dispatching workers; OMP parks them and wakes them for worker results or messages. Root-only `wait` is reserved for a depth-0 session that is completely blocked. Never poll to discover completion. Historical rationale: 55 of 89 lead waits returned nothing usable.

### `orchestrate-roles`

Maps claim-pool aliases to the role agents and records which roles may delegate to which read-only or mechanical helpers.

## Skills

### `orchestrate`

Runs an orchestrated delivery DAG, choosing a one-tier or two-tier topology, dispatching claim-pool workers, requiring independent review, and verifying the repository-wide result before closure.

### `orchestrate-preflight`

Runs deterministic Beads, Worktrunk, and orchestration checks before worker dispatch, automatically running the Beads and Worktrunk preflights. It returns structured checks and blocks dispatch on a failed check.

## Coordination

Live peer messages use `write agent://AGENT_ID`; process status uses `read proc://` or `read proc://ID`, and process cancellation uses `write proc://ID/kill`. Every worker brief passes its lead runtime id; workers report only with `write agent://<leadId>` and never broadcast with `write agent://all`.
