# Beads

Beads records work with the bd CLI. Its graph survives process restarts and crashes.

Install this plugin in a repository with `.beads/`. The plugin pins that repository embedded store for session commands. Calls in another repository remain unpinned.

## Skills

| Skill | Use |
| --- | --- |
| `build-formula` | Author and debug formulas. |
| `adr` | Record architecture decisions. |
| `beads-setup` | Initialize a workspace. |
| `beads-lifecycle` | Manage bead status and gates. |
| `beads-carriers` | Choose authoritative records. |
| `beads-composition` | Choose issues and formulas. |

## Extensions

- `bd-embedded-write-lock` serializes mutations across linked checkouts.
- `bd-actor-gate` requires an actor for mutations.
- `bd-lease-gate` records lease metadata after claims.
- `bd-close-gate` protects close operations.
- `session-beads-lifecycle` reports unresolved claims and failures.
- `pr-bead-link-gate` links pull requests to beads.
- `pr-bead-link-gate` links pull requests to beads. A live ledger requires a Bead, Closes-Bead, or Bead-Id trailer; a regular-file `.beads/RETIRED` marker opts out the nearest ledger. This marker belongs to the gate, not to bd configuration; `No-Bead:` is not accepted.
## Session behavior

The session extension reports unresolved gates at startup. It reports held claims and pending failures at session end.

The embedded write lock covers plugin-managed Beads mutations. It rejects ambiguous command shapes instead of guessing their target.
- `bd-lease-gate`: writes `lease_host` and `lease_pid` metadata after a claim succeeds, so a
  later session can prove a holder gone instead of guessing from staleness.
  It reads the bead ids from `bd`'s own output and stamps them with a separate
  `bd update`, so no command is ever rewritten; when detection misses, the bead
  simply carries no anchors, which the claiming rule treats as unprovable rather
  than dead. The pid is the agent process, not the shell child that exits with
  the command.
- `pr-bead-link-gate`: blocks `gh pr create` and the `github` device's `pr_create` when the
  body names neither a bead nor a truthful `No-Bead:` reason, and only where a `.beads`
  workspace exists. External repositories
  without `.beads` are untouched; their user-facing prose must omit internal linkage.
  It refuses rather than injecting an id, because a body it had to guess at
  outlives the PR. A body built by `--fill`, `--body-file`, or a command
  substitution is not visible to a tool call, so those stay a rule matter.

Read the core rule for the execution contract.
Before initialization, read the setup rule.
Before status changes, read the lifecycle rule.

## Guidance

Claim work first. Keep the task bead open until its commit is ready. Close completed work with a factual reason and its delivery commit. See [Dolt synchronization cadence]rule://beads-dolt-sync-cadence for sync requirements.
