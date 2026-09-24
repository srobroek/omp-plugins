---
name: speckit-implement-deprecated-bash
description: In bash, route the deprecated SpecKit implement command through the agent-assign workflow.
condition: ["(?:^|[;&|(]\\s*|\\b(?:then|do)\\s+)(?:speckit[.-]implement)(?![\\w-])"]
scope: "tool:bash"
interruptMode: never
---

`speckit-implement` is deprecated. Use the runtime-native SpecKit skill interface and work task beads directly under the unconditional `implement` step; inspect `bd mol current` / `bd ready`, then claim and close beads with `bd update --claim` / `bd close`.
