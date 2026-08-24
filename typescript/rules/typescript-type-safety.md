---
name: typescript-type-safety
description: Generated-union exhaustive maps, satisfies allow-lists, trust-boundary validation, typed message catalog
---

# TypeScript Type Safety & Validation

- Derive a string-literal union from the authoritative source (error codes,
  command names, route keys, message ids) rather than hand-maintaining a parallel
  list. Map off it via `Record<Union, () => string>` so a new variant is a
  compile error until handled; use `Partial<Record<…>>` only to override a
  subset.
- Keep runtime allow-lists in sync with the union via
  `as const satisfies readonly Union[]` -- `satisfies` checks membership without
  widening the literal types away.
- Apply a schema validator **only** at trust boundaries: external HTTP/IPC
  responses typed `unknown`, query-param and form parsing, config read from disk.
  Re-parsing already-typed internal values costs time and buys no safety.
- Key error messages, UI copy, and notifications off the generated union so a
  missing or mistyped key fails at build time. A runtime i18n library complements
  this; it is not a prerequisite for it.
- Share one `tsconfig.base.json` at the workspace root; packages extend it and
  override only environment specifics (`lib`, `target`, `module`).
