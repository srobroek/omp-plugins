---
name: speckit-no-taskstoissues
description: Stops a SpecKit taskstoissues invocation; interrupts a read of its skill and advises on a line-start slash command.
condition: ["(?m)^\\s*/speckit\\.taskstoissues(?![\\w-])", "\"path\"\\s*:\\s*\"skill://speckit[-.]taskstoissues(?![\\w-])"]
scope: "text, tool:read"
interruptMode: tool-only
---

`/speckit.taskstoissues` converts tasks.md into GitHub issues. In a beads repo
that is a second task tracker; task state already lives in beads.

Do not invoke it. Link an existing GitHub issue instead:
`bd update <id> --external-ref gh-<number>`.

Its real route is the `speckit-taskstoissues` agent skill, so a `read` of that
skill is interrupted. A slash command at the start of a prose line gets this
reminder; a mention inside a sentence does not. No executable of that name
exists, so there is no bash route to guard.
