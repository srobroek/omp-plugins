---
name: rust-quality
description: Use to run Rust format, lint, and test checks with the project toolchain.
---

# Rust Quality

Use the `rust_quality` tool (`mode: "check" | "fix"`, optional `path`). Check runs cargo fmt --check, cargo clippy --all-targets --all-features -- -D warnings, then cargo test. Fix runs cargo fmt only. Missing cargo is skipped.

Read failures as the project's actual toolchain output; do not invent extra linters.
