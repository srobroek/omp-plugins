---
name: rust-quality
description: Use to run Rust format, lint, and test checks with the project toolchain.
---

# Rust Quality

Use the `rust_quality` tool (`mode: "check" | "fix"`, optional `path`). Check runs cargo fmt --check, cargo clippy --all-targets --all-features -- -D warnings, then cargo test. Fix runs cargo fmt only. Missing cargo is skipped.
Missing projects or cargo make the report incomplete (`ok: false, complete: false`). Skipped steps are not PASS.

Read failures as the project's actual toolchain output; do not invent extra linters.

When debugging a Tauri app through an MCP bridge, load
`skill://rust-quality/references/rust-tauri-mcp-bridge.md` and keep the bridge
and `withGlobalTauri` dev-only.
