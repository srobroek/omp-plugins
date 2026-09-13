---
name: ops-no-global-cargo-target
description: A global Cargo target directory breaks per-repository build isolation; Worktrunk owns one target dir per repository.
condition: ["(?i)(?:^|\\\\n|\\n|[;&|(]\\s*)(?:\\[build\\]\\s*)?target-dir\\s*=", "(?i)(?:^|\\\\n|\\n|[;&|(]\\s*)(?:export\\s+)?CARGO_TARGET_DIR\\s*(?:=|:)"]
scope: "tool:edit(**/.cargo/config.toml), tool:write(**/.cargo/config.toml), tool:edit(**/.github/workflows/*), tool:write(**/.github/workflows/*), tool:edit(**/.{bashrc,zshrc,profile,bash_profile}), tool:write(**/.{bashrc,zshrc,profile,bash_profile})"
interruptMode: never
---

Cargo final and link output is deliberately absent from the shared cache policy. Worktrunk creates one absolute `dirname(git-common-dir)/target` per repository, so every worktree of that repository shares it and no two repositories collide.

`CARGO_TARGET_DIR` or a global `[build].target-dir` redirects every repository into one writable directory. Concurrent builds then fight over fingerprints and lock files, cross-repository artifacts can be reused silently, and deleting a checkout no longer frees its build output.

Compiler caching is the supported way to share work across repositories: sccache on the shared cache root. That is content-addressed, so it is safe to share and safe to evict.

Cache roots, eviction, and environment knobs: `rule://ops-toolchain-cache-policy`.
