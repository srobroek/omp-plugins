---
name: rust-ci
description: When authoring Rust GitHub Actions CI, rust-cache keys, required-check gates, or supply-chain attestation.
globs: ["**/*.rs", "**/Cargo.toml", "**/.github/workflows/*"]
---

# Rust CI Defaults (GitHub Actions)

## Caching & speed

- Cache with `Swatinem/rust-cache@v2`: per-OS `shared-key`, `cache-on-failure`.
- Set `CARGO_INCREMENTAL: 0`.
- Use toolchain ≥1.90; set `linker = "rust-lld.exe"` for Windows in
  `.cargo/config.toml` (per-target -- NOT via `RUSTFLAGS`, invalidates rust-cache key).
- Add `mold` (Linux) or `sccache` only when measurements show compile/link still
  dominates. With `sccache`, use an S3/GCS backend -- the GitHub Actions cache
  backend fights `rust-cache` for the 10 GB limit (verify with `sccache --show-stats`).

## Structure

- Filter paths with `dorny/paths-filter` feeding job `if:` conditions. Never put
  `paths:` on a job that is a required check -- skipped required checks deadlock.
- Make ONE `ci-gate` job the sole required status: `if: always()`, needs all
  jobs, `re-actors/alls-green` + `allowed-skips`.
- `fail-fast: false` on the OS matrix; `cancel-in-progress: true` on CI only
  (omit on release workflows mid-upload).

## Supply chain

- SHA-pin third-party actions (e.g. `pinact`).
- Attest released binaries with `actions/attest-build-provenance`
  (needs `id-token: write`, `attestations: write`).
