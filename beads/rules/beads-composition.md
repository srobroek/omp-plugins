---
name: beads-composition
description: "Choosing an execution shape: ad hoc issue, epic, formula, poured molecule, bond, or wisp."
---

# Beads Formulas, Molecules, Bonds, and Wisps

## Execution shapes

| repeated work | shape |
|---|---|
| one-off task or ad hoc DAG | issue or epic with dependencies |
| versioned repeated graph | project-local formula owned by its package |
| durable multi-session or multi-clone execution | persistent molecule via `bd mol pour` |
| local operational check or patrol | wisp via `bd mol wisp` |
| deliberately frozen compiled template | persisted proto; otherwise cook formula source inline |
| fixed child hierarchy owned by one workflow | formula `children` |
| reusable child workflow with its own lifecycle | bond a formula or molecule |
| shared campaign or dependency update | persistent molecule; bond independent durable arms |
| local health check or single-coordinator release | wisp; promote findings and squash only when the outcome matters |

DEFAULT Store repository workflows under `.beads/formulas/`; user formulas are
personal, and package-specific formulas stay versioned in their owning package.
For formula authoring, load `skill://build-formula`; it owns the schema,
conditions, gates, and assertions.

## Composition

DEFAULT Use a sequential bond for ordered graphs, parallel for independent
graphs, and conditional for failure-triggered remediation.
NOT Bond to select optional stages or rewire an inherited step: bonds join
root-to-root and need a `mol-` prefixed name. Step-level optionality belongs in
a formula condition.
NOT Treat “submolecule” as a Beads data type; use fixed children or a bonded
child graph according to ownership and reuse.
DEFAULT Add expansions, aspects, or named bond points only after two consumers
need the same composition and a focused test proves the active Beads version.

## Wisps and disposition

MUST Use a wisp only when live step state need not synchronize to another
clone, human, or agent.

| outcome | action |
|---|---|
| one ephemeral issue becomes durable work | `bd promote <id>` |
| execution trace may disappear but its outcome matters | `bd mol squash <root> --summary ...` |
| abandoned, duplicate, test, or valueless execution | `bd mol burn <root>` |

MUST Promote discovered durable work before burning or squashing away the
trace that explains it.
