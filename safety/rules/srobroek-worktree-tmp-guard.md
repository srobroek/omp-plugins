---
name: srobroek-worktree-tmp-guard
description: Refuses creating a git worktree under /tmp, where a container bind mount cannot see it.
condition: ["(?i)(?:^|\"command\"\\s*:\\s*\"|\\\\n|\\n|[;&|(]\\s*|\\bthen\\s+|\\bdo\\s+)(?<![\"'\\x60])(?:git\\s+worktree\\s+add|wt\\s+(?:switch|new|co|agent))\\b[^\\n]{0,200}?(?<![\\w~.])(?:\\/private)?\\/tmp\\/"]
scope: ["tool:bash"]
interruptMode: always
---

Do not create a worktree under `/tmp`: the container bind mount cannot see it. Use a path under `$HOME`, such as `~/tmp/worktrees/<repo>/<branch>`, or configure the runtime's file-sharing settings before using another location.
