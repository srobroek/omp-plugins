---
name: worktrunk-isolation-disabled
alwaysApply: true
---

MUST keep `task.isolation.enabled: false`. Native isolation clones the checkout
with a filesystem clone, so the clone carries its own `.beads`, and a copied
embedded store is a second ledger: claims, comments and closures written in it are
invisible to every sibling and are discarded with the clone. There is no
git-worktree backend for native isolation, so it cannot be reconfigured into the
worktree model, only turned off.

Verify with `omp config get task.isolation.enabled --json`. The setting turns off
only the filesystem clone. It does not restrict delegation: dispatch independent
work to parallel subagents as usual, and give each agent its own git linked
worktree, per `worktrunk-worktree-required`.

This is the standing instruction, and it is the only thing that sets the setting
correctly in advance. The `isolation-precheck` extension refuses a `task` call
requesting `isolated: true`, unconditionally and with no setting to switch it off,
but it can only fire once an isolated child has already been attempted.
