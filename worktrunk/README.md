# Worktrunk

Worktrunk manages linked worktrees.

## Rules

Use a worktree for mutations.
The project disables native isolation.
Retry contention.

## Gate

The gate checks mutations.
The gate rejects the canonical root.
Read-only tools are exempt.
Unknown paths block.

## Precheck

The precheck reports isolation.
The precheck rejects task calls that request isolation.
