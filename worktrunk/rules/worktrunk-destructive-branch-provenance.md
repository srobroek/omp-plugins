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

Use the pull request's merge state or patch equivalence as the supersession test. `git merge-base --is-ancestor <branch> origin/main` is not a sufficient test: squash merging creates a new commit and leaves no ancestry, so it returns FALSE for a branch that is fully merged. In this repository, `omp/agent/omp-plugins-idxq`, `omp-plugins-bqe2`, `omp-plugins-j66g`, and `omp-plugins-q4bb.6.9` all fail that ancestor test while their merged PRs have merge SHAs `298a9679`, `973a6896`, `da9384b9`, and `bce23b1f`. Use the PR's merge state, or compare patches with `git cherry` or `git patch-id`; record the command and result as evidence. An agent that does not know this will either refuse safe deletions or trust an inverted signal.

Record the branch-tip SHA and the PR merge SHA separately. The branch tip is the pre-delete commit; the merge SHA is the commit produced by merging the PR. Neither substitutes for the other.

This estate's decided test is two commands: `git cherry -v origin/main <branch>` and `git diff --stat origin/main...<branch>`. Only-minus output with an empty diff is superseded; any-plus output with a nonempty diff is PR-and-land. Record both outputs.

Fail closed: if the ref, exact head, supersession or merge evidence, authorization, or post-mutation absence proof cannot be gathered, do not delete the ref. If the post-mutation absence check fails, report the failure on the governing bead and stop.

Invoke each destructive removal for exactly one ref. The shipped `safety/extensions/worktree-detached-guard.ts` rejects multi-target `wt remove` and rejects a detached checkout whose tip no ref reaches; use that guard mechanism and preserve one provenance comment per target rather than bypassing it.
