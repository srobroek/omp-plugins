---
name: delivery-git-workflow
description: When creating or reviewing PRs, owning automated review, proving landing, cleaning native isolation clones, or linking delivery to Beads.
---

# Git Workflow

LEGEND: Rules carry stable IDs (GW-n).

## Shipping

- A PR (`gh pr create`) is the default for reviewed or outward-facing work.
- Agent-authored PRs start as drafts (`gh pr create --draft`). Promote with `gh pr ready` only after implementation, local validation, required review, and CI are complete with no known blocker.
- The body states what changed, why, and the test plan. Use one close keyword per issue line.
- MUST GW-8: When the target repository is external, upstream, or not controlled by the user, omit internal linkage fields and sections from every externally visible PR or issue title, body, comment, review, and template field. Never mention Beads, bead IDs, internal IDs, agents, gates, orchestration, workflow rationale, or placeholders for omitted context. Controlled repositories retain the Beads linkage below.
- MUST GW-7: under squash merge the PR title becomes the commit subject, so it carries a conventional type and, in a monorepo, the package scope (`fix(beads): catalog refresh fails when offline`). Release automation reads subjects, not body bullets. Write the title for end users, never spec IDs, task references, or phase names.
- Working on `main` or `master` - checkout, commit, or push - is allowed where the session intends it. This plugin ships no gate for it.

## Protected-branch push advisory

`rule://delivery-main-branch-push-advisory` warns when a `git push` spells out `main` or `master` as its destination. It never blocks the command, and it reads the command text only: it cannot tell whether that destination is protected on the server, and a bare `git push` carries no destination to read. When it fires, confirm the target is the one you meant.

## Automated review loop

MUST GW-4: the agent that creates a PR owns its automated-review loop until landing or explicit human escalation. It may delegate observation to a landing shepherd, but never to a polling watcher holding a live session.

1. Keep the draft until local review, CI, and configured automated reviewers have completed against the exact head. Cover CodeRabbit, Codex, Copilot review, Greptile, and repository-configured reviewers when present.
2. Park pending waits and continue unrelated work. Later read the review state; no agent polls while holding the session open.
3. Collect the complete actionable set for the head, assign one fix owner, then push the new head and rerun every configured reviewer.
4. Identify findings by GitHub review-thread node id. Without a thread, use the review URL plus a stable bot/path/location/finding fingerprint. Count attempts per material issue; a new issue starts at one.
5. Reply when evidence is needed, call `resolveReviewThread`, and read back `isResolved=true`. A reply or outdated diff does not resolve a conversation.
6. After three unsuccessful fixes of one material issue, hold only that PR for human review and record issue identities, attempts, heads, fixes, and unresolved URLs. New issues have their own three attempts.

## Beads linkage

- Agent-created PRs in a `.beads/` workspace link to an existing governing bead in the PR body as `Bead: <id>` or `Closes-Bead: <id>`, and stamp `pr` metadata on every implementing bead. If no governing bead exists, the agent states a truthful `No-Bead: <reason>`. Before acting on a bead carrying `pr`, read that PR. Before reviewing or landing an already-created incoming human or bot PR, absence of these trailers alone is not a finding or blocker; when Bead context is supplied, read it and validate it. Automated Release Please PRs are explicitly acceptable without linkage. This is an agent-side workflow convention, not a repository or GitHub requirement. Pass supplied Bead context to review agents.

For PRs entering the PR-shepherd merge queue, create before PR creation one open, unassigned task bead labeled `pr:merge` and `agent:integrator`, with `branch`, `repo`, and `origin_actor` metadata. For every closing work bead, add its dependency on the merge bead before approval freezes the graph. Immediately after creation, stamp PR/base/head anchors on the merge bead. Keep implementation beads at `state:reported` or `state:approved` while unmerged; the integrator verifies landing before closing a `Closes-Bead` target. Draft PRs and automated release PRs are not ordinary merge-queue entries.

## Verifying work landed

MUST GW-3: prove the exact reviewed work reached its final destination. For PR-backed work, read `state`, `baseRefName`, `headRefOid`, and `mergeCommit` with `gh pr view`; `MERGED` proves that the recorded PR head landed in its base, but compare the branch tip with `headRefOid` because later commits remain unlanded. An intermediate merge needs proof that it reached the final destination. Without a PR, `git cherry` or stable patch IDs can prove an individual equivalent patch, not a multi-commit squash. Inspect the recorded merge commit or exact expected hunks. Do not use ancestry, merge-tree output, path existence, or non-empty history as sole proof.

MUST GW-6: let OMP prune its native isolation clone after its branch lands. Do not use Git or Worktrunk worktree cleanup commands.
