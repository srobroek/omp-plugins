---
name: worktrunk-worktree-required
alwaysApply: true
---

MUST work inside a git linked worktree of the project, never in its canonical checkout.

Create one with this exact non-interactive invocation:
`wt switch -y --create --no-cd --base <base-commit> --format json <branch>`
Read the created path from that JSON. For every file tool (`read`, `edit`, `write`, `grep`, `glob`, `ast_edit`, or `lsp`), pass an absolute path under the agent's own worktree. NEVER pass a relative file path: relative paths resolve against the lead's canonical checkout. For Bash commands, use `-C <worktree>` or the tool's `cwd` field.

`--base` takes a commit and defaults to the default branch's current tip. Concurrent workers MUST pass the run's recorded base commit, so every branch is cut from the same point instead of from whatever has landed since.

Provisioning runs in the post-start hook in the background (reflinked copy; `uv sync` for Python). If an immediate test, typecheck, or dev server fails with missing-module or missing-type errors, inspect `wt config state logs --format=json`, wait for the hook to finish, and retry before diagnosing source code.

When the project has a ledger, claim the bead before creating a branch or worktree; if the atomic claim is refused, treat the bead as taken and do not release another actor's claim. Branch names are not policed.

From the canonical checkout, only this narrow bootstrap allowlist is permitted:
- worktree creation, provisioning and listing: `wt switch`, `wt step copy-ignored`, `git worktree add`, `wt config show`, `wt step prune --dry-run`, and creating the worktree's parent directory;
- read-only `git`/`dgit`: `rev-parse`, `status`, `worktree list`, `fetch`, `log`, and `branch --list`;
- Beads reads, `bd create <title> <args>`, exactly `bd dolt pull`, and `bd update <id> --claim`.
