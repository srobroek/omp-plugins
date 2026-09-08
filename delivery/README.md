# delivery

Git delivery workflows and commit guards for OMP.

The plugin covers:

- Commit and push cadence.
- Branching, shipping, and merge proof.
- Beads merge-queue linkage.
- A branch-first commit gate.
- Read-only pull-request review through `pr-reviewer`.

## Agents

| Name | When |
| --- | --- |
| `pr-reviewer` | Review a pull request; returns `VERDICT:` only. |

## Rules

| Name | When |
| --- | --- |
| `delivery-cadence` | Continuous atomic commit and push. |
| `delivery-git-workflow` | Branching, PRs, GW-3 landing proof, beads merge-queue linkage, GW-1/GW-2. |
| `delivery-draft-pr-advisory` | `gh pr create` without `--draft` (TTSR). |

## Extensions

### `main-branch-gate`

Blocks a `git`/`dgit` commit whose target repository has `main` or `master` checked out. It reads `git branch --show-current` in that repository, not the commit message.

The gate allows the call when git cannot name a branch. It also allows a standalone `--dry-run` commit option, not the same text used as an option value or a path after `--`.

For a user-authorized exception, set `DELIVERY_ALLOW_MAIN_COMMIT=1` in the process environment or as an assignment prefix on the actual commit invocation. Message or echo text does not enable the override. The override records the exception; it does not replace host approval.

Directory checks are preflight observations, not atomic guarantees. Dynamic shell state remains outside this advisory-strength gate.

### `unpushed-work-advisory`

At session stop, reports dirty paths this extension instance observed touched and unpushed commits since its repository baseline.

Path-level counts include pre-existing or concurrent edits in the same file.
Before staging, inspect staged and unstaged hunks for ownership. A touched path is not permission to stage or commit the whole file.

A SHA range likewise does not establish authorship. The reminder grants no authority to commit or publish.
