---
name: beads-swarm-validate-graph
description: A structural change to the work DAG needs bd swarm validate before anything dispatches from it.
condition:
  - "\\bbd\\s+(?:-C\\s+\\S+\\s+)?(?:mol\\s+(?:pour|bond)|dep\\s+add|link|swarm\\s+create)\\b"
  - "\\bbd\\s+(?:-C\\s+\\S+\\s+)?dep\\s+\\S+[^\\n]*--blocks\\b"
scope: "tool:bash"
interruptMode: never
---
This changed the shape of the work graph. Run `bd swarm validate <root> --json` after
graph construction, after each further structural change, during recovery, and before
close-out.

Stop on `swarmable=false`, then read the warnings rather than the verdict alone:
external dependencies, disconnected nodes, multiple endpoints, and an empty graph can
all come back as warnings while the graph still reports as swarmable.

Dispatch and merge-slot rules for the validated graph are in
rule://beads-coordination.
