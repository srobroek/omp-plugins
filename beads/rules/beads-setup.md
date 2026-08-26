---
name: beads-setup
description: Initialising beads in a repository and verifying the install.
---

# Beads Setup

MUST Let the bd CLI own initialization and generated integration: bootstrap
  with `bd init --init-if-missing --skip-hooks`, then verify with
  `bd where` and `bd hooks list`. A `bd init` that omits `--skip-hooks` draws
  one advisory from the `bd-init-advisory` extension; nothing is blocked,
  because the flag is contextual.
MUST Whatever starts a run export `BEADS_DIR` to that run's `.beads` directory,
  so every child process inherits the pin. That is what makes a worktree or a
  copied checkout read and write the run's database.
GOTCHA Unpinned, a read from a directory with no `.beads/` reports
  `No active beads workspace found`, and a copied checkout can resolve a
  personal database instead. `$HOME/.beads` exists on this machine.
GOTCHA Something must own the pin. A harness that copies a checkout without
  setting `BEADS_DIR` still splits the database. Measured: a copied 54-bead
  database accepted `create` and `--claim` with none of it reaching the original.
NOT A Dolt server flag as the remedy for worktrees or copied checkouts. Pin
  `BEADS_DIR`. Server mode is a different layout with its own lifecycle; see
  rule://beads-storage-mode.

GOTCHA `bd init` derives a Dolt remote from `git remote origin` on its own.
  Where that database already exists it fails with `can't create database
  <prefix>; database exists`, leaving `.beads` without its `config.yaml`.
MUST Use `bd hooks install --beads` only when the active project chose the
  product Git-hook bundle.
DEFAULT Project setup follows the repository's Beads version; global setup is
  for repositories that do not install project integration, not redundancy.
NOT `bd preflight` as an application quality gate -- Beads 1.1.0 hard-codes
  checks for the Beads Go repository; use repository-owned quality commands.
