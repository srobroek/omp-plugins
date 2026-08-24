---
name: ops-toolchain-cache-policy
description: When configuring or using toolchain download/compiler caches, worktree build output, or disk-pressure eviction knobs.
---

# Toolchain Cache Policy

Shared, bounded download and compiler caches across worktrees and clones.
Repository outputs remain repository-scoped or worktree-local.

## Shared caches

Keep these families on a shared machine-level cache root (override with
`CACHE_POLICY_ROOT` or `DEVELOPMENT_CACHE_HOME`, fallback
`~/.cache/development`): sccache, uv/pip, Go build/modules, npm/pnpm/Bun/Deno,
pre-commit/Ruff, golangci-lint, Gradle, NuGet, Trivy, and Restic.

MUST Maven keeps its native user-level `~/.m2/repository`; no portable
  directory-only environment variable exists across supported Maven versions.
MUST Cargo final/link output is absent from this policy. Worktrunk creates one
  absolute `dirname(git-common-dir)/target` per repository.
NOT Set `CARGO_TARGET_DIR` or a global Cargo `[build].target-dir`.

## Bounded, not just shared

MUST A shared cache still grows unbounded without eviction -- that is the trap
  that fills disks despite sharing. Under disk pressure, below the free-space
  floor (default 25 GiB, `CACHE_POLICY_FLOOR_GIB`) evict regenerable sccache
  and Go build-cache output, then stop when above the floor.
NOT Evict module/package DOWNLOAD stores (pnpm store, go-modules, uv wheels, npm)
  under pressure. Only report if compiler-cache eviction is insufficient.

## Worktree output

MUST Regenerable build output (Rust `target/`, `node_modules`, `.venv`,
  `dist/`, `__pycache__`) is not redirected into a machine-global writable
  directory. Rust target output is repository-scoped; other mutable output is
  worktree-local and reclaimable with the checkout.

## Knobs (env)

DEFAULT `CACHE_POLICY_FLOOR_GIB` free-space floor (25) · `CACHE_POLICY_ROOT`
  explicit root override · `DEVELOPMENT_CACHE_HOME` managed root
  (`~/.cache/development` fallback) · `CACHE_POLICY_SCCACHE_GIB` sccache cap
  (20) · `CACHE_POLICY_DISABLE` skip entirely.

Missing tools, unwritable paths, or a GC that cannot reach the floor all
degrade to an advisory; never block a session on cache policy.
