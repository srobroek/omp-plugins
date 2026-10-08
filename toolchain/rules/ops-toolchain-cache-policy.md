---
name: ops-toolchain-cache-policy
description: When configuring or using toolchain download/compiler caches, worktree build output, or cache root and size knobs.
---

# Toolchain Cache Policy

Shared, bounded download and compiler caches across worktrees and clones. Repository outputs remain repository-scoped or worktree-local.

## Shared caches

Keep these families on a shared machine-level cache root (override with `DEVELOPMENT_CACHE_HOME`, fallback `~/.cache/development`): sccache, uv/pip, Go build/modules, npm/pnpm/Bun/Deno, pre-commit/Ruff, golangci-lint, Gradle, NuGet, Trivy, and Restic.

MUST Maven keeps its native user-level `~/.m2/repository`; no portable directory-only environment variable exists across supported Maven versions.
MUST Cargo final/link output is absent from this policy. Worktrunk creates one absolute `dirname(git-common-dir)/target` per repository. Redirecting it into a machine-global directory is refused by `rule://ops-no-global-cargo-target`.

## Bounded, not just shared

MUST A shared cache still grows unbounded without eviction -- that is the trap that fills disks despite sharing. `SCCACHE_CACHE_SIZE` caps sccache, which evicts its least recently used entries past the cap. Under disk pressure, evict regenerable sccache and Go build-cache output first.

NOT Evict module/package DOWNLOAD stores (pnpm store, go-modules, uv wheels, npm) under pressure. These hold registry artifacts, not regenerable output: deleting them forces every project on the machine to re-download the same bytes and can break a build resolving against those paths. If the user deliberately requests a prune, name the store and its refill cost before running it.

## Worktree output

MUST Regenerable build output (Rust `target/`, `node_modules`, `.venv`, `dist/`, `__pycache__`) is not redirected into a machine-global writable directory. Rust target output is repository-scoped; other mutable output is worktree-local and reclaimable with the checkout.

## Knobs (env)

DEFAULT `DEVELOPMENT_CACHE_HOME` managed root (`~/.cache/development` fallback) · `SCCACHE_CACHE_SIZE` sccache cap (`20G`).

Missing tools or unwritable paths degrade to an advisory; never block a session on cache policy.
