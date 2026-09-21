# Rust recipes, imported by the root justfile.

# Format, lint, and test the rust code
[group('rust')]
rust: rust-fmt rust-lint rust-test

# Format
[group('rust')]
rust-fmt:
    cargo fmt --all

# Clippy with warnings as errors
[group('rust')]
rust-lint:
    cargo clippy --all-targets --all-features -- -D warnings

# Test through nextest
[group('rust')]
rust-test:
    cargo nextest run --all-features

# Supply chain: advisories, licences, bans, sources
[group('rust')]
rust-deny:
    cargo deny check

# Unused dependencies
[group('rust')]
rust-machete:
    cargo machete

# Coverage
[group('rust')]
rust-cov:
    cargo llvm-cov nextest --all-features --lcov --output-path lcov.info

# Fetches into the shared cargo registry cache, so a warm run is 0.55s. `cargo build`
# would also fetch, but this separates a network failure from a compile failure.
# `cargo init` writes no lockfile, so the first setup creates it; every later run
# stays locked, and a stale lockfile is an error instead of a silent re-resolve.

# Fetch the locked dependencies
[group('rust')]
rust-install:
    @test -f Cargo.lock || cargo generate-lockfile
    cargo fetch --locked
