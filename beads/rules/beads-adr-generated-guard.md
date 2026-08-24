---
name: beads-adr-generated-guard
description: Advises against editing generated ADRs under docs/adr/; update the decision bead instead.
condition: ["."]
scope: "tool:edit(docs/adr/**), tool:write(docs/adr/**)"
interruptMode: never
---

This file is generated from a decision bead.

Update the bead (`bd update <id>`) and regenerate instead of editing the file.
Hand-authored ADRs in repos that do not run the renderer stay editable.
