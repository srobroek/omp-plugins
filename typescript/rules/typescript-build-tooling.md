---
name: typescript-build-tooling
description: TypeScript monorepo pnpm workspace, tsconfig layering, ESLint flat config, formatter gate, CI check chain
globs: ["**/*.ts","**/*.tsx","**/*.mts","**/*.cts","**/*.js","**/*.jsx","**/*.mjs","**/*.cjs","**/package.json","**/tsconfig*.json"]
---

# TypeScript Build & Tooling

Keep existing project choices unless the task is explicitly about setup,
migration, or standardization.

## pnpm Workspaces

| Pattern | Guidance |
|---------|----------|
| Root layout | Keep root private; add `packageManager` field; define `packages` glob. |
| Internal deps | `workspace:*` protocol for cross-package imports. |
| Scripts | `pnpm -r --if-present <script>` -- packages opt in by defining the script. |

## Type Checking & Bundling

- `tsc --noEmit` runs independently of bundling via a dedicated `typecheck` script.
- tsconfig: child packages extend a root base config with package-local overrides.

## ESLint (Flat Config)

- `eslint.config.mjs/ts`; `parserOptions.projectService` + `tsconfigRootDir` for type-aware rules.
- Exclude generated dirs; document each suppress/override with an inline rationale comment.

## Formatting

One formatter (Prettier, Biome, or dprint) on `.ts/.tsx/.js/.jsx` in the lint gate, run in CI.

## Task Runner & CI

| Phase | Notes |
|-------|-------|
| Cheap: `format --check`, `lint` | Run first. |
| Medium: `typecheck` | Gates type safety before tests. |
| Expensive: `test:unit`, `test:integration` | After format/lint/typecheck pass. |
| `check` target | Chains all above; CI mirrors `check` exactly. |

## Code Intelligence Tools

Advisory: knip (unused exports/deps), madge (circular deps), ast-grep (structural patterns);
gate knip in CI per project.
