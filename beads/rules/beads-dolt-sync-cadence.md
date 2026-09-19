---
name: beads-dolt-sync-cadence
description: Enforce embedded-store Dolt synchronization cadence.
condition: ["(?m)(?<![\"'\\x60])(?:^|(?:&&|\\|\\||[;&|()])\\s*|\\bthen\\s+|\\bdo\\s+)(?:[A-Za-z_][A-Za-z0-9_]*=\\S+\\s+)*bd(?:\\s+(?:-C\\s+\\S+|--directory(?:=\\S+|\\s+\\S+)))*\\s+dolt\\s+(?:pull|push)\\b"]
scope: "tool:bash"
interruptMode: never
---

- MUST run `bd dolt pull` before claiming any bead or starting work in a repository with `.beads/`.
- MUST run `bd dolt push` after every epic or feature is delivered (epic bead closed, or its PR landed).
- NEVER sync `.beads/*.jsonl` through git; NEVER start a Dolt server (`bd dolt start`, `dolt sql-server`, `BEADS_DOLT_AUTO_START=1`). The store is embedded.
