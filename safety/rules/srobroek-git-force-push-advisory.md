---
name: srobroek-git-force-push-advisory
description: Warns on a force push that is not --force-with-lease, which can discard a collaborator's commits.
condition: ["(?i)(?:^|\"command\"\\s*:\\s*\"|\\\\n|\\n)\\s*(?:(?:then|do|else|sudo|command|env|exec|time|nohup|xargs)\\s+(?:-[-A-Za-z0-9]+\\s+)*|[A-Za-z_][A-Za-z0-9_]*=[^\\s;|&\"']*\\s+){0,3}git\\s+push(?:(?!\\\\n)[^;|&\\n]){0,200}?(?:--force(?![-\\w])|\\s-f(?:\\s|$))"]
scope: "tool:bash"
interruptMode: never
---

This push used `--force` or `-f` rather than `--force-with-lease`.

A plain force push overwrites the remote ref unconditionally. If anyone else pushed since your last
fetch, their commits are discarded and the reflog is the only recovery path.

Use `--force-with-lease` instead. It fails when the remote moved, which is the outcome you want.

`--force` is correct in one case: rewriting a branch you own that nothing else tracks, immediately
after a rebase you performed yourself.

## What this does not see

The push has to be in command position: the start of the argument, after `"command":"`, or after a newline.
A push chained behind another command with `;`, `|` or `&&` is not flagged.

That gap is deliberate. Accepting `&&` as command position also matches a quoted mention of the shape, and
the mention is the commoner event: a commit message describing the rule, a `grep` for the pattern, a test
fixture asserting the shape is refused. Inside one argument blob a regex cannot tell a separator from the
same characters inside a string, so the choice is which error to make. This rule prefers silence, because it
is advisory and the matching cost falls on whoever is writing about force pushes.

`safety/rules/srobroek-bash-guards.test.ts` holds the corpus. Both halves are exact: every must-fire case
fires and every must-not-fire case stays silent, for this rule and its two siblings alike.
