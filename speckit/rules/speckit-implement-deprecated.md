---
name: speckit-implement-deprecated
description: Advises that /speckit.implement is deprecated in beads repos.
condition: ["(?i)(?:^|[\\s;|&])/?speckit[.-]implement(?![\\w-])"]
scope: "tool:bash"
interruptMode: never
---

`/speckit.implement` is deprecated in beads repos. Route through the
agent-assign chain (`/speckit.agent-assign.assign` → validate → execute) and
work molecule steps via `bd mol current` / `bd ready` / `bd update --claim` /
`bd close`. `speckit-basic` works task beads under implement directly.

Anchored to a token boundary, so reading or naming this rule
(`speckit-implement-deprecated`) no longer fires it; a nested script path is not
matched either.
