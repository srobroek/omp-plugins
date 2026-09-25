---
name: worktrunk-worktree-required
alwaysApply: true
---

MUST work inside a git linked worktree of the project, never in its canonical checkout.

Create one with this exact non-interactive invocation:
`wt switch -y --create --no-cd --base <base-commit> --format json <branch>`
Read the created path from that JSON. Address every file by absolute path under it, or pass `-C <worktree>` / `cwd: <worktree>` on each call.

`--base` takes a commit and defaults to the default branch's current tip. Concurrent workers MUST pass the run's recorded base commit, so every branch is cut from the same point instead of from whatever has landed since.

Provisioning runs in the post-start hook in the background (reflinked copy; `uv sync` for Python). If an immediate test, typecheck, or dev server fails with missing-module or missing-type errors, inspect `wt config state logs --format=json`, wait for the hook to finish, and retry before diagnosing source code.

No bead is required to create a worktree. Where the project has a ledger, claim the bead for the work itself; its order relative to worktree setup does not matter. Branch names are not policed.

From the canonical checkout, only this narrow bootstrap allowlist is permitted:
- worktree creation, provisioning and listing: `wt switch`, `wt step copy-ignored`, `git worktree add`, `wt config show`, `wt step prune --dry-run`, and creating the worktree's parent directory;
- read-only `git`/`dgit`: `rev-parse`, `status`, `worktree list`, `fetch`, `log`, and `branch --list`;
- Beads reads, `bd create <title> <args>`, exactly `bd dolt pull`, and `bd update <id> --claim`.
