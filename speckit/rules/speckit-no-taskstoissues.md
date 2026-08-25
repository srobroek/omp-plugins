---
name: speckit-no-taskstoissues
description: Blocks /speckit.taskstoissues, which forks task state into GitHub issues alongside beads.
condition: ["(?i)(?:^|[\\s;|&])/?speckit[.-]taskstoissues(?![\\w-])"]
scope: "tool:bash"
interruptMode: always
---

`/speckit.taskstoissues` (and `speckit-taskstoissues`) converts tasks.md into
GitHub issues. In a beads repo that is a second task tracker, and task state
already lives in beads.

Do not run it. To reference work that already has a GitHub issue, link it
instead: `bd update <id> --external-ref gh-<number>`.

Detection limit: the condition is anchored to a token boundary, so `taskstoissues`
alone (a bead title, a grep pattern) no longer fires it. Quoting is invisible to a
regex, so the literal command name inside a quoted argument — `bd create --title
'port speckit-taskstoissues deny'` — still fires, and a nested script path
(`.specify/scripts/bash/speckit-taskstoissues.sh`) no longer does. Separating
those two needs argv parsing, which is a `tool_call` gate's job, not a token
stream's.
