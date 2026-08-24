---
name: typescript-styling-theming
description: Two-layer CSS tokens, data-theme theming, density axis, component variant naming
globs: ["**/*.ts","**/*.tsx","**/*.mts","**/*.cts","**/*.js","**/*.jsx","**/*.mjs","**/*.cjs","**/package.json","**/tsconfig*.json"]
---

# TypeScript Styling & Theming

- Two layers: primitives (`:root` raw values) → semantics (intent aliases). Components consume
  semantics only; theme overrides target the primitive layer only.
- `data-theme="<name>"` on root; override primitives in `[data-theme="<name>"]` block.
- Density: orthogonal class (`.ns-density-compact`) overriding `--space-*` / `--size-*` primitives.
- Components: typed layer maps `variant`/`size` props to modifier classes; BEM-like prefix (`.ns-block__el--mod`).
- Styling approach: global CSS + BEM, CSS Modules, or CSS-in-JS -- choose per project; enforce token
  consumption, not tooling.
- Enforce: stylelint rule forbids hardcoded color/size literals; verify components consume semantic tokens.
