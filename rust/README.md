# rust

Rust crate, workspace, and quality conventions for OMP.

## Skills

- `rust-quality` — cargo fmt, clippy, and test checks (`skill://rust-quality/scripts/check.sh`, `skill://rust-quality/scripts/fix.sh`).

## Agents

None.

## Rules


- `rust-crate-boundaries` — crate splits, facades, adapters
- `rust-domain-modeling` — thiserror, UUID v5, serde newtypes
- `rust-contract-boundary` — generated bindings and wire casing
- `rust-safe-mutation` — plan/approve/apply and CAS
- `rust-ci` — rust-cache, ci-gate, attestation
- `rust-persistence` — sqlx, migrations, transactional CAS
- `rust-workspace` — workspace lints and layered tests
- `rust-errors` — wire error-code registry and audit
- `rust-tauri` — Tauri v2 bundles, updater, WebDriver
- `rust-tauri-mcp-bridge` — driving a running Tauri app over the MCP bridge
