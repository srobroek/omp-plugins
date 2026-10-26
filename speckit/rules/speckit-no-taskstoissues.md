---
name: speckit-no-taskstoissues
description: Stops a SpecKit taskstoissues invocation; interrupts a read of its skill and advises on a line-start slash command.
condition: ["(?m)^\\s*/speckit(?:\\.|\\.github\\.|-github-)taskstoissues(?![\\w-])", "\"path\"\\s*:\\s*\"skill://speckit[-.](?:github[-.])?taskstoissues(?![\\w-])"]
scope: "text, tool:read"
interruptMode: tool-only
---

`/speckit.taskstoissues` converts tasks.md into GitHub issues. In a beads repo
that is a second task tracker; task state already lives in beads. Spec-kit 1.2
moves it to the bundled `github` extension as `/speckit.github.taskstoissues`
(`/speckit-github-taskstoissues` on slash-hyphen integrations); every name gets
this reminder.

Do not invoke it. Link an existing GitHub issue instead:
`bd update <id> --external-ref gh-<number>`.

Its real route is the `speckit-taskstoissues` or `speckit-github-taskstoissues`
agent skill, so a `read` of either skill is interrupted. A slash command at the start of a prose line gets this
reminder; a mention inside a sentence does not. No executable of that name
exists, so there is no bash route to guard.
