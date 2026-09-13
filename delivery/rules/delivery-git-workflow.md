---
name: delivery-git-workflow
description: When creating or reviewing PRs, owning automated review, proving landing, cleaning worktrees, or linking delivery to Beads.
---

# Git Workflow

LEGEND: Rules carry stable IDs (GW-n).

## Shipping

- A PR (`gh pr create`) is the default for reviewed or outward-facing work.
- Agent-authored PRs start as drafts (`gh pr create --draft`). Promote with `gh pr ready` only after implementation, local validation, required review, and CI are complete with no known blocker.
- The body states what changed, why, and the test plan. Use one close keyword per issue line.
- MUST GW-7: under squash merge the PR title becomes the commit subject, so it carries a conventional type and, in a monorepo, the package scope (`fix(beads): catalog refresh fails when offline`). Release automation reads subjects, not body bullets. Write the title for end users, never spec IDs, task references, or phase names.
- A local merge to main is for an explicit request or a repository with no PR flow. Use `git merge --no-ff` for feature branches and an explicit strategy with `gh pr merge`.

## Automated review loop

MUST GW-4: the agent that creates a PR owns its automated-review loop until landing or explicit human escalation. It may delegate observation to a landing shepherd, but never to a polling watcher holding a live session.

1. Keep the draft until local review, CI, and configured automated reviewers have completed against the exact head. Cover CodeRabbit, Codex, Copilot review, Greptile, and repository-configured reviewers when present.
2. Park pending waits and continue unrelated work. Later read the review state; no agent polls while holding the session open.
3. Collect the complete actionable set for the head, assign one fix owner, then push the new head and rerun every configured reviewer.
4. Identify findings by GitHub review-thread node id. Without a thread, use the review URL plus a stable bot/path/location/finding fingerprint. Count attempts per material issue; a new issue starts at one.
5. Reply when evidence is needed, call `resolveReviewThread`, and read back `isResolved=true`. A reply or outdated diff does not resolve a conversation.
6. After three unsuccessful fixes of one material issue, hold only that PR for human review and record issue identities, attempts, heads, fixes, and unresolved URLs. New issues have their own three attempts.

## Beads linkage

Where `.beads/` exists, a PR and its beads point at each other. Name every implementing bead in the PR body as `Bead: <id>` or `Closes-Bead: <id>`, and stamp `pr` metadata on every implementing bead. Before acting on a bead carrying `pr`, read that PR; before reviewing or landing a PR, read its beads and name the holder. Pass that context to review agents.

For PRs entering the PR-shepherd merge queue, create before PR creation one open, unassigned task bead labeled `pr:merge` and `agent:integrator`, with `branch`, `repo`, and `origin_actor` metadata. For every closing work bead, add its dependency on the merge bead before approval freezes the graph. Immediately after creation, stamp PR/base/head anchors on the merge bead. Keep implementation beads at `state:reported` or `state:approved` while unmerged; the integrator verifies landing before closing a `Closes-Bead` target. Draft PRs and automated release PRs are not ordinary merge-queue entries.

## Verifying work landed

MUST GW-3: prove the exact reviewed work reached its final destination. For PR-backed work, read `state`, `baseRefName`, `headRefOid`, and `mergeCommit` with `gh pr view`; `MERGED` proves that the recorded PR head landed in its base, but compare the branch tip with `headRefOid` because later commits remain unlanded. An intermediate merge needs proof that it reached the final destination. Without a PR, `git cherry` or stable patch IDs can prove an individual equivalent patch, not a multi-commit squash. Inspect the recorded merge commit or exact expected hunks. Do not use ancestry, merge-tree output, path existence, or non-empty history as sole proof.

MUST GW-6: remove the worktree when its branch has landed: `wt remove <branch>` after the PR merges (`wt merge` removes it itself). The installed post-start prune hook is cleanup, not the first line.
