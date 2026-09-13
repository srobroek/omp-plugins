# delivery

This plugin provides Git workflows for OMP. Its rule covers PR delivery, automated-review fix loops, landing proof, worktree cleanup, and links to the beads merge queue.

## Agents

| Name | When |
| --- | --- |
| `pr-reviewer` | Reviews a pull request without changing it. Returns `VERDICT:` only. It has no shell, because it reads untrusted PR and bead text, so whoever spawns it passes the bead context: accepted scope, holder, and relevant comments. |

## Rules

| Name | When |
| --- | --- |
| `delivery-git-workflow` | Creating or reviewing PRs, owning automated-review loops, proving a landing under GW-3, cleaning worktrees under GW-6, applying GW-7 release-subject titles, and linking beads to the merge queue. |

## Extensions

### `main-branch-gate`

Blocks a `git`/`dgit` commit whose target repository has `main` or `master` checked out. It reads `git branch --show-current` in that repository, not the commit message.

When git cannot name a branch, the gate allows the call. With `--dry-run` as a standalone commit option, the gate also allows the call. That exception excludes option values and paths after `--`.

For a user-authorized exception, set `DELIVERY_ALLOW_MAIN_COMMIT=1` in the process environment or as an assignment prefix on the commit invocation. Message or echo text does not enable the override. The override records the exception. Host approval is still required.

Directory checks are preflight observations, not atomic guarantees. Dynamic shell state remains outside this advisory-strength gate.

### `primary-checkout-gate`

Blocks an `edit`, a `write`, or a `git`/`dgit` commit whose target lies in a repository's primary checkout: the checkout whose `git rev-parse --git-dir` equals its `--git-common-dir`. A Worktrunk worktree (or any `git worktree add`) is linked, so it passes. Paths outside a repository, internal URIs, and the `.omp/` and `.beads/` state directories pass.

When git cannot answer, the gate allows the call. The refusal names the `wt switch --create` command to run instead.

For a user-authorized exception, set `DELIVERY_ALLOW_PRIMARY_CHECKOUT=1` in the process environment or in the bash call's `env`. Text in a command or a file body does not enable it.

The gate is advisory-strength. It reads the two tool surfaces agents edit through and the commit boundary. A shell command that writes files (`sed -i`, a redirection, a script) is not parsed, because a shell parser in a gate produces silent permits.

### `unpushed-work-advisory`

At session stop, reports dirty paths this extension instance observed touched and unpushed commits since its repository baseline.

Path-level counts include pre-existing or concurrent edits in the same file. Before staging, inspect staged and unstaged hunks for ownership. A touched path is not permission to stage or publish the whole file.

A SHA range likewise does not establish authorship. The reminder grants no authority to stage or publish.
