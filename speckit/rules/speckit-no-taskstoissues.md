---
name: speckit-no-taskstoissues
description: Blocks the /speckit.taskstoissues slash form; bash invocations are owned by the taskstoissues-gate extension.
condition: ["(?:^|[\\s;|&])/speckit\\.taskstoissues(?![\\w-])"]
scope: ""
interruptMode: always
---

`/speckit.taskstoissues` converts tasks.md into GitHub issues. In a beads repo
that is a second task tracker; task state already lives in beads.

Do not invoke it. Link an existing GitHub issue instead:
`bd update <id> --external-ref gh-<number>`.

Bash-surface invocations (`speckit-taskstoissues`, `specify run /speckit.taskstoissues`,
and the same words at command position) are blocked by the
`extensions/taskstoissues-gate.ts` `tool_call` gate, which tokenizes argv so a
quoted title or commit message does not fire.
