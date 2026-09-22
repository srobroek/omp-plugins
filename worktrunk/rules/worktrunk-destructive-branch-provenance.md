---
name: worktrunk-destructive-branch-provenance
description: Before deleting a branch or worktree ref, preserve supersession evidence and authorization on the governing bead.
---

Before any destructive branch or worktree-ref mutation, add a comment to the governing bead. A session log is not a durable carrier. Record all of the following in that comment:

- the human-readable branch name;
- the full ref (for example, `refs/heads/omp/agent/example`);
- the exact pre-delete branch-tip SHA;
- the evidence that the work is superseded or merged;
- the actor and the user authorization for deletion; and
- the exact post-mutation absence check that will be run, including its expected result.

After the mutation, append the observed absence proof to the same bead comment. Run `git ls-remote --exit-code --heads origin <branch>` (or an equivalent exact remote-ref query) and record the command, exit status, and output showing that the full ref is absent. Do not treat a session transcript as this record.

Use the pull request's merge state or patch equivalence as the supersession test. `git merge-base --is-ancestor <branch> origin/main` is not a sufficient test: squash merging creates a new commit and leaves no ancestry, so it returns FALSE for a branch that is fully merged. In this repository, `omp/agent/omp-plugins-idxq`, `omp/agent/omp-plugins-bqe2`, `omp/agent/omp-plugins-j66g`, and `omp/agent/omp-plugins-q4bb.6.9` all fail that ancestor test while their merged PRs have merge SHAs `298a9679`, `973a6896`, `da9384b9`, and `bce23b1f`. Use the PR's merge state, or compare patches with `git cherry` or `git patch-id`; record the command and result as evidence. An agent that does not know this will either refuse safe deletions or trust an inverted signal.

Record the branch-tip SHA and the PR merge SHA separately. The branch tip is the pre-delete commit; the merge SHA is the commit produced by merging the PR. Neither substitutes for the other.

The decisive supersession test is patch equivalence together with the pull request's merge state. Run `git cherry -v origin/main <branch>` (or compare patches with `git patch-id`). Record the command and result as evidence. When cherry output is only-minus, treat the branch as superseded regardless of the diff output. Confirm that the PR merge state permits deletion.

The three-dot `git diff --stat origin/main...<branch>` is non-decisive context. It measures from the MERGE BASE. Squash merging creates a new commit and leaves the merge base behind. The diff therefore stays nonempty forever for a squash-merged branch. It MUST NOT gate a deletion. Record its output as context when useful, and never require it to be empty before deleting a ref.

The `only-minus-plus-nonempty-diff` state marks the branch superseded. These measured examples show the state:

| branch | tip SHA | PR merge SHA | `git cherry -v origin/main <branch>` | `git diff --stat origin/main...<branch>` |
| --- | --- | --- | --- | --- |
| `omp/agent/omp-orchestrate-9c1j` | `3be8d082d187930cb31c5f355b26803a6759c4bb` | PR #260: `53046fb` | only-minus (1 commit, `-`) | `4 files changed, 217 insertions(+), 8 deletions(-)` |
| `omp/agent/omp-orchestrate-o0ge` | `1128dc81924e58c823f2825be6db398af69347f3` | PR #262: `84e4430` | only-minus (1 commit, `-`) | `4 files changed, 44 insertions(+), 4 deletions(-)` |

The merged PRs prove both branches superseded. Their three-dot diffs remain nonempty.

Fail closed: if the ref, exact head, supersession or merge evidence, authorization, or post-mutation absence proof cannot be gathered, do not delete the ref. If the post-mutation absence check fails, report the failure on the governing bead and stop.

Invoke each destructive removal for exactly one ref. The shipped `safety/extensions/worktree-detached-guard.ts` rejects multi-target `wt remove` and rejects a detached checkout whose tip no ref reaches; use that guard mechanism and preserve one provenance comment per target rather than bypassing it.
