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

1. At GROUND, run `uv run --script cad/skills/cad-flow/scripts/setup.py` from the project root. Setup checks FreeCAD 1.1.4 first. A missing command or wrong version makes setup exit nonzero before any other action. The error shows the download URL and lookup order. Follow `cad-drawings/SKILL.md` to install FreeCAD, then rerun setup.
   Add `--yes` to execute the remaining user-level setup actions. Pass `--harness opencode|kiro|claude` to install harness files. Setup reruns preflight and prints its summary.
   Start the background warm-up after setup. Continue the GROUND work while it runs.
   - OMP: `uv run --script skill://cad-flow/scripts/preflight.py --warm --background`
   - Claude Code, with the base directory shown when this skill loaded: `uv run --script "<base directory>/scripts/preflight.py" --warm --background`
   - OpenCode, from the project root: `uv run --script .opencode/skills/cad-flow/scripts/preflight.py --warm --background`
   - Kiro, from the workspace root: `uv run --script cad/skills/cad-flow/scripts/preflight.py --warm --background`

   Before the first L1 LAYOUT build, run the same script with `--status --wait 90` and act on its exit code:
   - 0: continue.
   - 3: the warm-up is still running. Run the status command again.
   - 1: a required check failed. Stop, apply its fix, and run the script with `--warm` in the foreground until it exits 0.
   - 2: no warm-up ran, or it stopped. Run the script with `--warm` in the foreground.

   Harness installation and Beads checks are warnings only.
2. Establish the project’s `hw/` design record and approved scope using the design-record requirements in `references/flow.md`. `cad-record` owns validation and path resolution; its generated `references/layout.md` is the canonical layout table and `references/layout-api.md` is the command API. For existing projects, run `uv run --script skill://cad-record/scripts/validate.py PROJECT --migration-plan` before freezing; it reports a read-only move/rebuild plan. Legacy versions and v1 releases stay unchanged and are never reissued.
3. Lead the stages in order: GROUND, INTENT, SPECIFY, L0 CONCEPT, VARIANT gate, L1 LAYOUT, LAYOUT freeze, L2 PARTS, PARTS gate, L3 DETAIL, DETAIL gate, BOM, L4 ANALYSIS, ANALYSIS gate, CRITIQUE, RECONCILE, DESIGN freeze, RELEASE gate, RELEASE. Use the stage-enum spellings in `references/flow.md`; do not skip a gate or freeze. Run `release.py` only after the RELEASE gate approves, with that approval recorded as its `DR-###`.
   At L0 CONCEPT, follow `skill://cad-concept/` for launching and stopping the concept viewer.
4. Delegate every stage the Delegation table lists: one worker per unit, all of the stage's units in one parallel batch, then one integration by you and the stage's one gate. Do every other stage yourself. LOAD `references/flow.md` "Delegation" before the first batch.
5. At each stage, draft and preview without checks; collect feedback before commit. Each L1-L4 batch builds a new immutable version with `cad-model run`, then `cad-model check`; any blocking failure stops. Pass any explicit check output as a new path under `.cad-work/`. After success, render that same version and show images at the gate. Once the version has an independent movable joint, also run its default motion render and show the contact sheet; a coverage gap or limit finding blocks the gate. Read `cad-record/references/layout.md` and use its API for every version or producer path.
6. Before PARTS, run `cad-design form_check.py` on the integrated version at F2; before DETAIL, run at F3. Each made part needs the required fidelity. At L4, use the producer commands to publish version-bound evidence bundles; all version inputs come from the `record/` snapshot, and any explicit output override is a new `.cad-work/` path. Never publish to ad-hoc directories.
7. At L3 DETAIL and release, use `cad-drawings` to draft, review and publish drawings for a selected version. Follow its documented CLI and scratch-output options; rejected drafts remain scratch. Record accepted drawing checks in `verification.csv`.
8. On COMMIT, record the design entry and bead note with batch, changes, artifacts, checks, and outcomes. If the user wants more detail, continue in the stage. Otherwise show renders and present the stage gate for approval.
9. Keep gate evidence in the design record. Close a gate only with `bd gate resolve` after explicit user approval.
10. Finish at a CAD-only release: STEP AP242, drawings, EBOM, verification matrix, and documentation. Do not produce slicer, CAM, or machine-tool output.

## Delegation

