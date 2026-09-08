# beads

Track work with the [beads](https://github.com/steveyegge/beads) issue tracker (`bd`). Its dependency graph persists across processes and crashes.

Install this plugin in a repository with `.beads/`, or export an absolute `BEADS_DIR` pointing to its shared store.

## Skills

| Skill | Use when |
|---|---|
| `build-formula` | Authoring a bd formula, deciding whether work should be a formula, or debugging one that pours the wrong DAG. |
| `adr` | Recording an architecture decision as a decision bead, superseding one, or acting on `bd lint` findings. |

## Rules

Read rules through `rule://<name>`.

| Rule | Covers |
|---|---|
| `beads-core` | Claims, fields, routing, dependencies, synchronization, JSONL fallback, and database maintenance. |
| `beads-setup` | Initialization and install verification. |
| `beads-lifecycle` | Status transitions and gate beads. |
| `beads-carriers` | Comments, decision beads, wisps, artifacts, and which one is authoritative. |
| `beads-composition` | Issue, epic, formula, molecule, bond, wisp. |
| `beads-coordination` | Swarms, merge slots, and passing a bead id at spawn so the worker claims it. |
| `beads-orchestration-doctrine` | Claim-as-contract doctrine for orchestration workflows. |
| `beads-audit` | Explicit `bd audit record` entries for semantic events. |
| `beads-github-mirror` | Mirroring beads out to GitHub issues. |
| `beads-adr` | Architecture decisions as decision beads. |
| `beads-gate-close` | Resolve gate beads rather than closing them (TTSR, plus the `bd-close-gate` extension). |

## Sync and session boundaries

The rule bodies define sync policy through `bd config`: Dolt-first, one detached push per session, with JSONL-over-git as fallback.

The `session-beads-lifecycle` extension handles session boundaries, not Claude or Codex session-event hooks. It reports unresolved gates and the previous session's detached-push verdict at start, and held claims at close.

Persistent knowledge belongs to builtin learn/retain/recall/reflect. This plugin does not replay beads memories at startup or compaction and leaves existing stored memories untouched.

## Extensions

- `bd-close-gate`: blocks a `bash` call that runs `bd close` on a gate bead.
  It resolves literal command-line ids through `bd show --json`.
  It uses the command's own `-C`/`--db` and the call's cwd to query the same database.
  Variable ids, an id-less `bd close`, and an unreachable database all allow the call.
  It accepts bare and enveloped JSON responses.
  Malformed responses produce an uncertainty advisory, not proof that closure is safe.
- `bd-actor-gate`: blocks a claim made without `BEADS_ACTOR`, and advises on other mutating `bd` commands that lack it.
  It inspects literal command chains and global flags.
  An empty inline actor overrides the inherited actor.
  These guards do not interpret shell expansions or functions.
- `bd-init-advisory`: advises once per session when a real `bd init` omits `--skip-hooks`.
  It reads argv at command position, ignoring mentions in `echo`, `rg`, `git log --grep`, or `man bd init`.
  It blocks nothing: whether the flag is appropriate depends on repository state that the token stream cannot see.
  The advisory also asks you to export `BEADS_DIR` to the run's `.beads` directory.
  Worktrees and copied checkouts can then reach one database.
  The advisory does not block `bd init --init-if-missing --skip-hooks`.
- `session-beads-lifecycle`: reports unresolved gates and the previous session's detached-push verdict at start, and held claims at close.
  Assigned blocked and deferred work remains a held claim.
  Earlier commands in a failed chain may still have mutated work.
  Failed claim reads produce an uncertainty advisory.
  Startup subprocesses share an eight-second deadline.
  Actual session identity separates notices and mutation-attempt tracking.
  Each session start resets only that session, even outside a beads workspace.
- `dolt-server-lifecycle`: reports once when a beads repository uses the embedded backend.
  With `BEADS_STOP_SERVER_ON_EXIT=1`, it also attempts to stop that project's server at session end.
  The stop subprocess has a 1.2-second timeout.
  A timeout leaves server state unverified.

Both lifecycle extensions and the unreported-failure advisory honor `BEADS_DIR`; they do not copy the store.

## Tools

The plugin's extension modules register `bd_formula_check`.

`bd_formula_check` rejects unrecognized zero-step output and malformed dependency data.

Deep checking creates persistent state. On failure, the tool reports any recovered root and leaves recovery to the caller. It never deletes the molecule.
