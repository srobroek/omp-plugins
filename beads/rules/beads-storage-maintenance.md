---
name: beads-storage-maintenance
description: "When a Beads store grows large or its queries slow, reclaim space with the cheapest lossless step that fits, and never run filesystem GC against a served database."
---

# Beads Storage Maintenance

Beads commits to Dolt on every mutation by default, so a store grows with write
history rather than with issue count, and query latency grows with it. A ledger
holding a few thousand issues can occupy hundreds of megabytes.

MUST Measure before acting, and separate the parts:

    du -sh .beads/embeddeddolt
    du -sk .beads/embeddeddolt/<database>/.dolt/git-remote-cache

`.dolt/git-remote-cache` is push scratch for the Dolt remote. Deleting it loses
no ledger data, and the next push re-creates it.

## Reclaim in this order, stopping when the size is acceptable

| Step | Reclaims | Costs |
|---|---|---|
| Delete `.dolt/git-remote-cache` | push scratch | nothing; re-created on next push |
| `bd compact --dolt` | unreachable chunks | nothing |
| `dolt gc --full --archive-level=1` in the store directory | every generation, with archive compression | nothing |
| `bd compact --days <n> --force` | old auto-commit history | that history, permanently |
| `bd gc --older-than <n>` | closed issues older than n days | those issues, permanently |

MUST Treat the last two rows as owner decisions rather than routine maintenance.
`bd compact` squashes commits and prunes remote-tracking refs; `bd gc` runs a
decay phase that deletes closed issues. Neither is reversible. Preview with
`--dry-run`.

MUST Pass `--full` to any collection on a store collected before. Dolt storage is
generational and a default pass never revisits the old generation, so space freed
by decay or squashing is not returned without it. `bd gc --full` carries the same
flag.

Measured on a 527 MB store holding 1663 issues: dropping the push cache reached
433 MB, then `dolt gc --full --archive-level=1` reached 149 MB in 3.4 seconds,
with issues, comments, dependencies and all 4399 commits intact.

## Served databases

NEVER Run filesystem `dolt gc` against a database that a `dolt sql-server` holds
open. Collect it online instead, from a SQL client:

    CALL DOLT_GC();

That call breaks every open connection so no writer can reference a collected
chunk. In-flight queries fail and must be retried, reconnecting is safe, and the
initiating connection is unusable afterwards.

MUST Empty a server's dropped-database holding area with its own procedure, never
by moving or deleting `.dolt_dropped_databases` under a live server:

    CALL DOLT_PURGE_DROPPED_DATABASES();

It requires `SUPER`, is not reversible, and discards every database still
awaiting `DOLT_UNDROP()`. Moving that directory by hand mutates live server
storage and proves nothing about the space it would reclaim.

## When to run it

Dolt collects garbage automatically and non-intrusively from version 1.75, so no
fixed cadence applies. Run maintenance on a trigger instead:

- after a large import or a bulk close,
- when a store's size or query latency has visibly grown,
- after deleting branches that carried novel chunks,
- before migrating or backing up a store, where a smaller copy is cheaper.

DEFAULT Reach for `bd compact --dolt` first, since it reclaims space without
discarding anything. Escalate to history or issue deletion only when a measured
size target requires it.
