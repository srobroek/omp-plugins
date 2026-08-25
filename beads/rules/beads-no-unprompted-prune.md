---
name: beads-no-unprompted-prune
description: Irreversible Dolt maintenance needs a human.
condition: ["\\bbd\\s+(prune|purge|flatten)\\b"]
scope: "tool:bash"
interruptMode: always
---
Never run `bd prune`, `bd purge`, or `bd flatten` unprompted. Preview `--dry-run`, report numbers, wait for the user.
