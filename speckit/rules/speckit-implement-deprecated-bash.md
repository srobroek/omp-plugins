---
name: speckit-implement-deprecated-bash
description: In bash, route the deprecated SpecKit implement command through the agent-assign workflow.
condition: ["(?:^|[;&|(]\\s*|\\b(?:then|do)\\s+)(?:speckit[.-]implement)(?![\\w-])"]
scope: "tool:bash"
interruptMode: never
---

`speckit-implement` is deprecated in beads repos. Route through the agent-assign chain (`/speckit.agent-assign.assign` → validate → execute) and work molecule steps via `bd mol current` / `bd ready` / `bd update --claim` / `bd close`.
