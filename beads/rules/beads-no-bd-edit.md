---
name: beads-no-bd-edit
description: bd edit shells out to $EDITOR and blocks a non-interactive agent.
condition: ["\\bbd\\s+(?:-C\\s+\\S+\\s+)?edit\\b(?![^\\n]*--help)"]
scope: "tool:bash"
interruptMode: always
---
`bd edit` opens `$EDITOR`. Verified: with `EDITOR=true` it exits 0 and prints `No changes made`, so bd really does invoke the editor.

An agent has no terminal to answer with. A real editor waits for input that never arrives, and the session stalls until someone kills it.

Use the flag forms, which write the same fields without a terminal:

- `bd update <id> --status <s> --priority <p> --assignee <a>`
- `bd comment <id> -m "<text>"`
- `bd label add <id> <label>`

`bd edit --help` and `bd help edit` stay allowed. This rule catches only the interactive form.
