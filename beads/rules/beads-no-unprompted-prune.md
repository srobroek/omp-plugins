---
name: beads-no-unprompted-prune
description: Irreversible Dolt maintenance needs a human.
condition: ["(?m)(?<![\"'\\x60])(?:^|(?:&&|\\|\\||[;&|()])\\s*|\\bthen\\s+|\\bdo\\s+)(?:[A-Za-z_][A-Za-z0-9_]*=\\S+\\s+)*bd(?:\\s+(?:-C\\s+\\S+|--directory(?:=\\S+|\\s+\\S+)))*\\s+(?:admin\\s+)?(?:prune|purge|flatten|gc|compact)\\b(?![^\\n;&|()]*--(?:dry-run|help)\\b)"]
scope: "tool:bash"
interruptMode: always
---

Never run `bd prune`, `bd purge`, `bd flatten`, `bd gc`, or `bd compact`
unprompted, in their bare or `bd admin` forms. Preview with `--dry-run`, report
the numbers, and wait for the user.

`bd prune`, `bd purge`, `bd flatten`, `bd gc --older-than`, `bd compact --days`
and `bd admin compact` each discard history, closed issues, or their content
permanently. `bd compact --dolt` collects garbage instead and discards nothing,
and it still interrupts: which behaviour a `bd compact` invocation takes depends
on a flag, a flag-level exception is bypassed by reordering or quoting, and
`--dolt` is documented against `.beads/dolt` rather than the embedded
`.beads/embeddeddolt` these projects use. One confirmation is cheaper than a
squashed history. `rule://beads-storage-maintenance` gives the reclaim order.

The safe preview and help forms remain allowed. The command-position anchor
keeps quoted mentions silent, supports `-C` and `--directory`, and evaluates the
safe exception only within the current shell command.
