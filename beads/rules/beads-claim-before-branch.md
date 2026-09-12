---
name: beads-claim-before-branch
description: Creating a branch or worktree for a bead you have not claimed is how two sessions duplicate the same work.
condition: ["(?m)(?:^|[;|&]\\s*)(?:wt\\s+switch\\s+(?:[^\\n]*\\s)?--create\\b|git(?:\\s+-C\\s+\\S+)?\\s+(?:checkout\\s+-b\\b|switch\\s+-c\\b|worktree\\s+add\\b))(?![^\\n]*--help)"]
scope: "tool:bash"
interruptMode: always
---
`beads-core` already says MUST Claim before working. Nothing fires when you skip it, so the skip stays silent until a second session has finished the same bead.

Measured, 2026-09-12, `chezmoi-6ko`: two sessions implemented one open unassigned bead in parallel. The loser spent a worktree, a signed commit, `task check:source` at 89.5s, a routed push with pre-push gate and whole-tree gitleaks at 77s, a draft PR, then teardown and a second 70s push to delete the ref. The conflict surfaced only after the push succeeded, as a `CONFLICTING` PR.

Neither session broke the letter of the workflow. `bd list --status open` showed the bead unassigned to both, because neither had claimed it.

MUST Claim before you create the branch: `bd update <id> --claim`. It is an atomic CAS, first wins, idempotent, so a race is decided by bd rather than by whoever pushes first.
MUST On refusal, treat the bead as taken. Do not release another actor's claim to proceed.
DEFAULT Discover with `bd ready --unassigned --json`, not by reading `--status open` alone.

Check the tree as well, because a claim is only as good as the claiming. `git worktree list` and `git branch --list` cost nothing and show work a claim would have announced. That check avoided the same collision twice within an hour: `fix/migration-attribution` was found carrying commits for `chezmoi-kgp`, and `fix/herdr-autostart-observability` for `chezmoi-ctg`, both left alone.

Name matching cannot substitute for either. Across 104 branch names from one repository's PR history, the colliding pair `chore/ignore-orchestration` and `chore/gitignore-orchestration` scored 0.33 on token similarity, ranking 25th of 335 overlapping pairs. Every threshold that catches it also flags roughly a hundred unrelated pairs, because `gitignore` and `ignore` are different tokens.

Not every branch belongs to a bead. Spikes, reverts and dependency bumps have nothing to claim, and this rule is satisfied by saying so.

The condition is anchored to command position -- start of line, or after `;`, `|`, `&` -- because the token stream includes quoted text. Unanchored, prose describing a branch creation fires it.
