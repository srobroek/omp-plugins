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

1. Establish the project’s `hw/` design record and approved scope using the design-record requirements in `references/flow.md`. `cad-record` owns record validation; load `references/flow.md` for stage outputs, exact skill commands, formula rules, and gates.
2. Lead the stages in order: GROUND, INTENT, SPECIFY, L0 CONCEPT, VARIANT gate, L1 LAYOUT, LAYOUT freeze, L2 PARTS, L3 DETAIL, BOM, L4 ANALYSIS, CRITIQUE, RECONCILE, DESIGN freeze, RELEASE, RELEASE gate. Use the stage-enum spellings in `references/flow.md`; do not skip a gate or freeze.
3. At each stage, draft and preview without checks. Collect feedback before the commit. For each L1 to L4 commit batch, run `uv run --script skill://cad-model/scripts/cad_model.py run hw --label vN --kernel {{kernel}}`, then `uv run --script skill://cad-model/scripts/cad_model.py check vN --hw hw --out checks-vN.json`. A blocking check failure stops the batch. After success, run `uv run --script skill://cad-render/scripts/render.py hw --version vN` and show renders at the gate.
4. Before the L2 gate, run `uv run --script skill://cad-design/scripts/form_check.py --hw hw --parts-dir hw/versions/vN/parts --fidelity F2`. Each made part needs F2. Before the L3 gate, run the same command with `--fidelity F3`. Each made part needs F3. At L4, run `uv run --script skill://cad-motion/scripts/sweep.py --hw hw --version vN --worst-step worst.step` for kinematics. Static FEA at the worst-case pose uses `uv run --script skill://cad-analysis/scripts/fea_static.py <case.yaml>`.
5. At detail and release, create drawings with `uv run --script skill://cad-drawings/scripts/drawing.py <step> --part <part.yaml> --product <product.yaml> --output-dir <dir> [--scale <ratio>]`.
6. On COMMIT, record the design entry and bead note with batch, changes, artifacts, checks, and outcomes. If the user wants more detail, continue in the stage. Otherwise show renders and present the stage gate for approval.
7. Keep gate evidence in the design record. Close a gate only with `bd gate resolve` after explicit user approval.
8. At CRITIQUE, spawn `cad-mech-reviewer` and `cad-dfm-reviewer` in one parallel batch. Both return read-only evidence. Reconcile their reports before DESIGN freeze.
9. Finish at a CAD-only release: STEP AP242, drawings, EBOM, verification matrix, and documentation. Do not produce slicer, CAM, or machine-tool output.

## Rules

MUST Preserve the shared record names, fields, units, PN/revision patterns, and schemas in `references/flow.md`.
MUST Route a stage to its listed skill and exact command; a skill or agent marked later is unavailable, not permission to invent its procedure.
MUST Run each L1 to L4 commit batch as `uv run --script skill://cad-model/scripts/cad_model.py run hw --label vN [--kernel auto]`, then `uv run --script skill://cad-model/scripts/cad_model.py check vN --hw hw [--out FILE]`; a blocking check failure stops the batch. Then run `uv run --script skill://cad-render/scripts/render.py hw [--version latest|vN] [--views iso front side exploded closeup-<PN>]` for the same version and show its renders at the gate.
MUST Use FreeCAD 1.1.4 as the CAD application. CadQuery 2.8 and build123d 0.13 use separate environments.
MUST Keep rough-to-detailed iteration: concepts establish direction, layout freezes interfaces and envelopes, parts precede fits and drawings, and release follows verification and critique.
MUST Keep formula types distinct: pour `cad-touch`, `cad-part`, or `cad-product`; bond only the `mol-` formulas.
NOT Claim a design is checked because it was previewed or because an unchanged part passed an earlier run.
MUST Resolve `skill://<name>/` to the base directory of the named skill when running `uv run --script` commands on non-OMP harnesses; OMP resolves the URI directly.

