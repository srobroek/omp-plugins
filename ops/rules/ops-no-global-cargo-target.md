---
name: ops-no-global-cargo-target
description: A global Cargo target directory breaks per-repository build isolation; Worktrunk owns one target dir per repository.
condition: ["target-dir", "\\bCARGO_TARGET_DIR\\b"]
scope: "tool:edit(**/.cargo/config.toml), tool:write(**/.cargo/config.toml), tool:edit(**/.github/workflows/*), tool:write(**/.github/workflows/*), tool:edit(**/.{bashrc,zshrc,profile,bash_profile}), tool:write(**/.{bashrc,zshrc,profile,bash_profile})"
interruptMode: never
---
Cargo final and link output is deliberately absent from the shared cache policy.
Worktrunk creates one absolute `dirname(git-common-dir)/target` per repository,
so every worktree of that repository shares it and no two repositories collide.

`CARGO_TARGET_DIR` or a global `[build].target-dir` redirects every repository
into one writable directory. Concurrent builds then fight over the same
fingerprint and lock files, a cross-repository name clash silently reuses another
project's artifacts, and reclaiming disk by deleting a checkout no longer frees
its build output.

Compiler caching is the supported way to share work across repositories: sccache
on the shared cache root. That is content-addressed, so it is safe to share and
safe to evict.

Cache roots, eviction, and the env knobs: `rule://ops-toolchain-cache-policy`.
