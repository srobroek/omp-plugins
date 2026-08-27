---
name: beads-storage-mode
description: "Storage backend choice and its coordination consequences: embedded resolves a path, a copied checkout forks the database, and an absolute BEADS_DIR is the pin every checkout shape needs. Read before enabling isolation or worktrees against a beads repo."
---

# Beads storage mode

These facts come from measurements against bd 1.1.2 and dolt 2.3.1.

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

## Pin the run's database first

MUST Export `BEADS_DIR` as the absolute path of the run's `.beads`, wherever
  the run starts. Child
  processes inherit it. That export is the remedy that works on an existing
  embedded project.

GOTCHA Without the pin, bd walks up from the working directory. Measured: from a
  directory that holds no `.beads/`, a pinned `bd list` returned the run's
  beads, and the same read unpinned reported `No active beads workspace found`.
  Two concurrent writers from different working directories both landed theirs
  in one embedded store when a parent set `BEADS_DIR`.

MUST Pin every checkout shape, with no exemption. A worktree, a clone and a copy
  all get the same export, so nobody has to remember which kind they are in.

FACT A linked git worktree resolves the primary checkout's database unaided: five
  live worktrees, none holding `.beads/`, every one reading its beads through
  `bd where`. That is why the pin is cheap there, and not a reason to skip it.
  Skipping depends on bd's resolution behavior and on the worktree holding no
  `.beads/`, while the pin depends on neither.

NOT A per-call pin (`bd -C <repo>`). It has to be right on every call, nothing
  enforces it, and a parent sets `BEADS_DIR` once. `srobroek/omp-orchestrate`
  retired that pin for that reason.

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

DEFAULT Two verbs survive concurrent processes with exactly one winner,
  `bd update --claim` and `bd ready --claim`. The loser sees an empty queue, or
  `already claimed by <actor>`. That holds only when every process uses one
  store.

## Server mode is not the first remedy

NOT `bd init --server` as the default answer to a copied checkout. Server mode
  survives a copy because it resolves a host and port. It also buys a lifecycle
  keyed on `.beads/dolt-server.pid`. bd answers "is a server running?" from that
  file rather than from the port. Any tool that removes the file starts a rival.
  Measured: nine consecutive `database is locked by another dolt process`
  refusals in one log, and 29 `dolt sql-server` processes on one machine, of
  which 23 served directories that no longer existed.

GOTCHA A container in its own network namespace cannot reach a loopback-bound
  Dolt server at any address. Embedded Dolt sync then fails under that network.

DEFAULT Keep an existing embedded project. Pin `BEADS_DIR`. Reach for server
  mode only when many writers on one machine must share a store without
  inheriting an environment, and something outside bd owns the process.

DEFAULT Prefer a per-project server (`bd init --server`) over `--shared-server`
  when you do take that path:

- its blast radius is one project,
- `.beads/` carries its own `dolt-server.{pid,port,lock,log}`.

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
  then fails with `database "<name>" not found on Dolt server`. The server holds
  a different data directory than the one the embedded engine wrote.

## Migrate an existing project

MUST Treat a mode switch as an export, a re-init and a restore, not a flag. The
  prefix lives in the database, not in the repository, so supply `--prefix` by
  hand. Never re-run init in place: bd refuses `bd init` over existing data on
  purpose.

```bash
bd backup init /path/to/backup && bd backup sync   # in the existing project
bd init --server --skip-hooks --prefix <prefix>    # in a FRESH checkout
bd backup restore --force /path/to/backup
```

DEFAULT Override that refusal with the `--destroy-token` form. See
  `bd help init-safety`.

DEFAULT Expect the target to start empty until the restore runs. Server mode
  reads a different data directory than the one embedded wrote.

GOTCHA `bd init` also installs harness integration:

- `AGENTS.md` and `CLAUDE.md`,
- `.agents/` and `.codex/`,
- four added lines in `.gitignore`.

In a repository that deliberately carries none of it, review that before
committing.

## Lifecycle

| | Per-project | Shared |
| --- | --- | --- |
| `bd dolt stop` | process really exits | reports success, keeps running |
| Safe to stop | yes, it flushes first | no, other projects may hold it |

DEFAULT Leave auto-start on, which is the default. Both layouts start on demand
  without `bd dolt start`. An isolated agent cannot reliably start a server, so
  with auto-start off every call fails until something else starts one.

DEFAULT A started server runs until something stops it, or until the machine
  restarts. Beads removed its idle monitor along with the daemon infrastructure,
  and the config surface exposes no key to reinstate one.

DEFAULT Stop a per-project server freely. `bd dolt stop` reports `Flushed working
  set for N database(s) before server stop`, the process exits, and the next read
  auto-starts a fresh one. Losing the process costs a restart, not data.

GOTCHA Do not trust the stop message on the shared server. Verify with the pid
  file, or `bd dolt status`.

DEFAULT Where an orchestrator or systemd owns the process, set
  `dolt.auto-start: false`. That switches what `bd dolt status` reports:

| Condition | Report |
| --- | --- |
| auto-start on | `running`, with a PID |
| auto-start off, server up | `running (external)`, with host, port and database |
| auto-start off, server down | `not reachable (external)` |

GOTCHA With auto-start off, `bd dolt status` reads the endpoint, not the pid file.
  Deleting `dolt-server.pid` under a live server changed nothing: it still
  reported `running (external)`. So the report survives a lost pid file, and a
  stale pid file cannot fake a server that stopped.
