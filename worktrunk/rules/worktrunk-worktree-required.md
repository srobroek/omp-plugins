---
name: worktrunk-worktree-required
alwaysApply: true
---

MUST work inside a git linked worktree of the project, never in its canonical
checkout. Where the project has a ledger, claim first, then create the worktree:
`bd update <id> --claim`, then
`wt switch -y --create --no-cd --base <base> --format json omp/agent/<bead-id>`.
Read the created path from that JSON and address every file by absolute path
under it, or pass `-C <worktree>` / `cwd: <worktree>` on each call.

MUST pass the global `-y` on every `wt` invocation and end every
worktree-creating one with an explicit branch argument: `wt switch` with no
branch opens an interactive picker that hangs a non-interactive agent. Prefer the
global `-C <path>` over relying on the current directory.

MUST leave the canonical checkout's working tree untouched. Landing merges a pull
request; the canonical checkout is then refreshed with
`git -C <canonical> fetch origin`, which writes no working-tree file. There is no
local fast-forward and no reason to edit, build, or stash there.

DEFAULT From the canonical checkout only bootstrap commands are available:
creating or listing worktrees, `wt config show`, `wt step prune --dry-run`,
`git`/`dgit` commands (`rev-parse`, `status`, `worktree list`, `fetch`,
`push`, `log`, `branch --list`), where `push` writes no working-tree file
because refs are shared across every worktree, and `bd`, which needs the
canonical checkout to reach the project's embedded store. An agent's first
action necessarily starts there, because a spawned child inherits its parent's
working directory.

A worktree belongs to the work, not to the agent instance holding it. A retry, a
review round, and an escalation to a different agent all continue the same branch
and the same worktree, so the previous attempt is the starting point rather than
something to redo; force-push with `--force-with-lease`.

This is an accident guardrail, not a sandbox. A process whose working directory
is a worktree can still write any absolute path through `git -C <canonical>`, a
shell redirection, or `eval`. Nothing prevents that, and nothing needs to:
canonical is never a merge target, so no legitimate step writes there.
