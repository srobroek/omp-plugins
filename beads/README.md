# beads

Track work with the [beads](https://github.com/steveyegge/beads) issue tracker (`bd`). Its dependency graph persists across processes and crashes.

Install this plugin in a repository with `.beads/`; it pins that database for every session. A human who wants a different shared store exports an absolute `BEADS_DIR` before starting omp, and the plugin keeps it.

## Skills

| Skill | Use when |
|---|---|
| `build-formula` | Writing a bd formula, choosing whether to use one, or debugging a formula that pours the wrong DAG. |
| `adr` | Recording an architecture decision as a decision bead, superseding one, or acting on `bd lint` findings. |

## Rules

To read a rule, open its `rule://<name>` address.

| Rule | Covers |
|---|---|
| `beads-core` | Claiming work and managing fields. Routing dependencies and syncing data. Using JSONL as a fallback and maintaining the database. |
| `beads-setup` | Setting up beads. Verifying the install. |
| `beads-lifecycle` | Status transitions and gate beads. |
| `beads-carriers` | Choosing where to keep authoritative records. Using comments or decision beads. Using wisps or artifacts. |
| `beads-composition` | Choosing an issue or epic. Using formulas and molecules. Working with bonds or wisps. |
| `beads-coordination` | Swarms, merge slots, and passing a bead id at spawn so the worker claims it. |
| `beads-orchestration-doctrine` | Claim-as-contract doctrine for orchestration workflows. |
| `beads-audit` | Explicit `bd audit record` entries for semantic events. |
| `beads-github-mirror` | Mirroring beads out to GitHub issues. |
| `beads-adr` | Architecture decisions as decision beads. |
| `beads-gate-close` | Resolve gate beads rather than closing them (TTSR, plus the `bd-close-gate` extension). |

## Sync and session boundaries

The rule bodies define sync policy through `bd config`: Dolt-first, one detached push per session, with JSONL-over-git as fallback.

The `session-beads-lifecycle` extension handles session boundaries rather than session-event hooks for Claude or Codex. At startup, it reports unresolved gates. It also reports whether the previous session's detached push succeeded. At close, it reports held claims.

Use the builtin learn/retain/recall/reflect tools for persistent knowledge. This plugin leaves stored memories untouched. It does not replay beads memories at startup or compaction.

## Extensions

- `bd-close-gate`: blocks a `bash` call that runs `bd close` on a gate bead.
  It resolves literal command-line ids through `bd show --json`.
  It uses the command's own `-C`/`--db` and the call's cwd to query the same database.
  Variable ids, an id-less `bd close`, and an unreachable database all allow the call.
  It accepts bare and enveloped JSON responses.
  Malformed responses produce an uncertainty advisory, not proof that closure is safe.
- `bd-actor-gate`: blocks a claim, or any verb that constructs a bead, made without
  `BEADS_ACTOR` or `BD_ACTOR`. That covers `bd create`, its alias `bd new`, and
  `bd create-form`; blocking the literal verb alone would leave the alias as a
  silent permit.
  An actorless `bd create` silently sets the new bead's `Owner` to the invoking human's git
  identity; there is no `--owner` flag, and `--assignee` sets a different field, so the
  mis-attribution is permanent. It advises on other mutating `bd` commands that lack an actor.
  It inspects literal command chains and global flags.
  These guards do not interpret shell expansions or functions.
- `bd-init-advisory`: advises once per session when a real `bd init` omits `--skip-hooks`.
  It reads argv at command position. It ignores mentions in `echo` or `rg`, as well as `git log --grep` or `man bd init`.
  It blocks nothing: whether the flag is appropriate depends on repository state that the token stream cannot see.

  The advisory also states that the plugin pins `BEADS_DIR` for the session (the
  checkout's `.beads` on every Bash call; a pre-existing export is kept), so no
  export or restart is needed.
  The advisory does not block `bd init --init-if-missing --skip-hooks`.
- `session-beads-lifecycle`: reports unresolved gates at startup, along with whether the previous session's detached push succeeded.
  At close, it reports held claims. Assigned work remains a held claim when blocked or deferred.
  Earlier commands in a failed chain can still change work.
  If it cannot read claims, the extension reports that uncertainty.
  Startup subprocesses share an eight-second deadline.

  The extension uses each session's identity to keep notices and attempts to mutate data separate.
  Each session start resets only that session, even outside a beads workspace.
- `dolt-server-lifecycle`: reports once when a repository for beads uses the embedded backend.
  With `BEADS_STOP_SERVER_ON_EXIT=1`, it also attempts to stop that project's server at session end.
  The stop subprocess has a 1.2-second timeout.
  A timeout leaves server state unverified.

Both lifecycle extensions honor `BEADS_DIR`, as does the advisory for unreported failures. None of them copies the store.

## Tools

The plugin registers `bd_formula_check` through its extension modules. This tool rejects unrecognized zero-step output and malformed dependency data.

Deep checking creates persistent state. If the check fails, the tool reports any root it recovered. The caller must handle recovery. The tool never deletes the molecule.
