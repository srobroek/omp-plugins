---
name: delivery-git-workflow
description: When branching, shipping, creating a PR, merging, or proving work landed — git workflow policy (GW-n).
---

# Git Workflow

LEGEND: Rules carry stable IDs (GW-n).

Branching:

- MUST GW-5: every change happens in a Worktrunk worktree of the project, orchestrated or
  not: `wt switch --create <branch> --base origin/main --no-cd --format json`, then edit,
  test, and commit inside the path it prints. The primary checkout is the human's: read it,
  never edit or commit in it. The `primary-checkout-gate` extension refuses `edit`/`write`
  and `git commit` whose target is a primary checkout (git dir equals git common dir); it
  fails open when git cannot answer, leaves `.omp/` and `.beads/` state alone, and
  `DELIVERY_ALLOW_PRIMARY_CHECKOUT=1` in the environment lifts it when the user asked for
  the primary checkout. It does not parse shell writes (`sed -i`, redirections, scripts);
  those are yours to keep out of the primary checkout.
- MUST GW-6: remove the worktree when its branch has landed: `wt remove <branch>` after the
  PR merges (`wt merge` removes it itself). The Worktrunk `post-start` hook runs
  `wt step prune --min-age 1d` on every new worktree, which removes any merged worktree
  older than a day; do not rely on it as the first line.
- Reuse an existing branch/worktree only when it was created for this task.
- Work lands on a branch, not on main/master. A commit whose repository has
  main or master checked out is refused by the `main-branch-gate` extension,
  which reads `git branch --show-current` in that repository; it fails open when
  git cannot name a branch, and `DELIVERY_ALLOW_MAIN_COMMIT=1` lifts it for the
  sanctioned direct-to-main case below.

Shipping (choose one, confirm if ambiguous):

- PR (`gh pr create`) -- default for anything reviewed or outward-facing.
  Agent-authored PRs start as drafts (`gh pr create --draft`). Promote with
  `gh pr ready` only after implementation, local validation, and required
  agent review are complete and no known blocker remains.
  Body: what changed, why, test plan. One close keyword per issue line.
  MUST GW-7: under squash merge the PR TITLE becomes the commit subject, so it
  carries a conventional type and, in a monorepo, the package scope
  (`fix(beads): catalog refresh fails when offline`). Release automation reads
  subjects: a prose title strands the change on the default branch, released by
  nothing, because the branch's own `feat`/`fix` subjects survive only as body
  bullets that release tooling does not attribute. Write it for end users, never
  spec ids, task refs, or phase names. Spec context goes in the body.
- Local merge to main -- only when the user asks or the repo has no PR flow.
  Use `git merge --no-ff` for feature branches; pass an explicit strategy
  flag to `gh pr merge` (`--squash`/`--merge`/`--rebase`).

Automated review loop:

MUST GW-4: the agent that creates a PR owns its automated-review loop until
landing or explicit human escalation. It may delegate observation to a landing
shepherd, but never to a polling watcher that holds a live session.

1. Keep the PR draft until required local review, CI, and configured automated
   reviewers have completed against the exact head. Cover CodeRabbit, Codex,
   Copilot review, Greptile, and repository-configured reviewers when present.
2. Park pending review waits and continue unrelated work. A later pass reads the
   review state; no agent polls while holding the session open.
3. Collect the complete actionable set for the head and assign one fix owner.
   After the fix, push the new head and rerun every configured reviewer.
4. Identify findings by GitHub review-thread node id. Without a thread, use the
   review URL plus a stable bot/path/location/finding fingerprint. Count attempts
   per material issue, not per PR or head. A new issue starts at one.
5. For each addressed thread, reply when evidence is needed, call GitHub's
   `resolveReviewThread` GraphQL mutation, and read back `isResolved=true`.
   A reply or outdated diff does not resolve a conversation.
6. After three unsuccessful fixes of the same material issue, hold only that PR
   for human review. Record the issue identities, attempts, heads, fixes and
   unresolved URLs, then notify the main agent loop. New issues may continue
   through their own three attempts and never inherit an older issue's count.

Unrelated implementations and PRs continue while one PR waits or is escalated.

Beads linkage:

Where beads is active (`.beads/` exists), a PR and its beads point at each
other. Either pointer alone rots: a PR body names beads a reader can open, and
the bead's `pr` metadata is what a later session, a shepherd, or a review finds
without scanning GitHub history.

- MUST name every bead the PR implements in the body, as `Bead: <id>` lines or
  `Closes-Bead: <id>`. A PR may name several beads.
- MUST stamp `pr` metadata on every bead the PR implements, not merely a merge
  bead: `bd update <id> --set-metadata pr=<n>`. A bead may carry several PR
  numbers, comma-separated.
- MUST load the other side before acting. Before reviewing, merging, pushing to,
  commenting on, or reporting a PR as done, read its beads and name the holder.
  Before acting on a bead that carries `pr`, read that PR. A passing glance at a
  diff needs neither.
- MUST pass that bead context into a review agent's prompt. `pr-reviewer` has no
  shell by design, since it reads untrusted PR and bead text; whoever spawns it
  owes it the accepted scope, the holder, and the relevant comments.
- Exempt from naming a bead: PRs authored by a bot or app (release automation,
  dependency bumps), repositories with no `.beads/`, and repositories whose own
  rules replace the PR flow ([chezmoi delivery]rule://chezmoi-direct-main-delivery
  sends work straight to main). To ship a human-authored PR without a bead, put
  `No-Bead: <reason>` in the body; the reason is for a reviewer, so name what
  makes a bead wrong here.

For PRs entering the PR-shepherd merge queue, the merge bead carries the queue
state on top of that linkage:

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

MUST GW-1: before ending a session, commit the changes you made, in atomic
units -- one commit per self-contained chunk, each with its own message.
NOT GW-1 is not "commit the working tree". Never stage or commit files you did
not change; see `rule://delivery-cadence`.
MUST GW-2: push work you committed before ending -- commits on an unpushed
branch may be lost. Commits you did not author are reported, not pushed.
