# Beads

The Beads plugin provides direct `bd` issue tracking with a shared embedded ledger and store-safety controls.

## Steering

The `beads-lite` skill documents the direct workflow: run `bd prime`, choose an issue type and priority, add dependencies, label work with `role:<name>`, pull and claim ready work, and close it with evidence.

The `bdlite-ledger` rule makes the ledger the source of truth for work state. The `bdlite-evidence` rule requires checkable evidence on every close.

The store is embedded and lives in the canonical checkout, and linked worktrees share it. The session lifecycle extension pins `BEADS_DIR` to the canonical checkout's `.beads` store; `BEADS_DIR` does not redirect `bd init` away from canonical. No Dolt server may be started. Two concurrent writers corrupt the Dolt journal, so a contended `bd` call is retried rather than worked around.

## Store-safety extensions

The package registers `bash-gates` as the dispatcher entrypoint and `session-beads-lifecycle` as the session lifecycle extension. `bash-gates` dispatches exactly two controls:

- `bd-embedded-write-lock` serializes writes to the embedded store and runs mutations through `bd-embedded-write-runner`.
- `bd-actor-gate` requires an actor identity for writes that must be attributable.

The write runner is registered as the package program and must remain available. The session lifecycle extension pins `BEADS_DIR` to the repository's canonical `.beads` store so linked worktrees use one embedded ledger.

## Removed surface

Only the direct `bd` workflow and the store-safety controls remain; the package no longer includes the removed workflow and advisory surface.
