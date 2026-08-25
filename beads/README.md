# beads

Work tracking on the [beads](https://github.com/steveyegge/beads) issue tracker (`bd`): a
dependency-aware DAG that survives across processes and crashes, which no native OMP
surface provides. Background: native background-job rows expire minutes after settling,
and there is no native dependency graph, gate, or merge slot.

Install this plugin in any repository that has a `.beads/` directory.

## Skills

| Skill | Use when |
|---|---|
| `build-formula` | Authoring a bd formula, deciding whether work should be a formula at all, or debugging one that pours the wrong DAG. |
| `adr` | Recording an architecture decision as a decision bead, superseding one, or acting on `bd lint` findings. |

## Rules

through `rule://<name>`.

| Rule | Covers |
|---|---|
| `beads-core` | Claiming, field taxonomy, routing, dependencies, sync authority, JSONL-over-git fallback, database maintenance. |
| `beads-setup` | Initialisation and install verification. |
| `beads-lifecycle` | Status transitions and gate beads. |
| `beads-carriers` | Comments, decision beads, wisps, artifacts, and which one is authoritative. |
| `beads-composition` | Issue, epic, formula, molecule, bond, wisp. |
| `beads-coordination` | Swarms, merge slots, and passing a bead id at spawn so the worker claims it. |
| `beads-orchestration-doctrine` | Claim-as-contract doctrine consumed by orchestration workflows. |
| `beads-audit` | Explicit `bd audit record` entries for semantic events. |
| `beads-github-mirror` | Mirroring beads out to GitHub issues. |
| `beads-adr` | Architecture decisions as decision beads. |
| `beads-gate-close` | A gate bead is resolved, never closed (TTSR, plus the `bd-close-gate` extension). |

## Notes

Sync policy lives in the rule bodies, with `bd config` as the mechanism
(Dolt-first, one detached push per session, JSONL-over-git as fallback).
Claude and Codex session-event hooks did not migrate; the `session-beads-lifecycle`
extension covers the session boundaries instead -- unresolved gates and the previous
session's detached-push verdict at start, held claims at close.

## Extensions

- `bd-close-gate` — blocks a `bash` call that runs `bd close` on a gate bead. It
  resolves the literal ids on the command line through `bd show --json`, replaying
  the command's own `-C`/`--db` and the call's cwd so the same database answers.
  Fails open: variable ids, an id-less `bd close`, and an unreachable database all
  allow the call.
- `bd-actor-gate` — blocks a claim made without `BEADS_ACTOR`, and advises on other
  mutating `bd` commands that lack it.
- `session-beads-lifecycle` — reports at the session boundaries: unresolved gates and
  the previous session's detached-push verdict at start, held claims at close.
- `dolt-server-lifecycle` — reports once when a beads repository is on the embedded
  backend, and optionally stops that project's server at session end.

## Tools

Registered by this plugin's extension modules:

- `bd_formula_check`
