---
name: typescript-quality
description: Use to run TypeScript or JavaScript format, lint, and type-check commands.
---

# TypeScript Quality

Use the `typescript_quality` tool (`mode: "check" | "fix"`, optional `path`). Check runs biome (or eslint) then tsc --noEmit via the first available runner (pnpm, bun, npx, then global). Fix runs biome check --write. Missing package.json or tools are skipped.

Read failures as the project's actual toolchain output; do not invent extra linters.
