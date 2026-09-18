# Worktrunk

Worktrunk manages linked worktrees.

## Rules

Mutations need a worktree.
The project disables native isolation.
Contention needs retry.

## Gate

The gate checks mutations.
The gate rejects the canonical root.
Read-only tools are exempt.
Unknown paths block.

## Precheck

The precheck reports native isolation.
The precheck rejects task calls that request isolation.
