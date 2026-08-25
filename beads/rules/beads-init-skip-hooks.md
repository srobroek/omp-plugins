---
name: beads-init-skip-hooks
description: Plain bd init rewrites core.hooksPath (~349MB hook copy).
condition: ["\\bbd\\s+init\\b(?![^\\n]*--skip-hooks)"]
scope: "tool:bash"
interruptMode: always
---
Use `bd init --init-if-missing --skip-hooks`. Plain `bd init` repoints `core.hooksPath` and copies ~349MB of hooks (broken on arm64).
