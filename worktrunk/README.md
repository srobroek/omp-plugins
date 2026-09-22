# Worktrunk

Worktrunk protects the embedded Beads store and the canonical checkout while agents work in linked worktrees.

## Registered extensions

### `worktree-gate`

The tool-call gate blocks filesystem mutations whose resolved targets are outside a linked, non-canonical worktree of the owning repository. It also checks shell-shaped commands and redirects so their actual filesystem targets are contained. Read-only tools and calls with no filesystem target remain allowed.

The gate fails closed: an unresolvable path, failed repository probe, malformed payload, or missing session directory is refused rather than treated as safe. It is an accident guardrail, not a sandbox; a cooperative process can still write an absolute canonical path through an allowed command or evaluator.

### `isolation-precheck`

The precheck blocks `task` calls that request `isolated: true`, because native isolation clones `.beads` and forks the embedded ledger away from sibling agents. When `task.isolation.enabled` is already true, it emits a session-start advisory with the linked-worktree remedy.

The task-call refusal is fail closed. The session-start message is advisory and therefore fail open; unreadable settings do not block the session, while an actual isolation request is still refused.

## Rules

### `worktrunk-worktree-required`

Before editing, claim the bead and create a linked worktree with the required `wt switch` recipe. Address files through the returned absolute worktree path or `-C <worktree>`. From the canonical checkout, only the narrow bootstrap allowlist in this rule is permitted.

### `worktrunk-bd-contention-retry`

The embedded store is single-writer. When a listed contention message appears, wait briefly and retry the same `bd` command up to three attempts; do not escalate, call the run blocked, or work around the contention. Warnings that a command continued ungated mean the command already ran and are not contention.

## Removed controls

Provisioning enforcement, stale-worktree cleanup, the canonical-staleness advisory, and destructive-deletion provenance were removed because they protect neither the embedded store nor the canonical checkout.
