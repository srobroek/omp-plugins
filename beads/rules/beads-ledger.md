---
name: beads-ledger
description: Apply the Beads preferences that bd prime does not state, covering batched creation, graph plans, and embedded-store write safety.
---

`bd prime` is the single source of truth for `bd` commands and the default
workflow. Run it once per session and follow it. This rule states only the
preferences it does not cover, and it OUTRANKS `bd prime` on the two points
below where they disagree.

# BATCHED CREATION
MUST create more than one bead in a single `bd create --graph plan.json` call.
NEVER loop plain `bd create`, and NEVER fan `bd create` out across parallel
subagents. `bd prime` recommends exactly that fan-out; it is wrong here for two
independent reasons. Each invocation is its own transaction and its own Dolt
commit, which `bd batch --help` describes as severe write amplification, and
parallel writers against an embedded store corrupt the Dolt journal. One
measured session issued 37 separate `bd create` calls and 27 separate
`bd dep add` and `bd dep remove` calls among 122 `bd` invocations.

# GRAPH PLAN SCHEMA
`bd create --graph` is the only batched path that carries the fields this
steering requires. Its verified plan shape:

- Top level is `nodes`, plus an optional `edges`. A top-level `issues` key is
  silently dropped with a warning.
- A node's plan-local identifier is `key`, never `id`; a node without `key` is
  rejected. Accepted node fields are `key`, `type`, `priority`, `title`,
  `description`, `acceptance_criteria`, `parent_key`, `labels`, `metadata`.
- The field is `acceptance_criteria`. Plain `acceptance` is silently dropped.
- Dependencies belong in the top-level `edges` array, each entry
  `{"from_key": "a", "to_key": "b", "type": "blocks"}`. Use `from_id` and
  `to_id` to reference a bead that already exists.
- Unknown fields anywhere are silently dropped with a warning, so a typo costs
  the field rather than raising.

MUST treat a per-node `deps` array as a trap. It reports success and creates
ZERO edges, so the plan looks correct and the DAG has no dependencies at all.

MUST dry-run first and check the reported edge count, for example
`would create 3 issue(s) and 1 edge(s) (2 parent-child link(s))`. That count is
the only signal that catches the dropped-dependency trap. A dry run validates
structure only: a live create can still reject parent-child blocking paths after
resolving stored dependencies.

# BULK MUTATION
Use `bd batch` for bulk mutation of beads that already exist, never to create
ours. Its grammar is only `close ID [reason]`, `update ID KEY=VALUE`,
`create TYPE PRIORITY TITLE`, `dep add`, and `dep remove`, and its `create` form
carries no parent, dependencies, description, acceptance criteria, metadata,
labels or explicit id. `update` accepts only `status`, `priority`, `title`,
`assignee`, `force`. The batch is one transaction, so any refusal rolls back
every operation in it. An `update` that moves an issue to closed enforces the
open-children and live-blocker policy; a bare `close` does not apply that policy
at all.

# EMBEDDED STORE
The store is embedded and lives in the canonical checkout, and linked worktrees
share it. `BEADS_DIR` does not redirect `bd init` away from canonical. No Dolt
server may be started. Two concurrent writers corrupt the Dolt journal, so a
contended `bd` call is retried rather than worked around.
