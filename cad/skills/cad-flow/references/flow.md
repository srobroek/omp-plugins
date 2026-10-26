# CAD flow reference

## Stages, gates, and durable outputs

Keep the source of truth in the hardware project's `hw/` design record. Every decision, requirement, interface, revision, check result, and release artifact must identify its source or evidence. Preserve millimetres and the product's declared ISO or ASME regime. Stage ordering is intentional: do not detail parts before the layout freezes their interfaces, or release before analysis and critique are reconciled.

| Stage | Work and user gate | Design-record output | Skill |
|---|---|---|---|
| GROUND | Inspect the project and existing hardware, needs, constraints, and source material. | `product.yaml` identity, rigor (default `pro`), units `mm`, regime `iso` or `asme`, general tolerance, flow state; initial `requirements.yaml` and `interfaces.yaml` evidence. | `cad-record` (later) |
| INTENT | Present the understood product purpose, users, operating envelope, constraints, and unknowns; wait for approval. | Approved intent and requirement sources/rationales/priorities in `requirements.yaml`; record the gate decision. | `cad-record` (later) |
| SPECIFY | Turn approved intent into measurable requirements and verification criteria. | `requirements.yaml`, using `REQ-###`, text, rationale, source, priority, and verification method `I`, `A`, `D`, or `T` with criteria; update `interfaces.yaml`. | `cad-record` (later) |
| L0 CONCEPT | Build 2–4 rapid three.js visual variants; let the user refine, merge, or drop them. | Concept options and the selected variant/decision in `decisions/DR-###.md`; concept preview is not a verified CAD model. | `cad-concept` |
| VARIANT gate | Obtain explicit selection/approval of the concept direction. | Selected concept and gate evidence in the design workflow record and a `DR-###` decision. | `cad-concept` |
| L1 LAYOUT | Define labelled subassemblies, envelopes, interfaces, joints and limits, plus a BOM skeleton. | `assembly.yaml`: subassemblies and part references; joints with id, type, parent/child, axis, origin in mm, min/max and nominal. Update `interfaces.yaml` and preliminary `bom.csv`. | `cad-record` (later) |
| LAYOUT freeze | Present the layout, interfaces, and BOM skeleton for explicit approval. | Frozen layout decision and gate evidence; set `product.yaml` flow stage and `flow.recheck_from: layout`. | `cad-record` (later) |
| L2 PARTS | Develop one subassembly per loop; independent subassemblies can proceed in parallel, with revision history per run. | `parts/<PN>/part.yaml` plus `model.py` per part: PN matching `^[A-Z]{2,5}-\d{4}$`, rev, title, material, process (`fdm`, `cnc`, or `purchased`), finish, mass target, make/buy, supplier. | `cad-record` and `mol-cad-part` (later) |
| L3 DETAIL | Apply fits, fasteners, tolerances, FDM/CNC design rules, and prepare drawings. | Part revisions and tolerance/fit decisions in the part record and `decisions/DR-###.md`; drawings and their revision/evidence references. | `cad-fits`; `cad-drawings` is later |
| BOM | Reconcile part numbers, revisions, quantities, make/buy, suppliers, and assemblies. | Released-intent `bom.csv` EBOM. | `cad-bom` |
| L4 ANALYSIS | Run the required interference, clearance, stack-up, kinematic sweep, and static FEA at the worst-case pose. | `verification.csv` results linked to requirements and configurations; analysis artifacts and assumptions. | `cad-analysis` is later |
| CRITIQUE | Spawn `cad-mech-reviewer` and `cad-dfm-reviewer` in ONE parallel batch, both read-only. Each reports findings with paths/configuration and evidence. | Preserve each verdict and evidence in the workflow record; do not let one reviewer see or wait for the other's result before returning. | `cad-review-mech`, `cad-review-dfm` (later) |
| RECONCILE | The lead resolves every critique finding: fix it, demonstrate why it does not apply, or record a decision. Re-run affected checks after changes. | Updated `decisions/DR-###.md`, `verification.csv`, part revisions, and finding dispositions. | `cad-flow`; `cad-recheck` is later |
| DESIGN freeze | Present the reconciled design, analyses, and record for explicit approval. | Frozen design decision and gate evidence; affected-part-only reopening applies after freeze. | `cad-record` (later) |
| RELEASE | Prepare and inspect the release package and its traceability. | `releases/<rev>/manifest.json`, final `bom.csv`, `verification.csv`, drawings, STEP AP242, and documentation. Revision matches `^(X[1-9]\d*|[A-HJ-NPRTUVWY])$`: prototypes use `X1`, `X2`, …; released revisions exclude `I`, `O`, `Q`, `S`, `X`, and `Z`. | `cad-record` and `cad-bom` (later); `cad-drawings` is later |
| RELEASE gate | Show release contents and verification status; obtain explicit user approval before calling it released. | Gate decision and release manifest/status. | `cad-record` (later) |

