# Dispatch contract

Put this contract in the `task` batch `context` field. That field reaches every spawn's system prompt. Do not paste it into a child's user prompt. Do not send `CLAIM {id}` — identity is the caller-chosen `task` `name`, returned synchronously before the child runs.

`hub send` is free-text. There is no message linter. Keep the semantics below; drop byte-exact verb envelopes.

## Authority

Task data lives on the claimed bead or wisp: metadata, one `BRIEF` comment, linked wisps. Prompt-carried details are not authority. The lead never claims. Write authority comes from `bd update {id} --claim` after the spawn already has a name.

Self-discovery (architects): `bd ready -t epic --has-metadata-key worktree --metadata-field role=architect --unassigned --json`. Adding `--claim` is atomic and first-wins. Directed dispatch is pre-assignment: `bd update <bead> --assignee <actor>`.

Set `BEADS_ACTOR` and `BD_ACTOR` to `metadata.actor` (the spawn `name`) on every mutating Beads process.

## Isolation and checkout

Writers: `isolated: true`, `apply: false`. Review `<id>.patch` or `omp/task/<id>`, then a **fresh** isolated fixer. Isolated agents park without a reviver.

The isolation baseline is the parent's dirty WIP (staged, unstaged, untracked-not-gitignored), not clean HEAD.

Do not stamp Worktrunk `worktree` paths or run `wt switch`. Native isolation owns the tree. `artifacts_dir` remains an absolute path under the primary checkout, outside every isolated tree.

Stamp `metadata.integration_owner=orchestrate` on every merge bead this run creates.

## Spawn boundary

- A domain specialist may spawn bounded, contract-free implementation children in its isolated tree. Children never claim, commit, push, or spawn another writer.
- Every other actor spawns nothing. A child never spawns. This is now convention (`spawns`, `task.maxRecursionDepth`), not a hook denial.

Reviewer / advisor / researcher: create and link the review or escalation wisp first; spawn with a new `name`; the child reads the wisp. The orchestrator is a doorbell, not a relay.

Scribe: spawn against a query wisp linked to the run epic. Shepherd: one merge-bead claim per repository; standalone pr-shepherd is for global drain when the run-scoped sheepdog is not held.

## Material outcomes

A result is material when it changes scope, route, ordering, acceptance evidence, disposition, policy, or a human answer. Before acting:

1. Promote a bead-local result to an actor-attributed work-bead comment.
2. Promote a cross-bead or shared-contract result to a linked decision bead.
3. Read the promoted record and links back.
4. Cite that record. An artifact is evidence only until a durable record cites it.

Every factual claim carries a `file:line`, command result, bead/wisp id, or `untested`. Cite prior facts by reference; never paste them into a relay.

Working notes go to the node's worklog wisp or an artifact path. Terseness governs `hub send` and comments, not reasoning depth.

## Semantic verbs

Use these as beads comments / wisp bodies, not as linted harness messages:

| Intent | Writer | Carries |
|---|---|---|
| blocked | specialist → escalation wisp | node, kind, exact question, minimal refs |
| advice | advisor → escalation wisp | one recommendation, reason, refs |
| reported | claim-holder → work bead | evidence ref, verification, next route |
| review | reviewer → node + review wisp | dimension, round, verdict, item count |
| fix | reviewer → review wisp | numbered required actions with refs |
| conflict | shepherd → merge/fix bead | PR/head, files, required outcome |
| approve | reviewer/queue sensor → merge bead | approved head and readiness identity |
| merged | shepherd → merge bead | PR, merge SHA, final-base proof |
| dismiss | lifecycle owner → work bead | terminal disposition and cleanup ref |
| ask | any actor → escalation wisp | one product-intent question and impact |
| no-work | generic actor → run epic | queue and `reason:no-compatible-work` |

The orchestrator may `hub send` a short wake after one of these writes. It does not copy the content into the wake.

## Evidence shapes for reported

Exactly one of: Git (branch, pushed SHA, draft PR/merge bead, verification); Artifact (absolute `output_ref` under `artifacts_dir`, verification); Comment (exact comment or audit-event reference, verification); External (resource identity, read-back, verification).

Empty generic activation: comment `NO_WORK` on the run epic with queue name and `reason: no-compatible-work`.

## Blocked

Design/debug uncertainty creates an escalation wisp; wake an advisor; they exchange on that wisp without orchestrator relay. Product intent creates an ASK wisp and a human gate. No actor waits live on a peer. Checkpoint and exit.

## Thread identity

Durable records carry `actor`, `assignee`, `run`, `bead`. A root message links to the work bead. A reply links to one open message in the same run and work bead. `hub send` is advisory; inbox remains the beads thread.
