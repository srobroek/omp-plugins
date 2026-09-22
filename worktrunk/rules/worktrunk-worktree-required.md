---
name: worktrunk-worktree-required
alwaysApply: true
---

MUST work inside a git linked worktree of the project, never in its canonical checkout. Where the project has a ledger, claim the bead first:
`bd update <id> --claim`
Then create the worktree with this exact invocation:
`wt switch -y --create --no-cd --base <base> --format json omp/agent/<bead-id>`
Read the created path from that JSON. Address every file by absolute path under it, or pass `-C <worktree>` / `cwd: <worktree>` on each call.

From the canonical checkout, only this narrow bootstrap allowlist is permitted:
- worktree creation and listing, `wt config show`, and `wt step prune --dry-run`;
- read-only `git`/`dgit`: `rev-parse`, `status`, `worktree list`, `fetch`, `log`, and `branch --list`;
- Beads reads, `bd create <title> <args>`, exactly `bd dolt pull`, and `bd update <id> --claim`.
