---
name: beads-ledger
description: Apply the Beads ledger as the authoritative source for work state and status transitions.
---

MUST treat the ledger as the single source of truth for work state.
MUST create a bead for every unit of work before someone does it.
MUST make status transitions through `bd`, not prose.

# BATCHED CREATION AND MUTATION
MUST Create more than one bead in one `bd create --graph <plan.json>` call;
NEVER loop plain `bd create`. One measured arm issued 37 separate `bd create`
calls and 27 separate `bd dep add`/`dep remove` calls among 122 `bd`
invocations. `bd batch`'s help states that this loop causes severe write
amplification: each invocation is its own transaction and its own Dolt commit.

`bd create --graph` is the batched creation path because it carries the fields
required by this steering. Its verified plan schema is:
- Top level `nodes`, optionally `edges`; a top-level `issues` key is silently
  dropped with a warning.
- Each node MUST use `key` (not `id`) as its plan-local identifier; omitting
  `key` is rejected. Accepted node fields are `key`, `type`, `priority`,
  `title`, `description`, `acceptance_criteria`, `parent_key`, `labels`, and
  `metadata`. `acceptance` is silently dropped; the field is
  `acceptance_criteria`. Unknown fields anywhere are silently dropped with a
  warning.
- Dependencies MUST be in top-level `edges`, as
  `{"from_key":"...","to_key":"...","type":"blocks"}`; use
  `from_id`/`to_id` to reference an already-existing bead. A per-node `deps`
  array of `{"target":...,"type":...}` reports success but creates zero
  edges. NEVER use that trap.

MUST run `bd create --graph ... --dry-run` first and verify its intended edge
count (for example, `would create 3 issue(s) and 1 edge(s) (2 parent-child
link(s))`). Dry-run validates structure only; a live create can still reject
parent-child blocking paths after resolving stored dependencies.

Use `bd batch` only for bulk mutation of existing beads, not for creating our
beads. Its only grammar is `close ID [reason]`, `update ID KEY=VALUE`,
`create TYPE PRIORITY TITLE`, `dep add`, and `dep remove`.
Its `create` form takes no parent, dependencies, description, acceptance
criteria, metadata, labels, or explicit id. `update` accepts only `status`,
`priority`, `title`, `assignee`, and `force`. The whole batch is one transaction:
any refusal rolls back every operation. An `update` that moves an issue to
closed enforces open-children and live-blocker policy; a bare `close` does not
apply that policy at all.

Reads (`show`, `list`, `ready`, `sync`) are not accepted. Therefore use
`bd create --graph` for a set of beads, `bd batch` to close or update a set or
add many dependencies to existing beads, and plain `bd create` for one bead.
