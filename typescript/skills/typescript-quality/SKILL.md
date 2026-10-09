---
name: typescript-quality
description: Use to run TypeScript or JavaScript format, lint, and type-check commands.
---

# TypeScript Quality

Use the `typescript_quality` tool (`mode: "check" | "fix"`, optional `path`). Check runs one linter, Biome or ESLint, then tsc --noEmit when tsconfig.json exists. Fix runs Biome check --write or ESLint --fix. The linter is the first found of: project-local Biome, project-local ESLint, Biome on PATH, ESLint on PATH; tsc likewise prefers node_modules/.bin. Neither mode downloads executables.
Missing package.json, tsconfig.json, or requested tools make the report incomplete (`ok: false, complete: false`). Skipped steps are not PASS.
Both modes run on the whole project at `path`, so fix mode can rewrite files outside the task; review the diff and revert incidental rewrites.

Read failures as the project's actual toolchain output; do not invent extra linters.
