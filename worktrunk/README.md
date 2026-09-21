# Worktrunk

Worktrunk manages linked worktrees.

## Rules

Use worktrees for mutations.
Native isolation is off.
Retry contention.

## Gate

The gate checks mutations.
The gate rejects the canonical root.
Read-only tools are exempt.

The delivery tools `delivery_orient` and `delivery_hygiene_report` are read-only and may run from the canonical checkout. `bd_reconcile` is a ledger tool: scans, plans, and applies are all allowed from the canonical checkout, subject to its own input validation. `delivery_land` and `delivery_cleanup` are intentionally not enumerated as read-only, so they require a linked non-canonical worktree. Malformed or unknown payloads are not granted a read-only exemption and are handled by the normal conservative path checks.
Unknown paths block.

## Precheck

### `worktree-gate`

The gate judges only the filesystem paths a call's arguments resolve to. A path must be physically inside a linked, non-canonical worktree of the repository that owns it; a path outside that worktree is refused. Path ownership is resolved from the deepest existing directory above the target, not from the session's repository or cwd.

Calls that resolve to no filesystem path are allowed. There are no device allowlists, ledger-family exemptions, or pathless-cwd refusals. Read-only tools remain exempt, and tools with filesystem targets are checked according to those resolved targets.

The gate is an accident guardrail, not a sandbox. A cooperative process can still write an absolute path through an allowed command or a shell redirection, so canonical checkouts remain protected by the worktree policy rather than by a claim of complete containment.
