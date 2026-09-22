---
name: delivery-git-workflow
description: When creating or reviewing PRs, owning automated review, proving landing, cleaning up a landed worktree and branch, or linking delivery to Beads.
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

For PRs not linked to an orchestrate run bead: MUST GW-4: the agent that creates a PR owns its automated-review loop until landing or explicit human escalation. It may delegate observation to a landing shepherd, but never to a polling watcher holding a live session.

1. Keep the draft until local review, CI, and configured automated reviewers have completed against the exact head. Cover CodeRabbit, Codex, Copilot review, Greptile, and repository-configured reviewers when present.
2. Park pending waits and continue unrelated work. Later read the review state; no agent polls while holding the session open.
3. Collect the complete actionable set for the head, assign one fix owner, then push the new head and rerun every configured reviewer.
4. Identify findings by GitHub review-thread node id. Without a thread, use the review URL plus a stable bot/path/location/finding fingerprint. Count attempts per material issue; a new issue starts at one.
5. Reply when evidence is needed, call `resolveReviewThread`, and read back `isResolved=true`. A reply or outdated diff does not resolve a conversation.
6. For PRs not linked to an orchestrate run bead: After three unsuccessful fixes of one material issue, hold only that PR for human review and record issue identities, attempts, heads, fixes, and unresolved URLs. New issues have their own three attempts.

PRs linked to an orchestrate run bead are owned by the run's shepherd (`orc-shepherd`); workers MUST NOT request or act on review rounds for them.

## Beads linkage

- Agent-created PRs in a live `.beads/` workspace link to an existing governing bead in the PR body as `Bead: <id>`, `Closes-Bead: <id>`, or `Bead-Id: <id>`, and stamp `pr` metadata on every implementing bead. `No-Bead:` is not accepted; only a regular-file `.beads/RETIRED` sentinel owned by this gate makes the nearest ledger inactive. Before acting on a bead carrying `pr`, read that PR. Before reviewing or landing an already-created incoming human or bot PR, absence of these trailers alone is not a finding or blocker.

For PRs entering the PR-shepherd merge queue, create before PR creation one open, unassigned task bead labeled `pr:merge` and `agent:integrator`, with `branch`, `repo`, and `origin_actor` metadata. For every closing work bead, add its dependency on the merge bead before approval freezes the graph. Immediately after creation, stamp PR/base/head anchors on the merge bead. Keep implementation beads at `state:reported` or `state:approved` while unmerged; the integrator verifies landing before closing a `Closes-Bead` target. Draft PRs and automated release PRs are not ordinary merge-queue entries.

## Verifying work landed

MUST GW-3: prove the exact reviewed work reached its final destination. For PR-backed work, read `state`, `baseRefName`, `headRefOid`, and `mergeCommit` with `gh pr view`; `MERGED` proves that the recorded PR head landed in its base, but compare the branch tip with `headRefOid` because later commits remain unlanded. An intermediate merge needs proof that it reached the final destination. Without a PR, `git cherry` or stable patch IDs can prove an individual equivalent patch, not a multi-commit squash. Inspect the recorded merge commit or exact expected hunks; fetch before reading any remote-tracking ref—without that preceding fetch, the read proves nothing. Do not use ancestry, merge-tree output, path existence, or non-empty history as sole proof.

MUST GW-6: after a branch lands, run `bd_reconcile` only when its receipt has `beads.ledgerActive: true`, then `delivery_cleanup`; inactive no-ledger or retired receipts go directly to `delivery_cleanup`. No agent removes a worktree or deletes a branch by hand with a Git or Worktrunk command. Every agent works in a linked Worktrunk worktree (`rule://worktrunk-isolation-disabled`). Ownership, preconditions, and stopping conditions for that cleanup are in `rule://delivery-worktree-hygiene`.
