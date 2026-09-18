---
name: beads-setup
description: Initialising beads in a repository and verifying the install.
---

# Beads Setup

MUST Let the bd CLI own initialization: use bd init --init-if-missing --skip-hooks, then verify with bd where and bd dolt status. Omitting --skip-hooks draws one advisory from bd-init-advisory; nothing is blocked.
MUST Create every new store with embedded Dolt. Embedded storage is the sole supported topology for this plugin, and bd-embedded-write-lock serializes mutations across linked worktrees and isolated clones.

GOTCHA `bd init` derives a Dolt remote from `git remote origin`. Where that
database already exists it fails with `can't create database <prefix>; database
exists`, leaving `.beads` without `config.yaml`.
MUST Use `bd hooks install --beads` only when the active project chose the
product Git-hook bundle.
DEFAULT Project setup follows the repository's Beads version; global setup is
for repositories that do not install project integration, not redundancy.
NOT Use `bd preflight` as an application quality gate. Beads hard-codes checks
for its own repository; use repository-owned quality commands.
