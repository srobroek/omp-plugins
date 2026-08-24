---
name: typescript-contract-boundary
description: Frontend IPC/API generated bindings, dispatch seam, envelope unwrap, conformance test, mock fidelity
globs: ["**/*.ts","**/*.tsx","**/*.mts","**/*.cts","**/*.js","**/*.jsx","**/*.mjs","**/*.cjs"]
---

# TypeScript Contract Boundary

- Generated bindings (tauri-specta, openapi-typescript, gRPC codegen) are the
  single source of truth. Hand-written wrappers delegate to generated names and
  use the exact casing the generator emits; never invent aliases or dotted
  shorthands.
- A static conformance test reads the generated surface and asserts every wrapper
  uses a registered name with matching casing. Mock mode does not catch this:
  mocks reproduce the wrapper's assumptions, so name, casing, and shape drift are
  invisible until a real backend rejects the payload. Keep mock fidelity high
  (same generated names, same envelope shape) to shrink that gap.
- All IPC/API calls route through one dispatch seam that selects real / mock /
  recorder transport. UI code imports the seam, never a transport. The seam owns
  transport selection, envelope unwrap, error normalisation, and telemetry.
- Unwrap once, at the seam: `{ status: "ok", payload: T }` returns `T`;
  `{ status: "error", code, message }` throws `TypedApiError`. Callers get typed
  data or a typed error, never a raw envelope.
- Validate at the seam only what arrives untyped: envelope shape (`status`,
  `code`) and payloads typed `unknown`. Already-typed generated payloads pass
  through.

The server side of this boundary -- command registration, binding export, and the
CI codegen drift gate -- lives in the rust plugin's contract-boundary rule.
