---
name: toolchain-languages
description: When picking per-language libraries or test/lint tools that the language itself does not imply.
---

# Per-Language Library And Tool Defaults

Picks that a project cannot infer from the language itself. Structural and
failure-mode conventions live in the language plugins.

## Rust

- `thiserror` for libraries, `anyhow` for binaries, `clap` for CLIs.
- `rustfmt` for formatting; `clippy` with `-D warnings` in CI.
- `cargo nextest run` for tests (per-test isolation) plus `cargo test --doc`.
- Coverage: `cargo llvm-cov nextest --lcov`.
- Dependency gate: `cargo deny check` (advisories, bans, licenses, sources).
- Install dev/CI tools with `taiki-e/install-action`, falling back to
  `cargo binstall`. `cargo install` in CI compiles from source every run.

## TypeScript

- Zod at runtime boundaries; OpenAPI for HTTP contracts.
- Bun where no legacy package-manager constraint exists; pnpm for existing
  monorepos standardized on it.
- Vitest for tests unless the stack already standardizes on another runner.

## Python

- FastAPI with Pydantic for APIs; Litestar when the project needs stronger
  application structure.
- Ruff for linting and formatting, pytest for tests, pyright for type checking.

## Go

- Standard library first.
- `urfave/cli` for CLIs when basic flag parsing is not enough.
- `koanf` for layered configuration.
