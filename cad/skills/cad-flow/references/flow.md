# CAD flow reference

## Stages, gates, and durable outputs

Keep the source of truth in the hardware project's `hw/` design record. Every decision, requirement, interface, revision, check result, and release artifact must identify its source or evidence. Preserve millimetres and the product's declared ISO or ASME regime. Stage ordering is intentional: do not detail parts before the layout freezes their interfaces, or release before analysis and critique are reconciled.

| Stage | Work and user gate | Design-record output | Skill / command |
|---|---|---|---|
| GROUND | Inspect needs and existing hardware. | Product identity, rigor, units, regime, tolerances; initial requirements and interface evidence. | `cad-record`: `uv run --script <path-to-cad-record>/scripts/validate.py <project-dir>` |
| INTENT | Present purpose, users, envelope, constraints, unknowns; wait for approval. | Approved intent, requirement sources, rationales, priorities, and gate decision. | `cad-record`: `uv run --script <path-to-cad-record>/scripts/validate.py <project-dir>` |
| SPECIFY | Set measurable requirements and verification criteria. | `requirements.yaml` with REQ-###, rationale, source, priority, verification method and criteria; updated `interfaces.yaml`. | `cad-record`: `uv run --script <path-to-cad-record>/scripts/validate.py <project-dir>` |
| concept | Build 2-4 rapid three.js variants. Refine, merge, or drop by feedback. | `hw/concept/<product-id>.scene.json`; options and selection in `decisions/DR-###.md`. Preview is not verified CAD. | `cad-concept`: `uv run --script skill://cad-concept/scripts/concept.py check <scene>`; handoff: `uv run --script skill://cad-concept/scripts/concept.py handoff <scene> --out hw/concept/handoff.json` |
| VARIANT gate | Get explicit concept selection. | Selected concept and gate evidence in workflow record and `DR-###`. | `cad-concept`: `uv run --script skill://cad-concept/scripts/concept.py handoff <scene> --out hw/concept/handoff.json` |
| layout | Define subassemblies, interfaces, joints/limits, BOM skeleton. | `assembly.yaml`, `interfaces.yaml`, preliminary `bom.csv`. | `cad-record`: `uv run --script skill://cad-record/scripts/validate.py <project-dir>`; `cad-model`: `uv run --script skill://cad-model/scripts/cad_model.py run hw --label vN [--kernel auto]`, then `uv run --script skill://cad-model/scripts/cad_model.py check vN --hw hw [--out FILE]`; `cad-render`: `uv run --script skill://cad-render/scripts/render.py hw [--version latest|vN] [--views iso front side exploded closeup-<PN>]` |
| LAYOUT freeze | Present layout, interfaces, BOM skeleton for approval. | Frozen decision and gate evidence; `flow.recheck_from: layout`. | `cad-viewer`: `uv run --script scripts/viewer.py serve`; then `uv run --script scripts/viewer.py show hw [--version vN] --check FILE`; compare: `uv run --script scripts/viewer.py compare vA vB --hw hw --check-a FA --check-b FB`. |
| parts | Develop one subassembly per loop. Independent loops may proceed in parallel. | `parts/<PN>/part.yaml` and `model.py`; PN, revision, material, process, finish, mass target, make/buy, supplier. | Run `cad-model run`, `cad-model check`, and `cad-render` with the LAYOUT commands. Before L2, run `cad-design` `form_check` with `--fidelity F2`. Use `cad-viewer show hw [--version vN] --check FILE` after build/check. At gates, compare versions, animate joint limits, and capture iso. Capture a revolute section with `uv run --script scripts/viewer.py capture --view 'section --joint J-00x' --out PNG`. |
| detail | Apply fits, fasteners, tolerances, process rules, and drawings. | Part revisions, fit decisions, drawings, and evidence. | `cad-fits`: `uv run --script skill://cad-fits/scripts/fits.py SIZE FIT [--expect TYPE]` and `uv run --script skill://cad-fits/scripts/stackup.py STACK.yaml`; `cad-design`: run `uv run --script skill://cad-design/scripts/form_check.py --hw hw --parts-dir DIR --fidelity F3` before L3 gate; L3 requires F3. Use the layout model/check/render commands for each L3 batch. |
| bom | Reconcile part numbers, revisions, quantities, make/buy, suppliers, and assemblies. | Released-intent EBOM `bom.csv`. | `cad-bom`: `uv run --script skill://cad-bom/scripts/bom.py ASSEMBLY.step --hw hw [--out hw/bom.csv]` |
| analysis | Check interference, clearance, stack-up, kinematics, static FEA at worst pose. | `verification.csv` tied to requirements/configurations; analysis artifacts and assumptions. | Kinematic sweep `cad-motion`: `uv run --script skill://cad-motion/scripts/sweep.py ... --worst-step worst.step`; static FEA uses separate, not-yet-merged `cad-freecad` workflow. Leave its route unchanged. L4 batch uses the LAYOUT model/check/render commands. |
| critique | Spawn mechanical and DFM reviewers in one parallel read-only batch. | Preserve both verdicts and evidence in workflow record. Neither reviewer waits for the other. | `cad-review-mech`; `cad-review-dfm` |
| reconcile | Resolve critique findings. Rerun affected checks. | Updated `decisions/DR-###.md`, `verification.csv`, revisions, dispositions. | `cad-flow`; `cad-recheck`: `uv run --script skill://cad-recheck/scripts/stamp.py --stage <stage> --checks <json-file> --passed` only when checks pass. |
| design_freeze | Present reconciled design, analyses, record for approval. | Frozen decision and gate evidence. Reopen affected parts/dependents only after freeze. | `cad-record`: `uv run --script skill://cad-record/scripts/validate.py <project-dir>`; OCP Studio look-dev: `uv run --script scripts/viewer.py studio --environment studio --tone-mapping ACES --exposure 1.0 [--env-intensity] [--env-rotation] [--background] [--shadow-intensity] [--shadow-softness] [--ao-intensity] [--texture-mapping]` |
| release | Prepare and inspect a traceable release package. | `releases/<rev>/manifest.json`, BOM, verification, drawings, STEP AP242, docs. | `cad-record`: `uv run --script skill://cad-record/scripts/validate.py <project-dir>`; `cad-bom`: `uv run --script skill://cad-bom/scripts/bom.py ASSEMBLY.step --hw hw [--out hw/bom.csv]` |
| RELEASE gate | Show contents and verification. Get approval before release. | Gate decision and release manifest/status. | Capture a release view with `cad-viewer capture --view iso --out PNG`. On session end run `cad-viewer stop`; record `ports_free`. |

