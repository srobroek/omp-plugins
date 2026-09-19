---
name: beads-setup
description: Initialize Beads in a repository and verify the install.
---

# Beads Setup

MUST initialize the embedded store with the Beads CLI:

    bd init --init-if-missing --skip-hooks

Then verify that it has `bd where` and `bd dolt status`. The init advisory explains why `--skip-hooks` matters. It never blocks the command.

MUST use embedded Dolt. The embedded write lock serializes mutations across Worktrunk-linked checkouts. There is no server-backed storage mode or shared-server metadata to configure.

MUST run `bd hooks install --beads` only when the project owns the Git-hook
bundle.

Projects without their own integration may use global setup.

NOT use `bd preflight` as a project quality gate. It checks Beads itself, not
the repository's quality contract.