The full endpoint is STEP AP242 plus drawings, EBOM, verification matrix, and docs. Designs target FDM or CNC, but stop before slicing, CAM, or machine-tool generation. FreeCAD 1.1.4 is the only CAD application. CadQuery 2.8 and build123d 0.13 each run in a separate environment.

## Stage loop and recheck boundary

For every stage, draft the requested change, show the live preview with no checks, and ask for user feedback. Keep iterating inside that stage until the user says “commit batch.” Never run checks on each edit.

- Before LAYOUT freeze, “commit batch” means build and render only; it does not trigger recheck or imply design approval.
- At or after LAYOUT freeze, use `product.yaml` `flow.recheck_from` as the earliest stage to recheck. Recheck the changed parts and all dependent parts/assemblies once for the batch, including checks from that stage and all earlier stages. Do not omit a dependent merely because its file was not edited.
- Record the batch's changed items, dependents, checks run, and results. If another edit occurs, keep drafting and previewing; the next “commit batch” defines the next recheck boundary.
- After DESIGN freeze, reopen only affected parts and their dependents. Preserve unaffected parts and their existing evidence.
- A preview or build/render result is not a check result. Report checks only when executed and tied to the design revision/configuration.

## Formula routing

Poured formulas create workflow roots; `mol-` formulas are bondable subprocesses. Do not pour a `mol-` formula or bond a poured tier.

| Action | Formula | When |
|---|---|---|
| Pour | `cad-product` | New product: lead the product from GROUND through the release gate. |
| Pour | `cad-part` | A standalone part/subassembly task with an established product/layout scope. |
| Pour | `cad-touch` | A bounded change to an existing design, rather than restarting the product flow. |
| Bond | `mol-cad-concept` | Attach a concept exploration/refinement when a product workflow reaches L0 CONCEPT. |
| Bond | `mol-cad-part` | Attach a subassembly's L2 PARTS loop to the product workflow; use one loop per subassembly. |
| Bond | `mol-cad-iterate` | Attach an approved iteration to the affected stage/design node. Record changed scope and invalidated evidence; follow the stage-loop recheck rule. |
| Bond | `mol-cad-release` | Attach release preparation after DESIGN freeze, before the RELEASE gate. |

Choose the narrowest poured root that matches the requested work. Do not use a part or touch tier to bypass product gates when the requested scope is a new end-to-end product.

## Skill routing

Use the named skill when available. “Later” means the implementation is not part of batch 1; keep the work at its reachable boundary and report the missing skill rather than pretending it loaded.

| Stage/work | Skill | Availability |
|---|---|---|
| Lead orchestration and gates | `cad-flow` | Batch 1 |
| Product/design record, requirements, interfaces, assembly, revisions, release manifest | `cad-record` | Later |
| L0 visual concepts and variant choice | `cad-concept` | Later |
| Fits, fasteners, tolerances, FDM/CNC design rules | `cad-fits` | Later |
| Drawings | `cad-drawings` | Later |
| EBOM | `cad-bom` | Later |
| Batched recheck | `cad-recheck` | Later |
| Mechanical critique | `cad-review-mech` | Later |
| DFM critique | `cad-review-dfm` | Later |
| Interference, clearance, stack-up, kinematics, FEA | `cad-analysis` | Later |
| Parametric CAD modeling | `cad-model` | Later |
| 3D viewing | `cad-viewer` | Later |
| Motion visualization | `cad-motion` | Later |

## Gate control

Gates remain open until explicit user approval is recorded through `bd gate resolve`. Never infer approval from silence, a preview, a successful build, an agent verdict, or a release artifact. If the current harness or workspace cannot resolve the gate through that command, leave it open and hand the gate to someone who can; do not substitute another gate-closing mechanism.