The canonical `product.yaml` stage enum uses lowercase values: `ground`, `intent`, `specify`, `concept`, `layout`, `parts`, `detail`, `bom`, `analysis`, `critique`, `reconcile`, `design_freeze`, `release`. Prose may use uppercase or L0 to L4; record values use these enum strings.

The full endpoint is STEP AP242 plus drawings, EBOM, verification matrix, and docs. Designs target FDM or CNC, but stop before slicing, CAM, or machine-tool generation. FreeCAD 1.1.4 is the only CAD application. CadQuery 2.8 and build123d 0.13 each run in a separate environment.

## Stage loop and recheck boundary

Draft, show live previews without checks, and collect feedback. Continue until the user says “commit” or “commit batch”. Do not check on every edit.

- Each L1 to L4 commit batch runs `cad-model run` and then `cad-model check`. Stop if that check has a blocking failure. Render the successful version with `cad-render`. Show its renders at the stage gate.
- The user's commit, the layout threshold, or the hardware git pre-commit hook triggers the broader changed-parts/dependents recheck. Use `flow.recheck_from` and all applicable earlier-stage checks. `cad-recheck` stamps the exact staged `hw/` tree. Use `--passed` only after every required check passes.
- Record changed items, dependents, checks, results, and artifacts. A later edit starts a new batch on the next commit.
- After DESIGN freeze, reopen only affected parts and dependents. Preserve unaffected parts and evidence.
- A preview or render is not a check result. Tie reported checks to a design revision/configuration.

## Gate control

Gates remain open until explicit user approval is recorded through `bd gate resolve`. Never infer approval from silence, a preview, a successful build, an agent verdict, or a release artifact. If the current harness or workspace cannot resolve the gate through that command, leave it open and hand the gate to someone who can; do not substitute another gate-closing mechanism.
