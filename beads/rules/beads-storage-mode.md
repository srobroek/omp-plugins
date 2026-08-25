---
name: beads-storage-mode
description: "Storage backend choice and its coordination consequences: embedded is single-writer and per-checkout, server mode survives a filesystem copy, and migrating between them is a backup and restore rather than a flag. Read before enabling isolation or worktrees against a beads repo."
---

# Beads storage mode

Every fact below was measured against bd 1.1.2 and dolt 2.3.1.

## The two modes

| | Embedded (default) | Server |
| --- | --- | --- |
| Init | `bd init` | `bd init --server`, or `--shared-server` |
| Data | `.beads/embeddeddolt/` | `.beads/dolt/`, or `~/.beads/shared-server/` |
| Writers | single, file locking enforced | many, concurrent |
| Resolved by | walking up from the working directory | host and port |
| Survives a copy of the checkout | no, the copy forks | yes, the copy reaches the server |

MUST Decide isolation from the resolution mechanism:

- Embedded resolves a PATH, so a copied checkout resolves a second database.
- Server mode resolves a HOST AND PORT, which copying cannot change.

## What embedded costs under isolation

GOTCHA A plain `cp -R` of an embedded `.beads` yields a working, independent
  database. Measured on a 54-bead project, the copy:

- read all 54 beads,
- accepted `bd create`,
- accepted `bd update --claim`,
- reached the original in none of those cases.

MUST Assume that copy-based isolation splits the run. Nothing errors, and nothing
  locks. Claims stop excluding each other:

- comments, statuses and closures never reach the intended run,
- two agents can hold one bead, each believing it won.

DEFAULT Where server mode is unavailable, aim every call at the run's checkout
  with `bd -C <run repo>`. Two verbs survive concurrent processes with exactly one
  winner, `bd update --claim` and `bd ready --claim`. The loser sees an empty
  queue, or `already claimed by <actor>`.

## Choose a server layout

DEFAULT Prefer a per-project server (`bd init --server`):

- its blast radius is one project,
- its lifecycle is manageable,
- `.beads/` carries its own `dolt-server.{pid,port,lock,log}`, so the repository
  owns a discoverable, disposable server.

DEFAULT Reach for `--shared-server` when one machine hosts many projects, and N
  idle processes are the objection. It gives one server, one fixed port, and one
  database per project. `beads_global` then holds state no project owns.

GOTCHA The shared server carries a failure class the per-project layout does not.
  Beads scopes backup export and restore by prefix, specifically to stop data
  leaking between projects.

GOTCHA A copy of a per-project repo still finds the same server:

- port resolution reads the port FILE before config or metadata,
- that file sits inside `.beads`, so it travels with the copy.

The help text says the port derives from the project path. A copy at a new path
still resolves the same port.

## Server mode is persisted in two places

MUST Read both carriers before concluding a project is not server-backed:

| Init | `config.yaml` | `metadata.json` |
| --- | --- | --- |
| `bd init --shared-server` | `dolt.shared-server: true` | `dolt_mode: "server"` |
| `bd init --server` | nothing | `dolt_mode: "server"` |

GOTCHA The config key is FLAT (`dolt.shared-server: true`), not nested under a
  `dolt:` block.

NOT Setting `BEADS_DOLT_SHARED_SERVER=1` alone to switch modes. With
  `metadata.json` still pinning `embedded`, bd announces the shared server and
  then fails with `database "<name>" not found on Dolt server`. The server holds a
  different data directory than the one the embedded engine wrote.

## Migrate an existing project

MUST Migrate by backup and restore into a FRESH project. Never re-run init in
  place: bd refuses `bd init` over existing data on purpose.

```bash
bd backup init /path/to/backup && bd backup sync   # in the existing project
bd init --server --skip-hooks                      # in a FRESH checkout
bd backup restore --force /path/to/backup
```

DEFAULT Override that refusal with the `--destroy-token` form. See
  `bd help init-safety`.

DEFAULT Expect the target to start empty until the restore runs. Server mode reads
  a different data directory than the one embedded wrote. Verified end to end on a
  real 6.8 MB project: 54 beads before, 54 after.

GOTCHA `bd init` also installs harness integration:

- `AGENTS.md` and `CLAUDE.md`,
- `.agents/` and `.codex/`,
- four added lines in `.gitignore`.

Review that before committing, in a repository that deliberately carries none of
it.

## Lifecycle

| | Per-project | Shared |
| --- | --- | --- |
| `bd dolt stop` | process really exits | reports success, keeps running |
| Safe to stop | yes, it flushes first | no, other projects may hold it |

DEFAULT Leave auto-start on, which is the default. Both layouts start on demand
  without `bd dolt start`. An isolated agent cannot reliably start a server, so
  with auto-start off every call fails until something else starts one.

DEFAULT Expect no idle timeout, and no config key for one. Beads removed its idle
  monitor along with the daemon infrastructure. A started server runs until
  something stops it, or until the machine restarts.

DEFAULT Stop a per-project server freely. `bd dolt stop` reports `Flushed working
  set for N database(s) before server stop`, the process exits, and the next read
  auto-starts a fresh one. Losing the process costs a restart, not data.

GOTCHA Do not trust the stop message on the shared server. Verify with the pid
  file, or `bd dolt status`.

DEFAULT Where an orchestrator or systemd owns the process, set
  `dolt.auto-start: false`. `bd dolt status` then probes the endpoint and reports
  `running (external)`, rather than looking for a pid file.
