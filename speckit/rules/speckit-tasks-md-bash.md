---
name: speckit-tasks-md-bash
description: Advises that specs/*/tasks.md is not authored in beads repos.
condition: ["."]
scope: "tool:edit(specs/*/tasks.md), tool:write(specs/*/tasks.md)"
interruptMode: never
---

tasks.md is not authored in beads repos; task state lives in beads:
`bd ready` / `bd update <id> --claim` / `bd close <id> --reason`.

Reading a legacy tasks.md for migration is fine, which is why this fires on the
write path only: it used to match any bash command mentioning the path, so
`cat specs/001-foo/tasks.md` advised against a read it permits. Writing is denied
outright by the `speckit_tasks_guard` extension when a beads workspace is active;
this advisory covers the case the gate cannot prove, where `bd where` gives it no
evidence and it fails open.

If a skill's `check-prerequisites.sh --require-tasks` just failed: that check
cannot pass here — skip it and read `bd list --spec <NNN-slug>` instead.
