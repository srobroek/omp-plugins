---
name: rust-workspace
description: When setting Cargo workspace lints, workspace.dependencies, feature-gated dev surfaces, or layered Rust tests.
---

# Rust Workspace Defaults

## Rules

- Workspace lints belong in `[workspace.lints]`; members inherit them via
  `[lints] workspace = true`.
- Keep semver ranges in `[workspace.dependencies]`; members use
  `{ workspace = true }`. Do not pin patch-level without a known breakage;
  document the reason. Bump once per workspace.
- Keep dev dependencies in the crate that uses them. Add a shared `tests-common`
  library only when multiple crates share elaborate fixtures. Keep automation
  dependencies in CI/toolchain files, not `[dev-dependencies]`.
- Keep unit, integration, and end-to-end tests in the crate or workspace layer
  that owns them. Use targeted package tests while unrelated packages are red.

## Feature-gated dev surface

- Dev/testing/debug surface: default-off Cargo feature (`#[cfg(feature = "…")]`), not a runtime flag.
- Gate propagates: edge binary declares it, app crate enables it, leaf crates compile only when enabled.
- Release binaries build with the feature off -- code is absent at compile time.
