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
- MUST GW-7: under squash merge the PR title becomes the commit subject, because `delivery_land` passes the title as the squash subject, so the title carries a conventional type and, in a monorepo, the package scope (`fix(beads): catalog refresh fails when offline`). Release automation reads subjects, not body bullets. Write the title for end users, never spec IDs, task references, or phase names.
- Working on `main` or `master` - checkout, commit, or push - is allowed where the session intends it. This plugin ships no gate for it.

## Automated review loop

MUST GW-4: the agent that creates a PR owns its automated-review loop until landing or explicit human escalation. It may delegate observation to a landing agent such as `shepherd`, but never to a polling watcher holding a live session. Workers dispatched by a lead MUST NOT request or act on review rounds for the lead's PR.

1. Keep the draft until local review, CI, and configured automated reviewers have completed against the exact head. Cover CodeRabbit, Codex, Copilot review, Greptile, and repository-configured reviewers when present.
2. Park pending waits and continue unrelated work. Later read the review state; no agent polls while holding the session open.
3. Collect the complete actionable set for the head, assign one fix owner, then push the new head and rerun every configured reviewer.
4. Identify findings by GitHub review-thread node id. Without a thread, use the review URL plus a stable bot/path/location/finding fingerprint. Count attempts per material issue; a new issue starts at one.
5. Reply when evidence is needed, call `resolveReviewThread`, and read back `isResolved=true`. A reply or outdated diff does not resolve a conversation.
6. After three unsuccessful fixes of one material issue, hold only that PR for human review and record issue identities, attempts, heads, fixes, and unresolved URLs. New issues have their own three attempts.

## Beads linkage

- Agent-created PRs in a live `.beads/` workspace link to an existing governing bead in the PR body as `Bead: <id>`, `Closes-Bead: <id>`, or `Bead-Id: <id>`, and stamp `pr` metadata on every implementing bead. `No-Bead:` is not accepted; only a regular-file `.beads/RETIRED` sentinel owned by this gate makes the nearest ledger inactive. Before acting on a bead carrying `pr`, read that PR. Before reviewing or landing an already-created incoming human or bot PR, absence of these trailers alone is not a finding or blocker.

- For PRs entering the delivery merge queue, create before PR creation one open, unassigned task bead labeled `pr:merge` and `agent:shepherd`, with `branch`, `repo`, and `origin_actor` metadata. For every closing work bead, add its dependency on the applicable merge bead before approval freezes the graph. Immediately after creation, stamp PR/base/head anchors on the merge bead. Keep implementation beads at `state:reported` or `state:approved` while unmerged; the `shepherd` verifies landing before closing a `Closes-Bead` target. Draft PRs and automated release PRs are not ordinary merge-queue entries.

## Verifying work landed

MUST GW-3: prove the exact reviewed work reached its final destination. For PR-backed work, read `state`, `baseRefName`, `headRefOid`, and `mergeCommit` with `gh pr view`; `MERGED` proves that the recorded PR head landed in its base, but compare the branch tip with `headRefOid` because later commits remain unlanded. An intermediate merge needs proof that it reached the final destination. A rebase landing rewrites commit SHAs, so prove it by ordered patch-id equivalence: the `git patch-id --stable` sequence of the reviewed commits (base..reviewed head) equals, in order, that of the landed commits ending at `mergeCommit`. Without a PR, `git cherry` or stable patch IDs can prove an individual equivalent patch, not a multi-commit squash. Inspect the recorded merge commit or exact expected hunks; fetch before reading any remote-tracking ref, because without that preceding fetch the read proves nothing. Do not use ancestry, merge-tree output, path existence, or non-empty history as sole proof.

### Landing method selection

MUST GW-10: choose `delivery_land.merge_method` from the target project's documented landing policy before landing. Use `merge` when the policy requires a real merge commit or says never to squash; use `rebase` when it requires a linear/rebased landing; use `squash` only when the policy permits squash and requires neither other shape. An ambiguous or contradictory policy is a hold, not permission to guess. The caller MUST pass the selected method explicitly when the policy is not the default squash policy.

`delivery_land` defaults to `squash`, refuses an explicit `merge` when the forge reports `allow_merge_commit: false`, and refuses a post-merge commit shape that does not match the selected method. For an already-`MERGED` request, no merge method was issued in that call; one parent or two parents with the reviewed head second are accepted and the observed shape is recorded. Its receipt proof records `proof.evidence.mergeMethod`, `mergePolicy`, and `mergeShape`: squash has one parent; merge has two parents with the reviewed head second; rebase has one parent plus ordered `git patch-id --stable` equivalence between the reviewed commits and the landed commits ending at the merge commit, never reviewed-head ancestry, because rebase-and-merge rewrites SHAs. Cleanup and close-out MUST use the receipt's proven method and SHA, never assumptions about the provider's merge UI.
