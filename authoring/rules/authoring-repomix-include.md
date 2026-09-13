---
name: authoring-repomix-include
description: When running Repomix, require --include unless stdout or remote mode is explicit.
condition: ["(?:^|[;&|(]\\s*|\\b(?:then|do)\\s+)repomix\\b(?![^\\n]*--include)(?![^\\n]*--stdout)(?![^\\n]*--remote)"]
scope: "tool:bash"
interruptMode: never
---

This pack has no `--include`, so it carries the whole tree.

Scope it to the files the task needs: `repomix . --include "src/**/*.ts"`. Scoping to code cut
output 81 percent against a whole-repo pack when this was measured.

Pack everything only when the task needs every file. `rule://research-repomix-recipes` has the
remaining recipes: stdout, remote repositories, and when `--compress` pays.
