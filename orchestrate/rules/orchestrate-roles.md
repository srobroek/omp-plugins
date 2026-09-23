---
name: orchestrate-roles
description: Routes each orchestration bead by its role label and fixes role boundaries.
---

# Orchestration Roles

| `role:` label | Agent | Boundary |
|---|---|---|
| `implementer` | `implementer` | MUST implement assigned product changes; NEVER review or merge them. The `work-reviewer` reviews and the `merger` merges. |
| `work-reviewer` | `work-reviewer` | MUST independently review completed work; NEVER implement product changes. The `implementer` implements fixes. |
| `researcher` | `researcher` | MUST investigate questions and record evidence; NEVER implement product changes. The `implementer` acts on accepted findings. |
| `merger` | `merger` | MUST integrate independently reviewed work; NEVER review its own work or replace review. The `work-reviewer` reviews. |
| `shepherd` | `shepherd` | MUST aggregate review findings into one fix bead; NEVER implement product changes or merge. The `implementer` fixes and the `merger` integrates. |
| `operator` | bundled `sonic` | MUST perform mechanical steps; NEVER choose product design or implement feature behavior. The `implementer` chooses and implements behavior. |

| Situation | Choice |
|---|---|
| A bead has a `role:` label | Route it to the matching agent above. |
| A role boundary would be crossed | Keep ownership with the named replacement role. |
