# Planning and pluggable frameworks

You (the orchestrator) own the high-level plan. The decomposition into executable
units is pluggable. Use an external framework when the project has one. Otherwise
build the default runtime DAG.

Owning the plan means owning the decisions and the graph, not doing the deep
reading yourself. Push codebase exploration and any large planning pass to
read-only agents (`Explore`, `Plan`) and keep only their conclusions. The
orchestrator stays lean so its context lasts the whole run.

## Decide the planning system

- **External framework in play (SpecKit or similar):** delegate the speccing to
  its own commands and agents: the `speckit-*` skills its extensions install, plus
  the `speckit-verify` and `speckit-sync` agents. Take that system's tasks as the
  unit of work and skip the default decomposition below. A beads-managed SpecKit
  molecule is already a dependency-aware run DAG. Label its step beads `orc-node`
  and add `scope` metadata rather than building a second graph on top
  (`references/beads-store.md`). Questions the spec agents raise bubble to you as
  `ASK` and then to the user.
- **No framework:** build the default runtime DAG as node beads under the run
  epic (below).
- **Work spanning more than three tasks with cross-cutting deps, or an unfamiliar
  subsystem:** delegate a deep planning pass to the read-only `Plan` agent before
  committing the decomposition. You still own the final graph.

## Default DAG decomposition

The DAG is per-project and runtime-mutable. You add nodes and edges, and agents
update state live. It is not a static authored graph.

1. Split the work into tasks small enough for one worker. Give every task a
   disjoint `scope`: tracked-file globs for git work, or canonical artifact and
   resource prefixes for non-git work. Serialize overlapping scopes with a
   dependency.
2. One child bead per task under the run epic: `bd create "{id}: {desc}"
   --parent {epic} --labels orc-node --metadata '{routing-envelope}'`.
3. Encode dependencies: `bd dep add <dependent> <dependency>` -- the dependency
   must close before the dependent becomes ready. `bd dep cycles` must stay
   clean (bd also rejects cycle-creating edges at add time).
4. Drive execution off `bd ready --label orc-node --parent <epic> --json`.
   Run `scope-check.py --candidate <bead> --epic <epic>` for every node. Scope
   conflict → leave unclaimed and add a dependency to serialize.

## Routing envelope

Before dispatch, write the route, so recovery never has to infer it from prose.

| Field | Value |
|---|---|
| `scope` metadata | owned tracked-file globs or canonical non-git resource prefixes. Never empty |
| `execution_task_kind` metadata | stable routing kind: `code`, `docs`, `research`, `review`, `operations` |
| `execution_kind` metadata | `git`, `artifact`, `comment`, or `external` |
| `execution_agent` metadata | selected agent type when directed. Absent while the bead waits in a queue |
| `execution_dispatch` metadata | `explicit`, `specialist`, or `generic` |
| `orc-node` label | run-DAG membership. Every ready query filters on it |
| `agent:<queue>` label | compatible generic queue. Absent from directed work |

`execution_kind=git` means tracked files change, even when the task is
documentation or configuration. It needs commit, `push` metadata, and shepherd
integration through the Worktrunk writer contract. `push` is metadata in every
role rules file and has no label form. Other evidence modes need an `output_ref`
or verifiable external-state reference, never an empty commit.

## Dispatch ready work

Apply one route only, in this order:

1. **Explicit actor:** a bead with an assignee goes only to that actor. Confirm
   its `execution_task_kind`, `execution_kind`, and `scope` are compatible, then
   send only `CLAIM {bead-id}`. An incompatible explicit assignment remains pinned
   and unclaimed. Automatic correction may update only evidence-backed envelope
   fields. It never changes the assignee. An actor change needs an explicit release
   or requeue, or a coordinator reassignment under the recovery contracts.
2. **Specialist:** for an unassigned bead, choose the narrowest catalogued
   specialist that handles its `execution_task_kind` and `execution_kind`. Stamp
   `actor`, `execution_agent`, and `execution_dispatch=specialist` before sending
   only `CLAIM {bead-id}`.
3. **Queue:** use only when no specialist is selected. Add one `agent:<queue>`
   label with `bd update <id> --add-label agent:<queue>`, stamp
   `execution_dispatch=generic`, and leave the bead unassigned.

A queue actor claims the first-ready bead in its admitted queue atomically:

```
bd ready --parent <epic> --label orc-node --label agent:<queue> \
  --metadata-field execution_task_kind=<kind> \
  --metadata-field execution_kind=<evidence> --unassigned --sort priority \
  --claim --json
```

The actor accepts the bead returned by `--claim`. It never lists candidates and
cherry-picks one. Spawn or wake a queue actor only for queues with observed ready
work. One activation owns at most one node and cannot claim another until the
first node is terminal. After a claim race, an empty result changes no bead.

While a bead stays unassigned, the coordinator may add, remove, or change its
`agent:<queue>`. A routing envelope the actor cannot satisfy is a routing defect:
it does no task work, records the mismatch, and sends `BLOCKED kind:design` so the
coordinator can repair the route.

## Merge order is not encoded

Do not encode merge order in the graph. You cannot predict which coders finish
when. Approved branches integrate under the exclusive merge slot
(`bd merge-slot acquire` without `--wait`). A held slot is advisory, so report the
holder and retry later. Order follows successful acquisition, not a queue or FIFO
guarantee. The shepherd conflict-guards every integration
(`conflict-probe.sh`). The graph expresses dependencies, not integration sequence.

For GitHub-backed runs, `release-queue-watch` priority affects which eligible
PR readiness hint arrives first. It does not rewrite the DAG or reserve the
merge slot. The orchestrator admits only an exact existing approved node. After
admission, the shepherd's slot waiters remain the integration order.

## Scope hygiene

Scope choice decides whether nodes can run concurrently:
- Prefer directory-level ownership (`src/auth/**`) over scattering one node across
  many trees.
- If two tasks must touch the same file, they are not concurrent. Give one a
  dependency on the other (`bd dep add`) so the ready front serializes them.
- A shared contract or interface that two or more nodes depend on must be its own
  early node that the others depend on.
- Artifact-only and external-state scopes use stable prefixes such as
  `artifact:/abs/path` or `external:<system>/<resource>` so overlap is checked
  the same way as file ownership.

## Concurrency cap

The cap counts live agents, not CPU. Count every one of these:

- each specialist
- each child a specialist fans out to
- each reviewer
- the shepherd
- the scribe

An agent idle during review still holds a slot, because the run never recycles a
worker.

Nothing in a run is CPU-bound. The two limits to watch are the provider rate
limit and the lead's own context budget.

- While the provider accepts requests and the lead's context has room, raise the
  cap.
- On the first rate-limit rejection, lower the cap.
- If disk is tight, lower it again. Every git-backed worker carries its own
  build artifacts.

Queue workers that have not claimed a bead do not count as useful parallelism.
Do not keep idle pollers running.
