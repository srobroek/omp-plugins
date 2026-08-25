---
name: beads-init-prefer-server
description: bd init without a server flag creates an embedded, per-checkout database that forks under isolation.
condition: ["\\bbd\\s+init\\b(?![^\\n]*--(?:server|shared-server)\\b)"]
scope: "tool:bash"
interruptMode: tool-only
---
Plain `bd init` creates an embedded database under `.beads/embeddeddolt/`. It is single-writer, and it resolves by walking up from the working directory. So any harness that isolates work by copying the checkout gets a second, writable database. That copy's claims, comments and closures never reach the run. Measured: a copied 54-bead database accepted `create` and `--claim`, with none of it reaching the original.

Prefer one of:

- `bd init --server` for one server for this project.
- `bd init --shared-server` for one per machine, one database per project.

Server mode resolves a host and port, which copying cannot change.

Embedded suits a single-agent repository that is never isolated or copied. Where it is already in use, aim every call at the run's checkout with `bd -C <run repo>`. See rule://beads-storage-mode.
