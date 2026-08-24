---
name: beads-orchestration-doctrine
description: Cross-package doctrine for multi-agent beads runs: claim as contract, wisps, links, labels, and gates.
---

# Beads Orchestration Doctrine -- claim⟺contract, wisps, links, labels, gates

Cross-package doctrine for multi-agent runs on beads. Orchestrate and speckit
consume this; they do not restate it. Primitives are defined in
[composition]rule://beads-composition and
[coordination]rule://beads-coordination; this layer fixes how agents
*use* them.

## CLAIM ⟺ CONTRACT

MUST An agent holding a durable-bead claim is bound by a completion and
  authority contract; an agent holding no claim has no contract. Both
  directions hold for every agent type.
MUST Hold at most one durable-bead claim per actor at a time; wisp claims are
  exempt and unbounded. Hold zero claims of any kind at exit.
MUST Spawn only claim-holders from the coordinator; a subagent never spawns
  another claim-holder. Children run contract-free and never claim.
NOT Put task data in a spawn prompt. The prompt carries only the activation
  verb (`CLAIM <bead-id>`, `CLAIM <wisp-id>`, or `CLAIM queue:<filter>`); the
  bead carries scope, base, evidence kind, and the BRIEF comment.

## METADATA vs COMMENTS

MUST Keep bead metadata to machine-checkable scalars that a rule, a spawn
  decision, or a landing step reads. Narrative goes in comments.
DEFAULT A healthy node's durable comment thread stays small (BRIEF, one
  REPORTED, verdict lines, closing summary); process chatter rides wisps.
NOT Mirror state-machine state or verdicts into metadata -- one source of
  truth per fact.

## WISPS -- role vocabulary

MUST Route ephemeral coordination through wisps typed by lifetime, not by
  name; the title prefix carries the role.
| role | title prefix | `--wisp-type` | TTL | claimable |
|---|---|---|---|---|
| review round | `[wisp:review] <node>: <dim>` | escalation | 7d | reviewer |
| advice / question | `[wisp:escalation] <node>: <q>` | escalation | 7d | advisor/researcher |
| work-log / checkpoints | `[wisp:worklog] <node>` | gc_report | 24h | no |
| ledger event | `[wisp:ledger] <event>` | gc_report | 24h | no |
| singleton lease | `[wisp:patrol] <name> <scope>` | patrol | 24h | lease holder |
| liveness / probe | ad hoc | ping / heartbeat | 6h | no |
| recovery action | ad hoc | recovery | 7d | per protocol |
MUST Never place a rule-checked datum on a wisp except its own open/closed
  state. Wisps are burned; a purged claim-check is a hole.
MUST Never burn a wisp while a dependency edge targets it; burn review wisps
  only after the merge bead closes, work-log/escalation at node close.
DEFAULT Touch a long-lived open wisp each cycle: a 24h-untouched open wisp is
  flagged abandoned, so lease freshness doubles as the liveness signal.
DEFAULT `bd promote` a wisp whose content proves durable rather than widening
  its TTL; content worth over 7 days is not wisp content.

## GRAPH LINKS -- provenance

MUST Use dependencies (`blocks`, parent) to shape the ready frontier; use
  graph links to carry provenance and conversation, never to schedule.
| link | use |
|---|---|
| `relates-to` | node↔wisp tether, node↔domain bead, cross-node hints |
| `discovered-from` | follow-up work found mid-node; fix beads |
| `caused-by` | bounce investigations, recovery beads → the failed node |
| `supersedes` | re-planned nodes (old auto-closes with a forward pointer) |
| `duplicates` | coordinator dedup (auto-close) |
DEFAULT Discover linked wisps via `bd show <bead>` links, not metadata
  pointers; when a wisp burns its link dies with it.

## LABELS -- declaration, not enforcement

MUST Treat labels as declarations queried with `bd list --label-any`; merge
  safety derives from the dependency graph, never from a label.
| label | writer | meaning |
|---|---|---|
| `agent:<role>` | coordinator or finishing actor | what to spawn next |
| `needs-review:<dim>` | planner or any claim-holder (add only) | review lens required |
| `reviewed:<dim>` | the approving reviewer (swap) | dimension approved this round |
MUST Only the approving reviewer swaps `needs-review:<dim>` → `reviewed:<dim>`,
  in the same act as closing its review wisp; only the coordinator reverses a
  swap (scope-retrigger).

## VERDICT AGGREGATION

MUST Aggregate multi-dimension review through the dependency graph: the
  coordinator creates one review-wisp shell per `needs-review:*` label and a
  `blocks` edge from the merge bead to each, atomically, before spawning any
  reviewer. The merge bead is ready exactly when the last review wisp closes.
NOT Count dimensions in any actor. Readiness is a `bd ready` answer.

## GATES

MUST Park async waits on native gates, not custom holds: `human` (approval,
  ASK), `timer` (recurring drain cycles), `gh:run` (CI), `gh:pr` (external PR
  merge). A gate blocks the bead until `bd gate check` or `bd gate resolve`.
MUST Never place a `gh:pr` gate on a merge bead -- it deadlocks the integrator
  queue; gate the dependent work bead instead.
DEFAULT Tick gates from the coordinator wake and the shepherd patrol
  (`bd gate check --type=gh`); gates never self-resolve.

## WAKE

DEFAULT Wake a suspended actor by resume where the runtime supports it; fall
  back to respawn `CLAIM <same-bead>` under the same actor name. The bead is
  the contract; resume is an optimization. Any wake may become a respawn.
NOT Block one agent live waiting on another. A blocked actor writes its
  escalation wisp, checkpoints, and exits (pause state) or bounded-polls on
  runtimes without resume.
