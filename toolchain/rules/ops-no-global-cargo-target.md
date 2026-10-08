---
name: ops-no-global-cargo-target
description: A global Cargo target directory breaks per-repository build isolation; Worktrunk owns one target dir per repository.
condition: ["(?i)(?:^|\\\\n|\\n|[;&|(])\\s*(?:\\[build\\]\\s*)?target-dir\\s*=\\s*[\"']?(?:[/~]|\\$\\{?(?:HOME|XDG_[A-Z_]+|TMPDIR|DEVELOPMENT_CACHE_HOME|CARGO_HOME)\\b|\\{\\{[^}\\n]*(?:\\.chezmoi\\.(?:home|cache)Dir|\\benv\\.(?:HOME|XDG_[A-Z_]+|TMPDIR|DEVELOPMENT_CACHE_HOME|CARGO_HOME)\\b)|[A-Z]:[\\\\/])", "(?i)(?:^|\\\\n|\\n|[;&|(])\\s*(?:export\\s+)?CARGO_TARGET_DIR\\s*[=:]\\s*[\"']?(?:[/~]|\\$\\{?(?:HOME|XDG_[A-Z_]+|TMPDIR|DEVELOPMENT_CACHE_HOME|CARGO_HOME)\\b|\\{\\{[^}\\n]*(?:\\.chezmoi\\.(?:home|cache)Dir|\\benv\\.(?:HOME|XDG_[A-Z_]+|TMPDIR|DEVELOPMENT_CACHE_HOME|CARGO_HOME)\\b)|[A-Z]:[\\\\/])", "(?i)(?:^|\\\\n|\\n|[;&|(])\\s*set\\s+(?:-{1,2}[a-z]+\\s+)+CARGO_TARGET_DIR\\s+[\"']?(?:[/~]|\\$\\{?(?:HOME|XDG_[A-Z_]+|TMPDIR|DEVELOPMENT_CACHE_HOME|CARGO_HOME)\\b|\\{\\{[^}\\n]*(?:\\.chezmoi\\.(?:home|cache)Dir|\\benv\\.(?:HOME|XDG_[A-Z_]+|TMPDIR|DEVELOPMENT_CACHE_HOME|CARGO_HOME)\\b)|[A-Z]:[\\\\/])"]
scope: "tool:edit(**/.cargo/config.toml), tool:write(**/.cargo/config.toml), tool:edit(**/.github/workflows/*), tool:write(**/.github/workflows/*), tool:edit(**/.{bashrc,zshrc,profile,bash_profile}), tool:write(**/.{bashrc,zshrc,profile,bash_profile}), tool:edit(**/{mise,.mise}*.toml), tool:write(**/{mise,.mise}*.toml), tool:edit(**/mise/config.toml*), tool:write(**/mise/config.toml*), tool:edit(**/mise/conf.d/*.toml*), tool:write(**/mise/conf.d/*.toml*), tool:edit(**/*dot_{bashrc,zshrc,zshenv,zprofile,profile,bash_profile}*), tool:write(**/*dot_{bashrc,zshrc,zshenv,zprofile,profile,bash_profile}*), tool:edit(**/*.fish*), tool:write(**/*.fish*)"
interruptMode: never
---

Cargo final and link output is deliberately absent from the shared cache policy. Worktrunk creates one absolute `dirname(git-common-dir)/target` per repository, so every worktree of that repository shares it and no two repositories collide.

`CARGO_TARGET_DIR` or a global `[build].target-dir` redirects every repository into one writable directory. Concurrent builds then fight over fingerprints and lock files, cross-repository artifacts can be reused silently, and deleting a checkout no longer frees its build output.

Compiler caching is the supported way to share work across repositories: sccache on the shared cache root. That is content-addressed, so it is safe to share and safe to evict.

Cache roots, eviction, and environment knobs: `rule://ops-toolchain-cache-policy`.
