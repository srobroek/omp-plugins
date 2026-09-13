# Beads storage mode

These facts come from Beads and Dolt behavior. Load this reference when choosing
embedded versus server storage, diagnosing copied checkouts, or migrating an
existing database.

## The two modes

| | Embedded (default) | Server |
| --- | --- | --- |
| Init | `bd init` | `bd init --server`, or `--shared-server` |
| Data | `.beads/embeddeddolt/` | `.beads/dolt/`, or `~/.beads/shared-server/` |
| Writers | single, file locking enforced | many, concurrent |
| Resolved by | walking up from the working directory | host and port |
| Survives a copy of the checkout | no, the copy forks | yes, the copy reaches the server |

MUST Decide isolation from the resolution mechanism:

- Embedded resolves a path, so a copied checkout resolves a second database.
- Server mode resolves a host and port, which copying cannot change.

## Embedded isolation

A plain `cp -R` of an embedded `.beads` yields a working, independent database.
It accepts reads, creates, and claims without reaching the original. Assume
copy-based isolation splits the run: comments, statuses, and closures never
reach the intended store, and two agents can each believe they won one claim.

Two verbs provide a single winner only when every process uses one store:
`bd update --claim` and `bd ready --claim`. A loser sees an empty queue or an
already-claimed message.

## Server mode

Server mode survives a copy because it resolves a host and port. It is not the
first remedy for copied checkouts: use the session's database binding first.
Reach for a server when many writers on one machine must share a store without
inheriting an environment and something outside `bd` owns the process.

DEFAULT Prefer a per-project server (`bd init --server`) over
`--shared-server` when the blast radius should be one project. Its `.beads/`
contains its own `dolt-server.{pid,port,lock,log}`. Use `--shared-server` when one
machine hosts many projects and idle processes are the objection; it gives one
server, one fixed port, and one database per project.

The shared server carries a failure class the per-project layout does not:
backup export and restore are scoped by prefix to prevent data leaking between
projects. A copied per-project repository still finds the same server because
port resolution reads the port file before config or metadata, and that file
travels with the copy.

A container in its own network namespace cannot reach a loopback-bound Dolt
server at any address. Embedded Dolt sync then fails under that network.

## Persisted mode

Read both carriers before concluding that a project is not server-backed:

| Init | `config.yaml` | `metadata.json` |
| --- | --- | --- |
| `bd init --shared-server` | `dolt.shared-server: true` | `dolt_mode: "server"` |
| `bd init --server` | nothing | `dolt_mode: "server"` |

The config key is flat (`dolt.shared-server: true`), not nested under a
`dolt:` block. Setting `BEADS_DOLT_SHARED_SERVER=1` alone does not switch modes:
with `metadata.json` still pinning `embedded`, `bd` can announce the shared
server and then fail because the server holds a different data directory.

## Migration

MUST Treat a mode switch as export, re-init, and restore, not as a flag. The
prefix lives in the database, not the repository, so supply `--prefix` by hand.
Never re-run init in place; `bd` refuses over existing data on purpose.

```bash
bd backup init /path/to/backup && bd backup sync   # existing project
bd init --server --skip-hooks --prefix <prefix>    # fresh checkout
bd backup restore --force /path/to/backup
```

Use the `--destroy-token` form only when intentionally overriding the init
refusal; see `bd help init-safety`. Expect the target to start empty until the
restore runs because server mode reads a different data directory.

Review generated integration before adopting the target: `bd init` may add
`AGENTS.md`, `CLAUDE.md`, `.agents/`, `.codex/`, and `.gitignore` entries.

## Server lifecycle

| | Per-project | Shared |
|---|---|---|
| `bd dolt stop` | process exits after flushing | reports success while another project may keep it |
| safe to stop | yes | no, other projects may hold it |

Leave auto-start on by default. Both layouts start on demand without
`bd dolt start`; with auto-start off every call fails until an external owner
starts one.

A started server runs until stopped or machine restart. Stop a per-project
server freely: it flushes, exits, and the next read starts a fresh one. Losing
the process costs a restart, not data.

When an orchestrator or systemd owns the process, set `dolt.auto-start: false`.
Then `bd dolt status` reports `running (external)` with endpoint details when
reachable, or `not reachable (external)` when down. With auto-start off it reads
the endpoint, not the pid file: deleting a stale pid file cannot fake a live
server, and deleting it under a live external server changes nothing.
