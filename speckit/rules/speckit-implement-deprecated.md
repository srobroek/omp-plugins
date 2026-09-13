---
name: speckit-implement-deprecated
description: In SpecKit text, route deprecated `/speckit.implement` through the agent-assign workflow.
condition: ["(?i)(?:^|\\s)/speckit[.-]implement(?![\\w-])"]
scope: "text"
interruptMode: never
---

`/speckit.implement` is deprecated in beads repos. Route through the
agent-assign chain (`/speckit.agent-assign.assign` → validate → execute) and
work molecule steps via `bd mol current` / `bd ready` / `bd update --claim` /
`bd close`. `speckit-basic` works task beads under implement directly.

