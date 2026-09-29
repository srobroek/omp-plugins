---
name: orchestrate-sharding
alwaysApply: true
---

# Sharding

SHARD only a review of a proposed plan or bead DAG whose DAG has MORE THAN 96
beads. This includes the orchestrate DAG review bead. Every other task runs as
ONE agent or INLINE, including audits, research, inventories, record lists,
smaller DAG reviews, and implementation. Role-pool worker sizing follows Pools
and beads.

## Decide

Evaluate the rows in order and apply the first row that matches. Pool workers
follow Pools and beads, not this table.

| Situation | Choice |
|---|---|
| One implementation bead | NEVER shard; decompose it into beads instead |
| A few reads or one bounded lookup, such as one `grep` or one script, answers the whole task | INLINE, no subagent |
| Each unit needs the result of an earlier unit, or one ordered pass | ONE agent |
| Units write the same file, region, or shared state | ONE agent |
| Review of a proposed plan or bead DAG with MORE THAN 96 beads | SHARD by contiguous bead groups in plan order |
| Anything else, including audits, research, inventories, record lists, smaller DAG reviews, and implementation | ONE agent or INLINE |

## Size

- MUST compute the shard count for a qualifying DAG review as its bead count
  divided by 16 and rounded up, clamped to 2..8.
- MUST partition the complete plan node list into contiguous bead groups in plan
  order, with comparable group sizes. When the count is clamped to 8, balance
  the beads across those 8 groups.
- NEVER dispatch a shard with fewer than 8 beads.

| DAG review size | Shards |
|---|---|
| 96 beads | ONE agent |
| 97 beads | 7 contiguous groups |
| 105 beads | 7 contiguous groups |
| 200 beads | 8 contiguous groups |

## Brief

- MUST partition from the plan's node list and `depends_on` edges without
  reading or investigating any bead first. Inspecting beads to decide the split
  repeats the work the shards exist to do.
- MUST split by contiguous bead group, never by criterion. Each shard checks
  every criterion for every bead in its group and names each edge leaving its
  group.
- MUST list the exact bead ids assigned to each shard. No bead belongs to two
  shards, and the shards together cover every bead.
- MUST give every shard the same output contract so that results merge
  mechanically, and state shared context once in the batch context.
- MUST dispatch every shard of one review in a single `task` batch.
- MUST keep shards read-only and use `scout`; a security criterion MAY use
  `security-reviewer`.

## Merge

- MUST merge every shard result into one verdict and finding set: remove
  duplicates, reconcile conflicts with cited evidence, and name any bead still
  unresolved.
- MUST merge without re-investigating. Re-check only a contradiction, an
  uncited finding, or an edge that crosses shard boundaries. NEVER repeat a
  shard's investigation to confirm it.
- MUST dispatch again only the shard that failed or returned no result.
- MUST record the merged result on the review bead.

## Pools and beads

- MUST size a role's pull workers from its ready independent beads, as an
  exception to Decide and Size: 1 worker for 1 ready bead, and the lesser of
  the ready count and 8 for 2 or more. Workers drain the remaining beads
  through the pull loop.
- MUST have the worker that claims the DAG review bead shard its review under
  this rule when the DAG has MORE THAN 96 beads, then record one verdict on
  that bead.
- The DAG review stays one bead and one round, and its shards belong to that
  round.
