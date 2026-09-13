---
name: beads-no-bd-edit
description: bd edit shells out to $EDITOR and blocks a non-interactive agent.
condition: ["(?m)(?<![\"'\\x60])(?:^|(?:&&|\\|\\||[;&|()])\\s*|\\bthen\\s+|\\bdo\\s+)(?:[A-Za-z_][A-Za-z0-9_]*=\\S+\\s+)*bd(?:\\s+(?:-C\\s+\\S+|--directory(?:=\\S+|\\s+\\S+)))*\\s+edit\\b(?![^\\n;&|()]*--help\\b)"]
scope: "tool:bash"
interruptMode: always
---

`bd edit` opens `$EDITOR` and can stall a non-interactive agent. Use explicit
non-interactive updates instead:

- `bd update <id> --status <s> --priority <p> --assignee <a>`
- `bd comment <id> -m "<text>"`
- `bd label add <id> <label>`

`bd edit --help` and `bd help edit` stay allowed. The condition is anchored to
command position and supports environment prefixes plus `-C`/`--directory`.
