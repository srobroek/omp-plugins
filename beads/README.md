# Beads

The Beads plugin provides direct `bd` issue tracking with a shared embedded ledger and store-safety controls.

## Steering

`bd prime` is the single source of truth for `bd` commands and the default
workflow, and this package does not restate it. The two rules carry only the
preferences `bd prime` leaves out.

Steering surfaces:
- `beads-ledger` carries batched graph creation, embedded-store safety, metadata, acceptance, and delivery preferences not in `bd prime`.
- `beads-evidence` requires checkable evidence and reviewed closure authority.
- `beads-contention-retry` retries embedded-store contention and failed remote syncs without agent-built wrappers.
- `beads-no-editor` interrupts `bd edit` before it can hang a non-interactive session.
- `beads-preflight` runs read-only, bounded readiness checks before ledger work.

## Store-safety extensions

The package registers `bash-gates` as the dispatcher entrypoint and `session-beads-lifecycle` as the session lifecycle extension. `bash-gates` dispatches exactly two controls:

- `bd-embedded-write-lock` serializes writes to the embedded store and runs mutations through `bd-embedded-write-runner`.
- `bd-actor-gate` requires an actor identity for writes that must be attributable.

The write runner is registered as the package program and must remain available. The session lifecycle extension pins `BEADS_DIR` to the repository's canonical `.beads` store so linked worktrees use one embedded ledger.

## Removed surface

Only the direct `bd` workflow and the store-safety controls remain; the package no longer includes the removed workflow and advisory surface.
