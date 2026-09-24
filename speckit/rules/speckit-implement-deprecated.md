---
name: speckit-implement-deprecated
description: In SpecKit text, route deprecated `/speckit.implement` through the agent-assign workflow.
condition: ["(?i)(?:^|\\s)/speckit[.-]implement(?![\\w-])"]
scope: "text"
interruptMode: never
---

`/speckit.implement` is deprecated. Use the runtime-native SpecKit skill
interface and work task beads directly under the unconditional `implement`
step: inspect `bd mol current` / `bd ready`, then claim and close beads with
`bd update --claim` / `bd close`.

