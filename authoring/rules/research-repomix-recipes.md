---
name: research-repomix-recipes
description: When packing a whole tree or many files at once for bulk context with Repomix.
---

# Repomix for bulk context

Use Repomix for bulk source review, not a single lookup. A scaffolded
project maintains a scoped, ignored `repomix.xml` through prek hooks; check
`graphify-out/context-status.json` before using it. Otherwise pack on demand.

| Need | Command |
|------|---------|
| refresh a scaffolded snapshot | `python3 .omp/context.py refresh` |
| scope to the files that matter | `repomix . --include "src/**/*.ts"` |
| read it without writing a file | `repomix . --stdout` |
| pack another repository | `repomix --remote <url> --remote-branch <ref>` |

Prefer semantic symbol tools and targeted search for a single lookup, and a pack
only when a task needs many files at once. Scoping a pack with `--include` is
enforced by `authoring-repomix-include`.

Graphify answers relationship and impact questions; Repomix supplies source text
for the selected files. A token-capped snapshot is not exhaustive. Never import
the XML into startup instructions; use source and LSP for exact edits.

Decide `--compress` per language. It saved 21 percent on this repository and 0
percent on markdown and JSON. It grew 197 files of 4,107.
