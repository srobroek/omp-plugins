---
name: beads-composition
description: Choosing an execution shape: ad hoc issue, epic, formula, poured molecule, bond, or wisp.
---

# Beads Formulas, Molecules, Bonds, and Wisps

EXECUTION SHAPES
| repeated work | shape |
|---|---|
| one-off task or ad hoc DAG | issue or epic with dependencies |
| versioned repeated graph | project-local formula distributed by its owning package |
| durable multi-session or multi-clone execution | persistent molecule via `bd mol pour` |
| local operational check or patrol | wisp via `bd mol wisp` |
| deliberately frozen compiled template ID | persisted proto; otherwise cook formula source inline |
| fixed child hierarchy owned by one workflow | formula `children` |
| reusable child workflow with its own lifecycle | bond a formula or molecule |
| shared campaign or dependency update | persistent molecule; bond independent durable arms |
| local health check, patrol, or single-coordinator release | wisp; promote findings and squash only when the outcome matters |
DEFAULT Store repository workflows under `.beads/formulas/`; user formulas are
  personal only, and package-specific formulas stay versioned in the owning
  APM package rather than the Beads setup or policy package.
MUST Validate formula source with `bd cook`, never `bd formula show`: show prints
  only a child formula's own steps, and pour reports every formula error as
  "not found as formula or proto ID". Assert composed output with
  `bd mol pour --dry-run`.
DEFAULT Authoring, editing, or debugging a formula loads the `build-formula`
  skill; it owns the step schema, conditional steps, gates, and the assertion
  set. This file owns execution shape and disposition only.

COMPOSITION
DEFAULT Use a sequential bond for ordered graphs, parallel for independent
  graphs, and conditional for failure-triggered remediation.
NOT Bond to select optional stages or rewire an inherited step: it joins
  root-to-root and needs a `mol-` prefixed name. Step-level optionality is
  `condition` on the step; see the `build-formula` skill.
NOT Treat "submolecule" as a Beads data type; use fixed children or a bonded
  child graph according to ownership and reuse.
DEFAULT Add expansions, aspects, or named bond points only after two consumers
  require the same composition and the active Beads version proves the
  composition path in a focused test.

WISPS
MUST Use a wisp only when live step state need not synchronize to another
  clone, human, or agent.
| outcome | action |
|---|---|
| one ephemeral issue becomes durable work | `bd promote <id>` |
| execution trace may disappear but its outcome matters | `bd mol squash <root> --summary ...` |
| abandoned, duplicate, test, or valueless execution | `bd mol burn <root>` |
MUST Promote discovered durable work before burning or squashing away the
  ephemeral trace that explains it.
