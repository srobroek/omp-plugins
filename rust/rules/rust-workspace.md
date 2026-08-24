---
name: rust-workspace
description: When setting Cargo workspace lints, workspace.dependencies, feature-gated dev surfaces, or layered Rust tests.
---

# Rust Workspace Defaults

## Rules

- Lints: `[workspace.lints]`; members inherit via `[lints] workspace = true`.
  Clippy `all` + `pedantic` at `warn`; CI: `-D warnings`. Per-crate overrides marked `// LINT(crate): reason`.
- Dependencies: all semver ranges in `[workspace.dependencies]`; members use `{ workspace = true }`.
  Don't pin patch-level without a known breakage (link it). Bump once per workspace.
- Dev dependencies: in the crate that uses them. `tests-common` lib only when multiple crates share
  elaborate fixtures. Automation deps in CI/toolchain files, not `[dev-dependencies]`.
- Test layers: unit + integration on default profile (unlimited parallelism); E2E serial under
  `[profile.e2e]`. Use `cargo test -p <crate>` when the workspace suite is red elsewhere.
- Shared DTOs: dedicated crate (e.g. `contracts-core`); don't spread feature flags across DTO boundaries.

## Feature-gated dev surface

- Dev/testing/debug surface: default-off Cargo feature (`#[cfg(feature = "…")]`), not a runtime flag.
- Gate propagates: edge binary declares it, app crate enables it, leaf crates compile only when enabled.
- Release binaries build with the feature off -- code is absent at compile time.
