---
name: beads-setup
description: Initialize Beads in a repository and verify the install.
---

# Beads Setup

MUST Initialize the embedded store with the Beads CLI:

    bd init --init-if-missing --skip-hooks

Then verify that it has `bd where` and `bd dolt status`. The init advisory explains why `--skip-hooks` matters. It never blocks the command.

MUST Use embedded Dolt as the only supported storage topology. The embedded
write lock serializes mutations across Worktrunk-linked checkouts.

NOTE If the remote database already exists, bd init reports database exists and may leave .beads without config.yaml.
NOTE If the remote database already exists, bd init reports database exists and may leave `.beads` without `config.yaml`.

MUST Run `bd hooks install --beads` only when the project owns the Git-hook
bundle.

Projects without their own integration may use global setup.
Projects without their own integration may use global setup.

NOT Use `bd preflight` as a project quality gate. It checks Beads itself, not
the repository's quality contract.
