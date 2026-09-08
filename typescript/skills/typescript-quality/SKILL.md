---
name: typescript-quality
description: Use to run TypeScript or JavaScript format, lint, and type-check commands.
---

# TypeScript Quality

Use the `typescript_quality` tool (`mode: "check" | "fix"`, optional `path`). Check runs installed Biome (or ESLint) then tsc --noEmit. Fix runs Biome check --write or ESLint --fix. Project-local node_modules/.bin tools take precedence over PATH tools; neither mode downloads executables.
Missing package.json or requested tools make the report incomplete (`ok: false, complete: false`). Skipped steps are not PASS.

Read failures as the project's actual toolchain output; do not invent extra linters.
