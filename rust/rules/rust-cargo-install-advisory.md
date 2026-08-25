---
name: rust-cargo-install-advisory
description: cargo install compiles the tool from source; in CI that is a full uncached build before your build starts.
condition: ["\\bcargo\\s+install\\b(?![^\\n]*--help)"]
scope: "tool:bash, tool:edit(**/.github/workflows/*), tool:write(**/.github/workflows/*)"
interruptMode: never
---

`cargo install` builds the tool from source. In CI that is a full compile on
every run, before your own build starts, and `Swatinem/rust-cache` does not
cover it.

CI: install a prebuilt binary. `taiki-e/install-action` covers the common tools
(cargo-nextest, cargo-llvm-cov, cargo-deny, cargo-machete, cargo-audit);
`cargo binstall` covers the rest. Both download a release artifact.

Locally: `cargo binstall <tool>` first. Fall back to
`cargo install --locked <tool>` only when the crate publishes no prebuilt
artifact.
