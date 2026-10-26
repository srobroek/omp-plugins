---
name: cad-flow
description: Leads mechanical CAD from a rapid concept through a verified STEP AP242 release. Triggers on take this product from prototype to CAD release.
---

# CAD Flow Lead

TRIGGER
+ “take this product from prototype to CAD release” or “run the CAD design flow”
+ a new or changing mechanical product needs a traceable design record and release
- a single modeling operation without a product workflow → use the relevant CAD tool directly

## Workflow

1. Establish the project’s `hw/` design record and approved scope using the design-record requirements in `references/flow.md`. The `cad-record` skill is later. Load `references/flow.md` for stage outputs, skill routing, and formula rules.
2. Lead the stages in order: GROUND, INTENT, SPECIFY, L0 CONCEPT, VARIANT gate, L1 LAYOUT, LAYOUT freeze, L2 PARTS, L3 DETAIL, BOM, L4 ANALYSIS, CRITIQUE, RECONCILE, DESIGN freeze, RELEASE, RELEASE gate. Do not skip a gate or freeze.
3. Run each stage loop: draft, show a live preview without checks, and collect feedback. “Commit batch” builds and renders; before LAYOUT freeze, do nothing more. At or after the freeze, run one recheck for changed parts and their dependents, starting at `flow.recheck_from`; do not check on every edit.
4. On COMMIT, record the design-record entry and a bead note with the batch, changes, artifacts, checks, and outcomes. Ask whether the user wants more detail; if yes, continue in the stage. Otherwise present the stage gate and request explicit approval.
5. Keep gate evidence on the durable design record. Close a gate only with `bd gate resolve` after explicit user approval.
6. At CRITIQUE, spawn `cad-mech-reviewer` and `cad-dfm-reviewer` together in one parallel batch. Both are read-only. Reconcile their evidence and record dispositions before DESIGN freeze.
7. Finish at a CAD-only release: STEP AP242, drawings, EBOM, verification matrix, and documentation. Do not produce slicer, CAM, or machine-tool output.

## Rules

MUST Preserve the shared record names, fields, units, PN/revision patterns, and schemas in `references/flow.md`.
MUST Route a stage to its listed skill; a skill or agent marked later is unavailable, not permission to invent its procedure.
MUST Use FreeCAD 1.1.4 as the CAD application. CadQuery 2.8 and build123d 0.13 use separate environments.
MUST Keep rough-to-detailed iteration: concepts establish direction, layout freezes interfaces and envelopes, parts precede fits and drawings, and release follows verification and critique.
MUST Keep formula types distinct: pour `cad-touch`, `cad-part`, or `cad-product`; bond only the `mol-` formulas.
NOT Claim a design is checked because it was previewed or because an unchanged part passed an earlier run.
