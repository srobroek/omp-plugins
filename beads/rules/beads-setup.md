---
name: beads-setup
description: Initialising beads in a repository and verifying the install.
---

# Beads Setup

MUST Let the `bd` CLI own initialization and generated integration: bootstrap
with `bd init --init-if-missing --skip-hooks`, then verify with `bd where` and
`bd hooks list`. Omitting `--skip-hooks` draws one advisory from
`bd-init-advisory`; nothing is blocked because the flag is contextual.

NOT Use a Dolt server flag as the remedy for worktrees or copied checkouts. The
session harness owns the database pin; load `rule://beads-storage-mode` only
when diagnosing storage layout, choosing embedded versus server mode, or
migrating an existing store.

GOTCHA `bd init` derives a Dolt remote from `git remote origin`. Where that
database already exists it fails with `can't create database <prefix>; database
exists`, leaving `.beads` without `config.yaml`.
MUST Use `bd hooks install --beads` only when the active project chose the
product Git-hook bundle.
DEFAULT Project setup follows the repository's Beads version; global setup is
for repositories that do not install project integration, not redundancy.
NOT Use `bd preflight` as an application quality gate. Beads hard-codes checks
for its own repository; use repository-owned quality commands.
