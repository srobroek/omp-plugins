# typescript

TypeScript and React architecture conventions, tooling defaults, and a quality skill.

## Skills

- `typescript-quality`: run installed Biome (or ESLint) and `tsc --noEmit` through `typescript_quality`.

## Rules

- `typescript-type-safety`: generated unions, `satisfies`, trust-boundary validation.

## Tools

The plugin's extension modules register `typescript_quality`.

Executable resolution searches project-local `node_modules/.bin` first, then PATH. Check and fix never download executables. Missing projects or requested tools produce `ok: false, complete: false`; skipped checks are not a PASS.
