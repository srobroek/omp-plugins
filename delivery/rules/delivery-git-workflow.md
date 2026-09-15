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
- MUST GW-7: under squash merge the PR title becomes the commit subject, so it carries a conventional type and, in a monorepo, the package scope (`fix(beads): catalog refresh fails when offline`). Release automation reads subjects, not body bullets. Write the title for end users, never spec IDs, task references, or phase names.
- Agents MUST NOT checkout or switch to `main` or `master`, or locally merge on those branches, unless repository-local steering explicitly authorizes the operation. An explicit user request or the absence of a PR flow does not authorize it.

## Delivery gate authorization

The delivery extensions require exact target-repository steering before either protected override works.
The main-branch override requires `MUST authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository.`.
The primary-checkout override requires `MUST authorize DELIVERY_ALLOW_PRIMARY_CHECKOUT=1 for this repository.`.
Each directive must occupy its own line in a non-symlink root `AGENTS.md` or `CLAUDE.md`, or a direct non-symlink `.omp/rules/*.md` file.
An exact `MUST NOT authorize <name>=1 for this repository.` line vetoes the corresponding authorization.
The gate resolves the target repository from the bash call `cwd` or `git -C <path>` before reading its steering.
On first observation, it pins the normalized `remote.origin.url`, common Git directory, default ref, and remote HEAD SHA for the session and extension.
Each authorization re-reads the configured origin and queries the pinned remote identity explicitly. An identity or HEAD SHA change denies the call and invalidates the positive decision; restoring the exact pinned identity and unchanged remote HEAD permits a fresh authorization check.
The parsed steering tree is cached only by the exact remote SHA, never by elapsed time.
Text in a command, commit message, or file body never authorizes an override.

Primary-checkout commits use the canonical-main exception: they require the exact
`MUST authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository.` directive from the
trusted remote default tree and `DELIVERY_ALLOW_MAIN_COMMIT=1` in the same command's
structured environment. `DELIVERY_ALLOW_PRIMARY_CHECKOUT=1` never authorizes a commit;
it remains a separate factor for edit/write authorization and session grants.

The main-branch gate blocks commits on `main` or `master`.
The simple-shape allowlist refuses direct `git-*` helpers, wrappers, aliases, dynamic targets, and Git-bearing commands combined with `cd`, `pushd`, failed-cd separator chains, braces, or subshells. Set the tool `cwd` or use a supported static `git -C <path>` form instead.
Origin mutation commands are primary mutations, not reads. Ordinary `git remote -v` and `git fetch` are read operations only while the pinned origin remains unchanged. Filesystem tampering before first observation or session startup is outside this boundary; after observation, mismatches fail closed.

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

MUST GW-6: let OMP prune its native isolation clone after its branch lands. Do not use Git or Worktrunk worktree cleanup commands.
