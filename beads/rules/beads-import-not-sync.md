---
name: beads-import-not-sync
description: bd import is a restore path, not the sync path, and its --allow-stale overwrites newer local state.
condition: ["\\bbd\\s+(?:-C\\s+\\S+\\s+)?import\\b(?![^\\n]*--help)"]
scope: "tool:bash"
interruptMode: always
---
`bd import` loads a JSONL file straight into the database. When deliberately restoring a snapshot or migrating, that is the right tool, so name the snapshot and say why.

Otherwise use the routine path: `bd dolt pull`, or the hook-owned JSONL sync where Dolt is unavailable. Those reconcile. Import does not.

`--allow-stale` lives on this subcommand. It overwrites newer local state with older rows, so naming it asserts the snapshot is the intended truth.

Report the command and wait for the user rather than running it unasked.
