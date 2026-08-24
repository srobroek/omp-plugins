---
name: typescript-testing
description: Frontend test pyramid, jsdom shims, IPC DI override, conformance test, Playwright split, CI drift gate
globs: ["**/*.ts","**/*.tsx","**/*.mts","**/*.cts","**/*.js","**/*.jsx","**/*.mjs","**/*.cjs","**/package.json","**/tsconfig*.json"]
---

# TypeScript Testing

## Test pyramid

| Layer | Scope | Mocking | Gating |
|-------|-------|---------|--------|
| Unit | Pure functions, isolated components (jsdom) | Full DI | None |
| Layer-1 integration | Real business logic, mocked network edge only | Schema-matching IPC fixtures via DI | Conformance test, drift gate |
| Layer-2 e2e | Full stack via browser automation | None | Infrastructure availability (backend-mode flag) |

## Rules

- jsdom shims: centralize in one file (e.g. `vitest.setup.ts`), loaded via setup-files.
- IPC/API wrappers: test against real generated response shape via DI override; reset in `afterEach`.
- Conformance test: static test asserts wrapper calls match registered command names exactly.
  Run in CI before Layer-1; catches codegen stale-binding bugs.
- Backend-mode split (Layer-2): separate Playwright configs per mode; pin the backend-mode flag explicitly.
- CI drift gate: after any generation step, `git diff --exit-code` on generated files.
