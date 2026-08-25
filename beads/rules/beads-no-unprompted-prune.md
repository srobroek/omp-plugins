---
name: beads-no-unprompted-prune
description: Irreversible Dolt maintenance needs a human.
condition: ["(?m)(?:^|[;|&]\\s*)bd(?:\\s+-C\\s+\\S+)?\\s+(?:prune|purge|flatten)\\b(?![^\\n]*--(?:dry-run|help))"]
scope: "tool:bash"
interruptMode: always
---
Never run `bd prune`, `bd purge`, or `bd flatten` unprompted. Preview `--dry-run`, report numbers, wait for the user.

`--dry-run` and `--help` are excluded: the preview is the documented safe path, so
blocking it blocked the way out of the rule. The condition is anchored to command
position, so a mention (`echo bd prune`, a commit message) no longer fires it, and
`bd -C <dir> prune` now does.
