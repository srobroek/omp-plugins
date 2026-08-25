---
name: srobroek-git-force-push-advisory
description: Warns on a force push that is not --force-with-lease, which can discard a collaborator's commits.
condition: ["\\bgit\\s+push[^\\n]{0,200}(--force(?![-\\w])|\\s-f(\\s|$))"]
scope: "tool:bash"
interruptMode: never
---

This push used `--force` or `-f` rather than `--force-with-lease`.

A plain force push overwrites the remote ref unconditionally. If anyone else pushed since your last
fetch, their commits are discarded and the reflog is the only recovery path.

Use `--force-with-lease` instead. It fails when the remote moved, which is the outcome you want.

`--force` is correct in one case: rewriting a branch you own that nothing else tracks, immediately
after a rebase you performed yourself.
