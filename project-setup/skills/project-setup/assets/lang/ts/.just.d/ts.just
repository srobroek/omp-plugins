# TypeScript recipes, imported by the root justfile.

# Format, lint, type-check, and test
[group('ts')]
ts: ts-fmt ts-lint ts-types ts-test

# Format and organise imports. biome owns this half of the split
[group('ts')]
ts-fmt:
    bunx biome check --write .

# oxlint owns this half of the split: 59 of typescript-eslint's 61 type-aware rules
# against biome's 4 outside nursery.

# Lint
[group('ts')]
ts-lint:
    bunx oxlint

# Type check
[group('ts')]
ts-types:
    bunx tsc --noEmit

# Test
[group('ts')]
ts-test:
    bun test

# Unused files, exports, and dependencies
[group('ts')]
ts-dead:
    bunx knip

# Coverage
[group('ts')]
ts-cov:
    bun test --coverage

# `--frozen-lockfile` fails rather than updating the lockfile, so CI and a developer
# install the same tree. The generator writes no lockfile, so the first setup creates
# it. Two shapes are notes, not failures: no package.json at the root (a rust
# workspace whose ts shell lives in a member directory), and a package-lock.json
# (projen manages its repo with npm, and a bun install would write a second,
# disagreeing lockfile).

# Install the locked dependencies into node_modules
[group('ts')]
ts-install:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -f package.json ]; then
      echo "ts-install: no package.json at the root; members install their own"
      exit 0
    fi
    if [ -f package-lock.json ]; then
      npm ci
    elif [ ! -f bun.lock ] && [ ! -f bun.lockb ]; then
      bun install
    else
      bun install --frozen-lockfile
    fi
