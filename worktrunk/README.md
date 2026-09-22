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
Unknown paths block.

## Precheck

### `worktree-gate`

The gate judges only the filesystem paths a call's arguments resolve to. A path must be physically inside a linked, non-canonical worktree of the repository that owns it; a path outside that worktree is refused. Path ownership is resolved from the deepest existing directory above the target, not from the session's repository or cwd.

Calls that resolve to no filesystem path are allowed. There are no device allowlists, ledger-family exemptions, or pathless-cwd refusals. Read-only tools remain exempt, and tools with filesystem targets are checked according to those resolved targets.

The gate is an accident guardrail, not a sandbox. A cooperative process can still write an absolute path through an allowed command or a shell redirection, so canonical checkouts remain protected by the worktree policy rather than by a claim of complete containment.

## Stale-worktree sweep

### `stale-worktree-sweep`

At session start, the sweep collects linked worktrees whose branch is `omp/agent/<bead-id>` and whose bead the ledger reports `closed`. It needs no orchestration plugin: a checkout accumulates these leftovers whenever a session dies between closing a bead and reclaiming its tree.

A closed bead is not an unused tree. Review happens after delivery and reads the delivered worktree to cite `path:line`, so a closed bead's tree is left alone for 24 hours after `closed_at`. An absent or unparseable `closed_at` counts as inside that window and keeps the tree: removing a wanted tree is real loss, keeping one too long costs a line of notice.

`git worktree lock <path>` keeps a tree for longer than the window. Removal runs `wt remove -y --foreground <branch>` with neither `-f` nor `-D`, so a locked tree survives it — `wt` answers `✗ Cannot remove <branch>, worktree is locked` — and is reported instead of removed, along with the `git worktree unlock` that releases it. An unmerged branch and a dirty tree survive the same way, because no force flag is passed.

The sweep stands down rather than racing anyone: it never runs a real `wt step prune`, and when the dry run names any worktree at all it does nothing. It re-reads the bead and the worktree listing immediately before a removal, because a verdict can reopen a bead, a successor can adopt the same branch name, and `wt remove` addresses a worktree by branch. The tree the session itself is running in is never collected. The ledger read drops an inherited `BEADS_DIR`, so another project's store cannot report a bead closed that is open here.

It speaks only when something was removed or something was kept. No candidates, an unreadable worktree listing, or a cwd in no repository produce no session message at all.
