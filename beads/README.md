# Beads

The Beads plugin provides direct `bd` issue tracking with a shared embedded ledger and store-safety controls.

## Steering

`bd prime` is the single source of truth for `bd` commands and the default
workflow, and this package does not restate it. The two rules carry only the
preferences `bd prime` leaves out.

`beads-ledger` requires batched creation through a single `bd create --graph`
call, records that plan schema and its two silent traps, and states the
embedded-store write rules. It deliberately overrides `bd prime` where that
briefing recommends fanning `bd create` across parallel subagents, which both
amplifies writes and risks corrupting the Dolt journal.

`beads-evidence` sets the bar for a close reason: the command run, the path
changed, or the test result.

## Store-safety extensions

The package registers `bash-gates` as the dispatcher entrypoint and `session-beads-lifecycle` as the session lifecycle extension. `bash-gates` dispatches exactly two controls:

- `bd-embedded-write-lock` serializes writes to the embedded store and runs mutations through `bd-embedded-write-runner`.
- `bd-actor-gate` requires an actor identity for writes that must be attributable.

The write runner is registered as the package program and must remain available. The session lifecycle extension pins `BEADS_DIR` to the repository's canonical `.beads` store so linked worktrees use one embedded ledger.

## Removed surface

Only the direct `bd` workflow and the store-safety controls remain; the package no longer includes the removed workflow and advisory surface.
