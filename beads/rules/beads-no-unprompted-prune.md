---
name: beads-no-unprompted-prune
description: Irreversible Dolt maintenance needs a human.
condition: ["(?m)(?<![\"'\\x60])(?:^|(?:&&|\\|\\||[;&|()])\\s*|\\bthen\\s+|\\bdo\\s+)(?:[A-Za-z_][A-Za-z0-9_]*=\\S+\\s+)*bd(?:\\s+(?:-C\\s+\\S+|--directory(?:=\\S+|\\s+\\S+)))*\\s+(?:prune|purge|flatten)\\b(?![^\\n;&|()]*--(?:dry-run|help)\\b)"]
scope: "tool:bash"
interruptMode: always
---

Never run `bd prune`, `bd purge`, or `bd flatten` unprompted. Preview with
`--dry-run`, report the numbers, and wait for the user.

The safe preview and help forms remain allowed. The command-position anchor
keeps quoted mentions silent, supports `-C` and `--directory`, and evaluates the
safe exception only within the current shell command.
