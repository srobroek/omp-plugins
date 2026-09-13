---
name: beads-import-not-sync
description: bd import is a restore path, not the sync path, and its --allow-stale overwrites newer local state.
condition: ["(?m)(?<![\"'\\x60])(?:^|(?:&&|\\|\\||[;&|()])\\s*|\\bthen\\s+|\\bdo\\s+)(?:[A-Za-z_][A-Za-z0-9_]*=\\S+\\s+)*bd(?:\\s+(?:-C\\s+\\S+|--directory(?:=\\S+|\\s+\\S+)))*\\s+import\\b(?![^\\n;&|()]*--help\\b)"]
scope: "tool:bash"
interruptMode: always
---

`bd import` loads a JSONL file directly into the database. Use it only for a
deliberate restore or migration, naming the snapshot and why it is authoritative.
Routine synchronization uses `bd dolt pull`, or hook-owned JSONL sync where Dolt
is unavailable.

`--allow-stale` overwrites newer local state with older rows. Report the command
and wait for the user rather than running a restore unasked.
