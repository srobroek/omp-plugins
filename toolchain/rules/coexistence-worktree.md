---
name: coexistence-worktree
description: When other agents or humans edit the same repo or switch the branch underneath you — Worktrunk coexistence.
---

# Multi-Agent Coexistence

When `AGENTS.md` is available, follow its general worktree lifecycle guidance. This rule adds the coexistence policy that remains useful without that file:

- Treat concurrent edits by agents or humans as normal. Do not report foreign changes unless they actively block progress.
- Do not clean up, commit, push, stash, or revert another actor's changes. Leave them alone unless they are an obvious mistake.
- An actor interferes only when it repeatedly overwrites edits, deletes in-progress files, or otherwise prevents progress.

- On interference, move to an isolated task checkout instead of fighting over a shared checkout.
- Before `wt prune`, run `wt prune-preview`, record each candidate tip with `git rev-parse`, then run the real prune.
