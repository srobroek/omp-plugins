---
name: delivery-git-workflow
description: When branching, shipping, creating a PR, merging, or proving work landed — git workflow policy (GW-n).
globs: ["**/*"]
---

# Git Workflow

LEGEND: Rules carry stable IDs (GW-n).

Branching:

- Never start new work on main/master; create or reuse a feature branch.
- Reuse an existing branch/worktree only when it was created for this task.

Shipping (choose one, confirm if ambiguous):

- PR (`gh pr create`) -- default for anything reviewed or outward-facing.
  Agent-authored PRs start as drafts (`gh pr create --draft`). Promote with
  `gh pr ready` only after implementation, local validation, and required
  agent review are complete and no known blocker remains.
  Body: what changed, why, test plan. One close keyword per issue line.
- Local merge to main -- only when the user asks or the repo has no PR flow.
  Use `git merge --no-ff` for feature branches; pass an explicit strategy
  flag to `gh pr merge` (`--squash`/`--merge`/`--rebase`).

Beads linkage (PRs entering the PR-shepherd merge queue):

The merge bead carries the linkage. The PR body carries none of it: the shepherd
discovers work by label and proves it against bead metadata, so a trailer in the
body would be read by nothing.

- Before PR creation, create one open, unassigned task bead labeled `pr:merge` and
  `agent:integrator`, with `branch`, `repo`, and `origin_actor` metadata. For
  every closing work bead, add `bd dep add <work-bead> <merge-bead>` before
  approval freezes the graph.
- Immediately after creation, stamp the PR number/base/head anchors onto the
  merge bead. The merge bead is durable discovery; GitHub history scans are
  not the queue.
- Keep implementation beads open at `state:reported` or `state:approved`
  while their PR is unmerged. The merge integrator verifies landing and
  completion before closing a `Closes-Bead` target.
- Draft PRs are work-in-progress and are not merge-queue entries. Automated
  release PRs are owned by the release system, not the ordinary merge queue.

Before push: run the project's test/verify command if code changed; report
failures instead of pushing over them.

Before merge: confirm the destination. After merge: ask about deleting the
merged branch.

Verifying work landed:

MUST GW-3: prove the exact reviewed work reached its final destination:

1. PR-backed work: read `state`, `baseRefName`, `headRefOid`, and `mergeCommit`
   with `gh pr view`. `MERGED` proves that recorded PR head landed in its base.
   Compare the branch tip with `headRefOid`; later commits remain unlanded.
   A merge into an intermediate branch requires proof that the intermediate
   change reached the final destination.
2. Work without a PR: `git cherry` or stable patch IDs may prove an individual
   commit has an equivalent patch. They do not prove equivalence for a
   multi-commit squash.
3. Acceptance: inspect the recorded merge commit or the exact expected
   hunks/content. Equality with the destination tip proves the required current
   state, but not historical provenance.

NOT Ancestry, merge-tree output, path existence, or non-empty path history as
sole landing proof. Path history only identifies commits to inspect.

Changesets (repos using them): add one for behavior/API/breaking changes;
skip for docs, tests, CI, and no-behavior refactors.

Session cadence:

MUST GW-1: commit all tracked changes before ending a session.
MUST GW-2: push all committed work before ending -- commits on an unpushed branch may be lost.
