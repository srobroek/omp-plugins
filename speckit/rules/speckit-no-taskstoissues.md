---
name: speckit-no-taskstoissues
description: Blocks /speckit.taskstoissues, which forks task state into GitHub issues alongside beads.
condition: ["(?i)speckit[.-]taskstoissues"]
scope: "tool:bash"
interruptMode: always
---

`/speckit.taskstoissues` (and `speckit-taskstoissues`) converts tasks.md into
GitHub issues. In a beads repo that is a second task tracker, and task state
already lives in beads.

Do not run it. To reference work that already has a GitHub issue, link it
instead: `bd update <id> --external-ref gh-<number>`.
