---
name: speckit-tasks-md-bash
description: Advises that specs/*/tasks.md is not authored in beads repos.
condition: ["specs/.*/tasks\\.md"]
scope: "tool:bash"
interruptMode: never
---

tasks.md is not authored in beads repos; task state lives in beads:
`bd ready` / `bd update <id> --claim` / `bd close <id> --reason`.

Reading a legacy tasks.md for migration is fine. Writing it is denied by the
`speckit_tasks_guard` extension when a beads workspace is active.

If a skill's `check-prerequisites.sh --require-tasks` just failed: that check
cannot pass here — skip it and read `bd list --spec <NNN-slug>` instead.
