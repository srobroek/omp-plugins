---
name: orchestrate-roles
description: Routes each orchestration bead through a claim pool and fixes role boundaries.
---

# Orchestration Roles

The claim-pool alias is the queue for each pull-based role. Pools are configured in the ledger with the exact, case-sensitive aliases below.

| Pool alias | Agent | Boundary |
|---|---|---|
| `pool:implementer` | `implementer` | MUST implement assigned product changes; NEVER review or merge them. The work-reviewer reviews and the shepherd integrates approved merge beads. |
| `pool:implementer-high` | `implementer-high` | MUST implement assigned product changes; NEVER review or merge them. The work-reviewer reviews and the shepherd integrates approved merge beads. |
| `pool:work-reviewer` | `work-reviewer` | MUST review the assigned bead against its acceptance criteria, whether they specify delivered work or a proposed plan; NEVER implement product changes. The work-reviewer reviews and the implementer implements fixes. |
| `pool:researcher` | `researcher` | MUST investigate questions and record evidence; NEVER implement product changes. The implementer acts on accepted findings. |
| `pool:shepherd` | `shepherd` | MUST pull one epic's `pool:shepherd` merge-bead queue, verify exact-head evidence, and serialize integration; NEVER review, implement, or resolve conflicts. The work-reviewer reviews, implementer repairs, and the lead resolves conflicts. |
| `pool:operator` | `operator` | MUST run exact, bounded mechanical commands with explicit targets and stop on ambiguity; NEVER choose product design, implement feature behavior, or act destructively. The implementer chooses and implements behavior. |

Every pull-based role runs `bd ready --assignee pool:ROLE --json`, keeps only records whose `metadata.epic_id` exactly matches its lead-owned epic, claims one with `bd update ID --claim`, and calls `pool_wait` with its exact pool and epic id when the filtered queue is empty. `pool_wait` blocks in-process until a ready record appears, its timeout, or an error; only timeout or error permits a run-level yield. Workers use only pool-aware CAS release; an expired lease is reclaimed and then explicitly re-pooled by the lead.

## Delegation Matrix

Plan review and acceptance review use the same `work-reviewer` role with different bead acceptance criteria. A plan review is auditable but is not independent of the lead's dispatch decision; neither implementer tier may commission its own acceptance review.

| Spawner | May spawn | Boundary |
|---|---|---|
| `orchestrator` (lead) | `implementer`, `implementer-high`, `work-reviewer`, `security-reviewer`, `researcher`, `shepherd`, `scout`, `operator` | Dispatches work and plan or acceptance review, then creates merge beads after approval and ensures one shepherd per epic. |
| `implementer` | `scout`, `operator`, `researcher` | Delegates investigation, known mechanical work, or scoped research; NEVER `work-reviewer`. |
| `implementer-high` | `scout`, `operator`, `researcher` | Delegates investigation, known mechanical work, or scoped research; NEVER `work-reviewer`. |
| `work-reviewer` | `scout`, `researcher`, `security-reviewer` | Delegates review investigation or a cited expected-behaviour question; NEVER edit-capable agents. |
| `shepherd` | `scout` | Looks up facts while coordinating and serialising; NEVER implementation or acceptance review. |
| `researcher` | `scout` | Fans out read-only search; NEVER edit-capable agents. |
| `scout`, `operator`, `security-reviewer` | none | Do not spawn children. |

The `work-reviewer` judges plans or delivered work from the bead's acceptance criteria; a plan review commissioned by its own lead is auditable but not independent acceptance review of that lead's dispatch decision.
A role MUST NOT spawn any agent outside its listed `May spawn` set.

Measured mechanic: declaring `spawns` is what grants the capability; `task` need not be listed. An omitted `spawns` list would grant unrestricted spawning, so every agent that may spawn MUST declare an explicit list.

| Situation | Choice |
|---|---|
| A bead is assigned to a role pool | Pull it with the matching `pool:ROLE` alias. |
| A role boundary would be crossed | Keep ownership with the named replacement role; the lead resolves integration conflicts. |
