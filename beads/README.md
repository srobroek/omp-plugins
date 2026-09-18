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

## Session behavior

The session extension reports unresolved gates at startup. It reports held claims and pending failures at session end.

The embedded write lock covers plugin-managed Beads mutations. It rejects ambiguous command shapes instead of guessing their target.

Read the core rule for the execution contract.
Before initialization, read the setup rule.
Before status changes, read the lifecycle rule.

## Guidance

Claim work first. Keep the task bead open until its commit is ready. Close completed work with a factual reason and its delivery commit.
