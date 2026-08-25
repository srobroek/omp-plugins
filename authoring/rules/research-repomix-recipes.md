---
name: research-repomix-recipes
description: When packing a whole tree or many files at once for bulk context with Repomix.
---

# Repomix for bulk context

Repomix packs a whole tree into one document. Run it on demand, from the CLI;
there is no snapshot to keep fresh. A pack of this repository takes 1.3s and
repomix caches nothing, so a second pack costs the same as the first.

| Need | Command |
|------|---------|
| pack the tree | `repomix .` |
| scope to the files that matter | `repomix . --include "src/**/*.ts"` |
| read it without writing a file | `repomix . --stdout` |
| pack another repository | `repomix --remote <url> --remote-branch <ref>` |

Prefer semantic symbol tools and targeted search for a single lookup, and a pack
only when a task needs many files at once. Scoping a pack with `--include` is
enforced by `authoring-repomix-include`.

Decide `--compress` per language. It saved 21 percent on this repository and 0
percent on markdown and JSON. It grew 197 files of 4,107.
