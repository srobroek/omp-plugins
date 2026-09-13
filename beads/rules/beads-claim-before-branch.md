---
name: beads-claim-before-branch
description: Creating a branch or worktree for a bead you have not claimed is how two sessions duplicate the same work.
condition: ["(?m)(?:^|[;|&]\\s*)(?:wt\\s+switch\\s+(?:[^\\n]*\\s)?--create\\b|git(?:\\s+-C\\s+\\S+)?\\s+(?:checkout\\s+-b\\b|switch\\s+-c\\b|worktree\\s+add\\b))(?![^\\n]*--help)"]
scope: "tool:bash"
interruptMode: always
---

MUST Claim before creating a branch or worktree: `bd update <id> --claim` is an
atomic, first-wins operation. On refusal, treat the bead as taken; do not release
another actor's claim to proceed.

DEFAULT Discover with `bd ready --unassigned --json`, not `bd list --status open`
alone, then inspect `git worktree list` and `git branch --list` before creating
anything.

Not every branch belongs to a bead: spikes, reverts, and dependency bumps may
say so explicitly. The command-position anchor keeps quoted prose and searches
silent.
