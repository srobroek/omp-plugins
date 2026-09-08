# typescript

TypeScript and React architecture conventions, tooling defaults, and a quality skill.

## Skills

- `typescript-quality`: run installed Biome (or ESLint) and `tsc --noEmit` through `typescript_quality`.

## Rules

- `typescript-component-layout`: one layout primitive, slot props, barrels.
- `typescript-state-data`: server and client state, query facade, error seam.
- `typescript-contract-boundary`: generated bindings, dispatch, envelope unwrap.
- `typescript-type-safety`: generated unions, `satisfies`, trust-boundary validation.
- `typescript-build-tooling`: pnpm workspaces, tsconfig, ESLint, CI `check`.
- `typescript-styling-theming`: two-layer tokens, `data-theme`, density.
- `typescript-testing`: test pyramid, conformance, Playwright, drift gate.

## Tools

The plugin's extension modules register `typescript_quality`.

Executable resolution checks project-local `node_modules/.bin` tools before PATH. Check and fix never download executables. Missing projects or requested tools produce `ok: false, complete: false`; skipped checks are not a PASS.
