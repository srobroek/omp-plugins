---
name: srobroek-git-force-push-advisory
description: Warns on a force push that is not --force-with-lease, which can discard a collaborator's commits.
condition: ["(?i)(?:^|\"command\"\\s*:\\s*\"|\\\\n|\\n|[;&|(]\\s*|\\bthen\\s+|\\bdo\\s+)(?:(?:then|do|else|sudo|command|env|exec|time|nohup|xargs)\\s+(?:-[-A-Za-z0-9]+\\s+)*|[A-Za-z_][A-Za-z0-9_]*=[^\\s;|&\"']*\\s+){0,3}(?<!(?:(?<!\"command\"\\s*:\\s*)[=\\s(,\\[]|(?<!\"command\"\\s*):)\\\\?[\"'][^\"'\\n]{0,300})git\\s+(?:-C\\s+\\S+\\s+)?push(?:(?!\\\\n)[^;|&\\n]){0,200}?(?:--force(?!(?:-with-lease(?:=|\\s|[\"}]|$)|-if-includes(?:\\s|[\"}]|$)))|\\s-[^-\\s]*f[A-Za-z0-9]*(?=[\\s\"}]|$))"]
scope: "tool:bash"
interruptMode: never
---

This push used `--force` or `-f` rather than `--force-with-lease`.

A plain force push overwrites the remote ref unconditionally. If anyone else pushed since your last fetch, their commits are discarded and the reflog is the only recovery path. Use `--force-with-lease` instead; it fails when the remote moved.
