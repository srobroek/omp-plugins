# Rust stack

Asset set: `skill://project-setup/assets/lang/rust/`

## Asked

| Question | Default | Notes |
|---|---|---|
| Crate kind: `lib` or `bin` | `lib` | `lib` keeps the `Cargo.lock` entry in `.gitignore.d/rust.template`; `bin` deletes it so builds reproduce. Where `src/` already exists, read it from `src/main.rs` versus `src/lib.rs` rather than asking |
| Edition | what `cargo init` wrote | Ask only for a workspace, whose root pins `edition.workspace` before cargo runs. Otherwise the installed toolchain's own current edition is the answer, and cargo is the detection |
| Latest-stable Rust and cargo-tool versions | exact values accepted during setup | Fills `@@RUST_VERSION@@`, `@@CARGO_NEXTEST_VERSION@@`, `@@CARGO_DENY_VERSION@@`, `@@CARGO_MACHETE_VERSION@@`, and `@@CARGO_LLVM_COV_VERSION@@`. The four cargo tokens are read twice: by `.mise/conf.d/rust.toml` locally and by the CI setup action |

## Derived

`@@SPDX_ID@@` in `deny.toml.template` is the licence identifier already settled in the
repository and hosting topic. It is not a second question.

## Fixed

| Concern | Tool |
|---|---|
| Toolchain | stable, edition 2024 for a fresh crate |
| Formatting | rustfmt |
| Linting | clippy |
| Advisories, licences, bans, sources | cargo-deny |
| Unused dependencies | cargo-machete |
| Tests | cargo-nextest |
| Coverage | cargo-llvm-cov |

`deny.toml`'s licence allowlist is a gate, not a suggestion: a dependency carrying
anything outside it fails the build. Widening the list to silence a failure is the
decision the list exists to force.

## The licence key cargo does not write

`cargo init` writes no `license` key, and `cargo deny check licenses` then fails against
the crate itself. Write the SPDX identifier into `Cargo.toml` as part of applying this
set, matching the `LICENSE` file.

## The cargo tools CI installs

A GitHub runner has no mise and no cargo tool beyond cargo itself, so `setup-rust` installs
all four at the exact accepted versions before any caller invokes them: cargo-machete and
cargo-deny for the lint workflow, cargo-nextest for the test workflow, cargo-llvm-cov for
coverage. One list in the action stays authoritative rather than a version per workflow.

It installs them through `taiki-e/install-action`, which downloads the checksummed release
binary for the version named. `cargo install` would compile all four from source on every
runner, and without an explicit `--version` it is the floating install these tokens exist
to remove. `rust-cache` runs with `cache-bin: false` for the same reason: that cache is
keyed on the lockfile, which does not name a tool version, so caching `${CARGO_HOME}/bin`
would keep serving a binary from before a token moved.

## Apply order

1. `cargo init` in the destination, `--lib` or `--bin` per the crate kind.
2. Write `license = "<spdx>"` into `Cargo.toml`, and `edition` when a workspace pinned
   one.
3. Copy the asset set, resolving `@@SPDX_ID@@`, the Rust and cargo-tool version tokens, and the crate-kind block.

In a monorepo, `cargo init` runs AFTER the workspace root exists. Run it first and
`cargo init .` writes a `[package]` root, the workspace manifest is then left alone
because one is already there, no `[workspace]` section is written, and the repository
silently is not a workspace. A single package keeps generator-first.

## Files

| Asset | Destination | Class |
|---|---|---|
| `rust-toolchain.toml.template` | `rust-toolchain.toml` | CREATE |
| `rustfmt.toml` | `rustfmt.toml` | CREATE |
| `clippy.toml` | `clippy.toml` | CREATE |
| `deny.toml.template` | `deny.toml` | CREATE |
| `.gitignore.d/rust.template` | `.gitignore.d/rust` | CREATE |
| `.just.d/rust.just` | `.just.d/rust.just` | CREATE |
| `.pre-commit.d/rust.yaml` | `.pre-commit.d/rust.yaml` | CREATE |
| `.mise/conf.d/rust.toml.template` | `.mise/conf.d/rust.toml` | CREATE |
| `.github/actions/setup-rust/action.yml.template` | `.github/actions/setup-rust/action.yml` | CREATE |
| `.github/quality.d/rust.yml` | same path | CREATE |
| `.github/security.d/rust.yml` | same path | CREATE |
| `.github/workflows/wc-lint-rust.yml` | same path | CREATE |
| `.github/workflows/wc-test-rust.yml.template` | `.github/workflows/wc-test-rust.yml` | CREATE |
| `.gitlab/ci/rust.yml` | same path | CREATE on a GitLab forge, SKIP otherwise |

`rust-toolchain.toml` is the marker file that tells the gitignore fold and the steering
generator a Rust layer is present.

## Recipes it adds

`rust`, `rust-fmt`, `rust-lint`, `rust-test`, `rust-deny`, `rust-machete`, `rust-cov`,
`rust-install`.
