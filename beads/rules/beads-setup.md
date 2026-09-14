---
name: beads-setup
description: Initialising beads in a repository and verifying the install.
---

# Beads Setup

MUST Let the `bd` CLI own initialization and generated integration: bootstrap
with `bd init --shared-server --init-if-missing --skip-hooks`, then verify with
`bd where` and `bd dolt status` (`Mode: shared server`). Omitting `--skip-hooks`
draws one advisory from `bd-init-advisory`; nothing is blocked because the flag
is contextual.

MUST Create every new store on the shared Dolt server. `bd-init-server-gate`
refuses a `bd init` that carries neither `--shared-server` nor `--server` unless
`BEADS_DOLT_SHARED_SERVER=true` is in the environment `bd` inherits: OMP's
isolated subagents fork an embedded store with every clone. The gate also refuses
an init whose database name (the `--prefix`, else the directory basename) already
exists on the shared server and is not this checkout's own; pass another
`--prefix`. Load `rule://beads-storage-mode` to migrate an existing embedded store.

GOTCHA `bd init` derives a Dolt remote from `git remote origin`. Where that
database already exists it fails with `can't create database <prefix>; database
exists`, leaving `.beads` without `config.yaml`.
MUST Use `bd hooks install --beads` only when the active project chose the
product Git-hook bundle.
DEFAULT Project setup follows the repository's Beads version; global setup is
for repositories that do not install project integration, not redundancy.
NOT Use `bd preflight` as an application quality gate. Beads hard-codes checks
for its own repository; use repository-owned quality commands.