| Stage | One worker per | Agent | You integrate |
|---|---|---|---|
| L0 CONCEPT | variant, 2-4 | `cad-concept-designer` | Merge the variants into the scene, check it, and run the preview |
| L2 PARTS | subassembly; purchased family | `cad-part-designer`; `cad-sourcing-researcher` | Apply accepted proposals, then build, check, F2-check, and render one version |
| L3 DETAIL | made part | `cad-part-designer` | Apply accepted fit proposals, then build, F3-check, render, and draw one version |
| L4 ANALYSIS | case: sweep, FreeCAD assembly, stack-up, FEA, motion | `cad-analyst` | Write the verification rows, publish accepted motion cases, and render the analysed version |
| CRITIQUE | reviewer | `cad-mech-reviewer`, `cad-dfm-reviewer` | RECONCILE |
| ECO, post-freeze change | affected part, then affected case | `cad-part-designer`, `cad-analyst` | As L3, then as L4 |

GROUND, INTENT, SPECIFY, L1 LAYOUT, BOM, RELEASE, and every gate stay with you. With Beads, the units are the molecules bonded onto the stage's fan-out step; without Beads, list them in your plan and dispatch them the same way.

Dispatch a batch with the harness's subagent tool, one unit per worker:
- OMP: one `task` call with one `tasks[]` entry per unit and `agent: <agent>`.
- Claude Code: one `Task` call per unit with `subagent_type: cad:<agent>`, all in one message.
- OpenCode 2: one `subagent` call per unit with `agent: <agent>`, all in one message.
- Kiro: the subagent tool, one workspace agent per unit.

## Rules

MUST Preserve the shared record names, fields, units, PN/revision patterns, and schemas in `references/flow.md`.
MUST Route a stage to its listed skill and exact command; a skill or agent marked later is unavailable, not permission to invent its procedure.
MUST Run each L1 to L4 commit batch as `uv run --script skill://cad-flow/scripts/run.py cad-model/scripts/cad_model.py run hw --label vN [--kernel auto]`, then `uv run --script skill://cad-flow/scripts/run.py cad-model/scripts/cad_model.py check vN --hw hw [--out FILE]`; press fits declared in `hw/interfaces.yaml` are automatically allowed and a blocking check failure stops the batch. Then run `uv run --script skill://cad-flow/scripts/run.py cad-render/scripts/render.py hw [--version latest|vN] [--views iso front side exploded closeup-<PN>]` for the same version and show its images at the gate. Once the version has an independent movable joint, also run `uv run --script skill://cad-flow/scripts/run.py cad-motion/scripts/motion.py render --hw hw --version vN --case default --outputs glb,sheet`; exit 1, a coverage gap or limit finding, blocks the gate, and exit 2 is no result.
MUST Use FreeCAD 1.1.4 as the CAD application. CadQuery 2.8 and build123d 0.13 use separate environments.
MUST Keep rough-to-detailed iteration: concepts establish direction, layout freezes interfaces and envelopes, parts precede fits and drawings, and release follows verification and critique.
MUST Keep formula types distinct: pour `cad-touch`, `cad-part`, or `cad-product`; bond only the `mol-` formulas, each worker molecule onto its stage's fan-out step.
MUST Dispatch every ready unit of a stage in the same parallel batch; never run a listed unit yourself or one worker after another.
MUST Own the shared record yourself: `product.yaml`, `requirements.yaml`, `assembly.yaml`, `interfaces.yaml`, `bom.csv`, `verification.csv`, `decisions/`, the concept scene, every `hw/versions/` build, renders, integrated drawings, gates, Beads writes, and every question to the user. A worker writes only `.cad-work/<unit>/`; a part designer also replaces its own `hw/parts/<PN>/` through `scratch.py deliver`. Give each PN to exactly one unit.
MUST Give every file you mention, in any report, question, gate, or summary, as an absolute path on its own line: records, decisions, model.py, STEP and GLB, check JSON, renders, captures, drawings, and the BOM. Add the URL of the live viewer or preview gallery while one runs.
MUST In release, integration, and gate reports, present print/make files, parts to buy (designation/order codes and OPEN identities with reasons), assembly steps, and checks as structured lists or tables. Give every file path as its own absolute-path line; never report buy or assembly items in inline comma prose.
NOT Claim a design is checked because it was previewed or because an unchanged part passed an earlier run.
MUST Resolve `skill://<name>/` to the base directory of the named skill when running `uv run --script` commands on non-OMP harnesses; OMP resolves the URI directly.

