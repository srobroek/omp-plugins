---
name: typescript-component-layout
description: React page layout primitive, scroll containment, named slot props, barrel deprecation ledger
globs: ["**/*.ts","**/*.tsx","**/*.mts","**/*.cts","**/*.js","**/*.jsx","**/*.mjs","**/*.cjs"]
---

# TypeScript Component & Layout

- Define **one** layout primitive that pins headers and action bars and provides
  **exactly one** scrollable content region. All pages compose from it; none
  re-implement scroll containment. Nested scroll containers are the defect this
  prevents, and they are invisible until a user resizes the window.
- Document the primitive's implicit layout contracts in doc-comments on the
  primitive itself (for example, "do not nest inside another scroll container") --
  a caller cannot infer them from the prop types.
- Prefer named `ReactNode` slot props (`topBar`, `detail`, `actions`) over boolean
  props that toggle regions; render a slot region only when its prop is truthy so
  no empty wrapper reserves layout space.
- Treat barrel files (`index.ts`) as a deprecation ledger: removing an export
  there first surfaces every consumer in one typecheck pass.
