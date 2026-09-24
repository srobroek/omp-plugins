---
name: orchestrate-roles
description: Routes each orchestration bead by its agent label and fixes role boundaries.
---

# Orchestration Roles

Role labels route work to a specific queue. The higher implementer tier therefore uses its own routing label, `agent:implementer-high`, following the documented `agent:KIND` shape.

| Routing label | Agent | Boundary |
|---|---|---|
| `agent:implementer` | `implementer` | MUST implement assigned product changes; NEVER review or merge them. The work-reviewer reviews and the merger merges. |
| `agent:implementer-high` | `implementer-high` | MUST implement assigned product changes; NEVER review or merge them. The work-reviewer reviews and the merger merges. |
| `agent:work-reviewer` | `work-reviewer` | MUST review the assigned bead against its acceptance criteria, whether they specify delivered work or a proposed plan; NEVER implement product changes. The work-reviewer reviews and the implementer implements fixes. |
| `agent:researcher` | `researcher` | MUST investigate questions and record evidence; NEVER implement product changes. The implementer acts on accepted findings. |
| `agent:integrator` | `merger` | MUST integrate one exact-head, independently reviewed branch; NEVER review, implement, or resolve conflicts. The lead resolves conflicts. |
| `agent:shepherd` | `shepherd` | MUST coordinate run-linked review rounds and the serialized PR merge queue; NEVER review, implement, or resolve conflicts. The work-reviewer reviews, implementer repairs, and merger integrates. |
| `agent:operator` | `operator` | MUST run exact, bounded mechanical commands with explicit targets and stop on ambiguity; NEVER choose product design, implement feature behavior, or act destructively. The implementer chooses and implements behavior. |

## Delegation Matrix

Plan review and acceptance review use the same `work-reviewer` role with different bead acceptance criteria. A plan review is auditable but is not independent of the lead's dispatch decision; neither implementer tier may commission its own acceptance review.

| Spawner | May spawn | Boundary |
|---|---|---|
| `orchestrator` (lead) | `implementer`, `implementer-high`, `work-reviewer`, `security-reviewer`, `researcher`, `merger`, `shepherd`, `scout`, `operator` | Dispatches work and plan or acceptance review. |
| `implementer` | `scout`, `operator`, `researcher` | Delegates investigation, known mechanical work, or scoped research; NEVER `work-reviewer`. |
| `implementer-high` | `scout`, `operator`, `researcher` | Delegates investigation, known mechanical work, or scoped research; NEVER `work-reviewer`. |
| `work-reviewer` | `scout`, `researcher`, `security-reviewer` | Delegates review investigation or a cited expected-behaviour question; NEVER edit-capable agents. |
| `shepherd` | `scout` | Looks up facts while coordinating and serialising; NEVER implementation or acceptance review. |
| `researcher` | `scout` | Fans out read-only search; NEVER edit-capable agents. |
| `merger`, `scout`, `operator`, `security-reviewer` | none | Do not spawn children. |
The `work-reviewer` judges plans or delivered work from the bead's acceptance criteria; a plan review commissioned by its own lead is auditable but not independent acceptance review of that lead's dispatch decision.
A role MUST NOT spawn any agent outside its listed `May spawn` set.

Measured mechanic: declaring `spawns` is what grants the capability; `task` need not be listed. An omitted `spawns` list would grant unrestricted spawning, so every agent that may spawn MUST declare an explicit list.

| Situation | Choice |
|---|---|
| A bead has an `agent:KIND` label | Route it to the matching agent above. |
| A role boundary would be crossed | Keep ownership with the named replacement role; the lead resolves integration conflicts. |
