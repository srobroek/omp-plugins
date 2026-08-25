---
name: rust-rustflags-linker
description: Selecting a linker through RUSTFLAGS invalidates the rust-cache key; set it per-target in .cargo/config.toml.
condition: ["RUSTFLAGS[^\\n]{0,60}(?:linker|link-arg)"]
scope: "tool:edit(**/.github/workflows/*), tool:write(**/.github/workflows/*)"
interruptMode: never
---
`Swatinem/rust-cache` hashes `RUSTFLAGS` into its cache key, so adding a linker
flag there changes the key for every job that inherits the variable. The cache
misses, the whole dependency graph rebuilds, and the run gets slower than it was
before the linker was tuned.

Set the linker per target instead:

```toml
# .cargo/config.toml
[target.x86_64-pc-windows-msvc]
linker = "rust-lld.exe"

[target.x86_64-unknown-linux-gnu]
rustflags = ["-C", "link-arg=-fuse-ld=mold"]
```

A `[target.*]` table applies only where it matches, and it is not part of the
cache key, so the rest of the matrix keeps its cache.

Reach for `mold` or `sccache` only once a measurement shows link time still
dominates. Rest of the CI defaults: `rule://rust-ci`.
