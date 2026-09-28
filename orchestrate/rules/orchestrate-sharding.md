---
name: orchestrate-sharding
description: When a review, research question, audit, inventory, or role pool splits into independent parts, shard it across a bounded set of subagents.
---

# Sharding

This rule applies to every agent that spawns subagents: the root session, a
lead, an orchestrator, a reviewer, a researcher, and an implementer. It applies
before any bead exists as well as to bead work.

## Decide

Evaluate the rows in order and apply the first row that matches. Pool workers
follow Pools and beads, not this table.

| Situation | Choice |
|---|---|
| One implementation bead | NEVER shard; decompose it into beads instead |
| A few reads or one bounded lookup, such as one `grep` or one script, answers the whole task | INLINE, no subagent |
| Each unit needs the result of an earlier unit, or one ordered pass | ONE agent |
| Units write the same file, region, or shared state | ONE agent, or split the DAG first |
| Merging shard results would repeat the investigation, as with one causal chain | ONE agent |
| Independent units that fill more than one shard under Size: 2 or more heavy units, or more than 10 light units. Units are questions, records, files, regions, or acceptance criteria | SHARD |
| Anything else | ONE agent or INLINE |

A unit is independent when a shard can finish it with no output from another
shard.

## Size

- A heavy unit needs its own multi-file investigation. A light unit is one
  record, one lookup, or one short question.
- MUST compute the target shard count as the number of heavy units plus the
  light units divided by 10, rounded up.
- MUST dispatch between 2 and 8 shards in one batch, and never more shards than
  units. When the target count exceeds 8, dispatch exactly 8 shards and balance
  the units across them.
- MUST give every shard comparable work, and group light units into contiguous
  ranges.

| Units | Shards |
|---|---|
| 3 heavy questions | 3 |
| 12 light records | 2 |
| 100 light records | 8, of 12 or 13 records each; not 100 agents and not 1 |
| 9 heavy questions | 8; one shard takes 2 questions |
| DAG review of 4 criteria over 20 beads | 4, one per criterion, or up to 8 bead groups |

## Brief

- MUST split along one atomic boundary: a question, a criterion, a region, a
  file group, a record range, or a bead.
- MUST list each shard's exact units in its brief. No unit belongs to two
  shards, and the shards together cover every unit.
- MUST give every shard the same output contract so that results merge
  mechanically, and state shared context once in the batch context.
- MUST dispatch every shard of one task in a single `task` batch.
- MUST spawn only roles in the spawner's delegation matrix in
  `rule://orchestrate-roles`. A reviewer shards through `scout` or `researcher`,
  and a researcher shards through `scout`.
- MUST keep shards read-only unless the spawner may edit and each shard owns
  disjoint files.

## Merge

- MUST merge every shard result into one answer, verdict, or finding set:
  remove duplicates, reconcile conflicts with cited evidence, and name any unit
  still unresolved.
- MUST dispatch again only the shard that failed or returned no result.
- MUST record the merged result where the unsharded result belongs: the bead,
  the review verdict, or the reply.

## Pools and beads

- MUST size a role's pull workers from its ready independent beads, as an
  exception to Decide and Size: 1 worker for 1 ready bead, and the lesser of
  the ready count and 8 for 2 or more. Workers drain the remaining beads
  through the pull loop.
- MUST have the worker that claims a review or research bead covering
  independent units shard its investigation under this rule, then record one
  verdict or answer on that bead.
- The DAG review stays one bead and one round. Its shards are parts of that
  round, not second opinions.
