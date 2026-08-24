---
name: rust-contract-boundary
description: When generating Rust bindings, guarding codegen drift, pinning IPC invoke names, or choosing wire casing.
globs: ["**/*.rs", "**/Cargo.toml"]
---

# Rust Contract Boundary

- Generated cross-language bindings are authoritative: commit them and fail CI on
  `git diff --exit-code` after regeneration. This is the ONE drift gate for the
  whole generated surface -- the TypeScript side consumes it, it does not repeat
  it.
- Registered command/operation names must equal client invoke targets exactly.
  Never rename an invoke target; encode the rule as a CI-failing test (for
  example, forbid dotted invoke strings).
- Pin one wire casing on both sides with `rename_all`. A single mismatched key
  fails the whole payload, so guard it with a static test.
- A mock or stub transport hides real-backend name, casing, and schema
  mismatches. Conformance tests must run against the real surface, not the mock.
- Route generated calls through a single dispatch seam (mock / record / real);
  wrap free-form `unknown` payloads in an opaque newtype.
