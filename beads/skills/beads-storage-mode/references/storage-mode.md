# Beads storage mode

These facts come from Beads and Dolt behavior. Load this reference when choosing
embedded versus server storage, diagnosing copied checkouts, or migrating an
existing database.

## The two modes

| | Embedded | Server (default on this machine) |
| --- | --- | --- |
| Init | `bd init` with no server carrier (refused by `bd-init-server-gate`) | `bd init --shared-server`, or `--server` |
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

Server mode survives a copy because it resolves a host and port. OMP's isolated
subagents run in a clone of the checkout, so a project that agents work on needs
server mode; the shared server (`bd init --shared-server`) is this machine's
default, set by `BEADS_DOLT_SHARED_SERVER=true` in the login shell. It gives one
server on port 3308, one data directory (`~/.beads/shared-server/dolt/`), and one
database per project. A `cp -R` copy, a linked worktree, and a fresh `git clone`
on the same machine all reach the same database with no environment variable,
because the tracked `.beads/metadata.json` names it.

The shared server carries two hazards the per-project layout does not. The
database name defaults to the issue prefix, so two projects that share a prefix
share one database; `bd-init-server-gate` refuses that collision, and
`dolt --host 127.0.0.1 --port 3308 --user root --password '' --no-tls sql -q
"SHOW DATABASES"` lists what the server holds. And `bd dolt push` sends the whole
project database, bead bodies and comments included, to `sync.remote` or `origin`.

A container in its own network namespace cannot reach a loopback-bound Dolt
server at any address. Embedded Dolt sync then fails under that network.

## Persisted mode

Read both carriers before concluding that a project is not server-backed:

| Init | `config.yaml` | `metadata.json` |
| --- | --- | --- |
| `bd init --shared-server` | `dolt.shared-server: true` | `dolt_mode: "server"` |
| `bd init --server` | nothing | `dolt_mode: "server"` |

`bd init --shared-server` writes the config key flat (`dolt.shared-server: true`);
bd 1.2.2 also reads it nested under a `dolt:` block. Three carriers turn shared
mode on with different results (verified 2026-09-14 on bd 1.2.2):

| Carrier | `bd init` | Embedded project |
| --- | --- | --- |
| `--shared-server` on the command | complete | untouched |
| `BEADS_DOLT_SHARED_SERVER=true` in the environment | complete | every `bd` command fails with `database not found` |
| `dolt.shared-server: true` in `~/.config/bd/config.yaml` | incomplete: `metadata.json` says server, no database is created | same failure |

The gate accepts the first two carriers and not the third.

## Migration

MUST Treat a mode switch as export, re-init or push, and restore, not as a flag.
The prefix lives in the database, not the repository, so read `--prefix` from an
existing bead id. Choose one of two routes by whether `origin` carries
`refs/dolt/data`. Run `git ls-remote origin 'refs/dolt/*'` to find out. Both routes
start the same way. First run `bd export -o issues.jsonl`. Then run
`bd backup init <dir>`. Then run `bd backup sync`.

```bash
# No Dolt data on origin
bd init --shared-server --reinit-local --skip-hooks --skip-agents --prefix <prefix>
# set "dolt_mode": "server" in .beads/metadata.json; add dolt.shared-server: true to .beads/config.yaml
bd backup restore --force <dir>

# Dolt data on origin (--reinit-local exits 10 there)
bd dolt push            # on a non-fast-forward: bd dolt pull once, then push again
# same two file edits
bd bootstrap --yes
```

Verify `bd count` against the pre-migration count. Compare `bd export` against
`issues.jsonl`, ignoring `updated_at`. Then move `.beads/embeddeddolt` out of the
checkout. Commit `.beads/config.yaml` and `.beads/metadata.json`. Remove
`.beads/dolt-backup.json` afterwards: its state
file churns inside OMP's isolated clones and breaks the merge-back.

Review generated integration before adopting the target: `bd init` may add
`AGENTS.md`, `CLAUDE.md`, `.agents/`, `.codex/`, and `.gitignore` entries.

## Server lifecycle

| | Per-project | Shared |
|---|---|---|
| `bd dolt stop` | process exits after flushing | reports success while another project may keep it |
| safe to stop | yes | no, other projects may hold it |

A per-project server starts on demand. The shared server does not: after
`bd dolt stop`, every read and write fails closed within a second with `Dolt
server unreachable at 127.0.0.1:3308`, and `bd dolt start` from any shared-mode
project brings it back in about one second. `bd init` in a second project refuses
to start a rival on the same port.

A started server runs until stopped or machine restart. Stop a per-project
server freely: it flushes, exits, and the next read starts a fresh one. Losing
the process costs a restart, not data.

When an orchestrator or systemd owns the process, set `dolt.auto-start: false`.
Then `bd dolt status` reports `running (external)` with endpoint details when
reachable, or `not reachable (external)` when down. With auto-start off it reads
the endpoint, not the pid file: deleting a stale pid file cannot fake a live
server, and deleting it under a live external server changes nothing.
