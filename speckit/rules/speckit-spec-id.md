---
name: speckit-spec-id
description: Reminds that every bead a spec produces carries --spec-id <NNN-slug>.
condition: ["\\bbd\\s+create\\b(?![^\\n]*--spec-id)"]
scope: "tool:bash"
interruptMode: never
---

This `bd create` has no `--spec-id`. Every bead a spec produces carries
`--spec-id <NNN-slug>`; without it the bead drops out of
`bd query 'spec_id="<NNN-slug>"'` and `bd list --spec`, which is how later
SpecKit phases read task state instead of tasks.md.

    bd create "T00N <title>" --parent <implement-step-id> --spec-id <NNN-slug> -t task

Bulk `bd create -f <tmp>.md`: put `--spec-id` on every entry in the file (and
keep the file OUTSIDE `specs/`).

Not spec work — a scratch bead, a repo chore, no active spec dir — then there is
nothing to set and this is noise; proceed.
