---
name: beads-setup
description: Initialising beads in a repository and verifying the install.
globs: ["**/.beads/**"]
---

# Beads Setup

MUST Let the bd CLI own initialization and generated integration: bootstrap
  with `bd init --init-if-missing --skip-hooks`, then verify with
  `bd where` and `bd hooks list`.
GOTCHA Plain `bd init` repoints `core.hooksPath` at `.beads/hooks` and copies
  the hooks it displaces into it: 18 binaries, 349 MB, where the displaced path
  is a corporate hook bundle. On arm64 macOS the copies are not executable, so
  every later commit in that repository fails with
  `cannot execute binary file`. Under `--skip-hooks`, `core.hooksPath` keeps its
  value and no hook is copied.
GOTCHA `bd init` derives a Dolt remote from `git remote origin` on its own.
  Where that database already exists it fails with `can't create database
  <prefix>; database exists`, leaving `.beads` without its `config.yaml`.
MUST Use `bd hooks install --beads` only when the active project chose the
  product Git-hook bundle.
DEFAULT Project setup follows the repository's Beads version; global setup is
  for repositories that do not install project integration, not redundancy.
NOT `bd preflight` as an application quality gate -- Beads 1.1.0 hard-codes
  checks for the Beads Go repository; use repository-owned quality commands.
