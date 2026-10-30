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
   Before the first build, ask the user explicitly whether generated results (STEP, GLB, renders, check bundles) are stored in git, and record the answer as `product.yaml` `storage.results_in_git` with a DR. Then run `uv run --script skill://cad-flow/scripts/setup.py --storage --yes` from the project root; it writes the git rules for that answer, and again whenever the answer changes. Only `true` tracks them, with Git LFS for STEP and GLB; with `false` they stay out of git and the record remains valid. While the setting is absent, commit no generated result.
   At INTENT, record the planned processes as `product.yaml` `manufacturing.processes` and ask whether each process and material can meet each appearance or property requirement: a transparent part printed in FDM is a known contradiction. Resolve each `feasibility.*` finding of `validate.py` with a DR and a record change before L1 LAYOUT.
3. Lead the stages in order: GROUND, INTENT, SPECIFY, L0 CONCEPT, VARIANT gate, L1 LAYOUT, LAYOUT freeze, L2 PARTS, PARTS gate, L3 DETAIL, DETAIL gate, BOM, L4 ANALYSIS, ANALYSIS gate, CRITIQUE, RECONCILE, DESIGN freeze, RELEASE gate, RELEASE. Use the stage-enum spellings in `references/flow.md`; do not skip a gate or freeze. Run `release.py` only after the RELEASE gate approves, with that approval recorded as its `DR-###`.
   Each L1-L4 gate is two gates: a provisional gate you resolve once the version passed every fast check, then the full check, then the human gate. The next stage may start after the provisional gate; nothing is frozen or released before the human gate. LOAD `references/flow.md` "Gate control" before the first L1 build.
   At L0 CONCEPT, follow `skill://cad-concept/` for launching and stopping the concept viewer.
4. Delegate every stage the Delegation table lists: one worker per unit, all of the stage's units in one parallel batch, then one integration by you and the stage's gates. Do every other stage yourself. LOAD `references/flow.md` "Delegation" before the first batch.
5. At each stage, draft and preview without checks; collect feedback before commit. Each L1-L4 batch builds a new immutable version with `cad-model run` and checks it in the fail-fast order of `references/flow.md`: (1) the build, `validate.py` (record, retention and feasibility rules) and from L2 the form check; (2) `cad-model check --changed-only`; (3) once a joint moves, the smoke sweep (`sweep.py --smoke --changed-only`); (4) renders, the default motion render once a joint moves, and the visibility check; (5) after the provisional gate, the full check: `cad-model check` over every pair and the full sweep with its between-sample check. Run steps 1-4 in parallel where they do not depend on each other; any blocking failure stops the batch. Pass any explicit check output as a new path under `.cad-work/`. A coverage gap or limit finding of the motion render blocks the gate. Read `cad-record/references/layout.md` and use its API for every version or producer path.
   At L1, lay out each clearance at its required minimum plus the margin (`design.clearance_margin_mm`, 0.1 mm when absent, or the interface's `margin_mm`): 0.5 mm required is 0.6 mm designed.
   Run every long job (the full sweep, a FreeCAD assembly run, FEA, a new tool) as a smoke run first, then in the background; wait for its result file, not its process. Prepare the gate packet while it runs.
6. Before PARTS, `cad-design form_check.py` must pass on the integrated version at F2; before DETAIL, at F3. Each made part needs the required fidelity. At L4, use the producer commands to publish version-bound evidence bundles; all version inputs come from the `record/` snapshot, and any explicit output override is a new `.cad-work/` path. Never publish to ad-hoc directories.
7. At L3 DETAIL and release, use `cad-drawings` to draft, review and publish drawings for a selected version. Follow its documented CLI and scratch-output options; rejected drafts remain scratch. Record accepted drawing checks in `verification.csv`.
8. On COMMIT, record the design entry and bead note with batch, changes, artifacts, checks, and outcomes. If the user wants more detail, continue in the stage. Otherwise show renders and present the stage's gates.
   When the cad-recheck hook is not installed (`install-hook.py` exits 3 because `core.hooksPath` is managed outside the repository, or 2), run `uv run --script skill://cad-recheck/scripts/stamp.py --verify` from the project directory after staging each commit of `hw/` changes. Exit 2 means do not commit: fix the reason on stderr and verify again.
9. Keep gate evidence in the design record. Close a provisional gate yourself only with its fast-check evidence, its reason marked PROVISIONAL. A failing full check, a MAJOR light-review finding, or a change named at the human gate voids it, also after the full check closed: reopen the stage's integrate, provisional and full-check steps and every closed later step built on that version, as `references/flow.md` "Gate control" lists. List the sweep's unproved between-sample intervals at the human gate; the user accepts them with a DR or asks for a finer run. Close a human gate only with `bd gate resolve` after explicit user approval.
10. Finish at a CAD-only release: STEP AP242, drawings, EBOM, verification matrix, and documentation. Do not produce slicer, CAM, or machine-tool output.

## Delegation

| Stage | One worker per | Agent | You integrate |
|---|---|---|---|
| L0 CONCEPT | variant, 2-4 | `cad-concept-designer` | Merge the variants into the scene, check it, and run the preview |
| L2 PARTS | subassembly; purchased family; light review | `cad-part-designer`; `cad-sourcing-researcher`; `cad-mech-reviewer` and `cad-dfm-reviewer` | Apply accepted proposals, then build and fast-check one version; run the light review beside its full check |
| L3 DETAIL | made part | `cad-part-designer` | Apply accepted fit proposals, then build, F3-check, render, and draw one version |
| L4 ANALYSIS | case: sweep, FreeCAD assembly, stack-up, FEA, motion; the joint sweep and FEA at its worst pose run as the full check | `cad-analyst` | Write the verification rows, publish accepted motion cases, and render the analysed version |
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
MUST Run each L1 to L4 commit batch as `uv run --script skill://cad-flow/scripts/run.py cad-model/scripts/cad_model.py run hw --label vN [--kernel auto] [--attach REF=PARENT_REF ...]`, then the fast checks of `references/flow.md` "Fail-fast check order": `validate.py`, the form check from L2, `uv run --script skill://cad-flow/scripts/run.py cad-model/scripts/cad_model.py check vN --hw hw --changed-only [--since-version vM] [--out FILE]`, once a joint moves `uv run --script skill://cad-flow/scripts/run.py cad-motion/scripts/sweep.py --hw hw --version vN --smoke --changed-only`, and `uv run --script skill://cad-flow/scripts/run.py cad-render/scripts/render.py hw [--version latest|vN] [--views iso front side exploded closeup-<PN>]` for the same version, which also runs the visibility check and exits 1 when a `visibility` binding fails (results in `render.json` `visibility`). Give part and detail workers the same `--attach` entries for their `scratch.py build`. Press fits declared in `hw/interfaces.yaml` are automatically allowed and a blocking check failure stops the batch. Once the version has an independent movable joint, also run `uv run --script skill://cad-flow/scripts/run.py cad-motion/scripts/motion.py render --hw hw --version vN --case default --outputs glb,sheet`; exit 1, a coverage gap or limit finding, blocks the gate, and exit 2 is no result. After the provisional gate, run the full check: `cad_model.py check vN --hw hw` over every pair and, once a joint moves, `sweep.py --hw hw --version vN` with its between-sample check.
MUST Use FreeCAD 1.1.4 as the CAD application. CadQuery 2.8 and build123d 0.13 use separate environments.
MUST Keep rough-to-detailed iteration: concepts establish direction, layout freezes interfaces and envelopes, parts precede fits and drawings, and release follows verification and critique.
MUST Keep formula types distinct: pour `cad-touch`, `cad-part`, or `cad-product`; bond only the `mol-` formulas, each worker molecule onto its stage's fan-out step.
MUST Dispatch every ready unit of a stage in the same parallel batch; never run a listed unit yourself or one worker after another.
MUST Own the shared record yourself: `product.yaml`, `requirements.yaml`, `assembly.yaml`, `interfaces.yaml`, `bom.csv`, `verification.csv`, `decisions/`, the concept scene, every `hw/versions/` build, renders, integrated drawings, gates, Beads writes, and every question to the user. A worker writes only `.cad-work/<unit>/`; a part designer also replaces its own `hw/parts/<PN>/` through `scratch.py deliver`. Give each PN to exactly one unit.
MUST Give every file you mention, in any report, question, gate, or summary, as an absolute path on its own line: records, decisions, model.py, STEP and GLB, check JSON, renders, captures, drawings, and the BOM. Add the URL of the live viewer or preview gallery while one runs.
MUST In release, integration, and gate reports, present print/make files, parts to buy (designation/order codes and OPEN identities with reasons), assembly steps, and checks as structured lists or tables. Give every file path as its own absolute-path line; never report buy or assembly items in inline comma prose.
NOT Claim a design is checked because it was previewed or because an unchanged part passed an earlier run.
NOT Count a changed-only check, a smoke sweep, or a provisional gate as a full check, verification evidence, or user approval; never freeze or release on one.
MUST Resolve `skill://<name>/` to the base directory of the named skill when running `uv run --script` commands on non-OMP harnesses; OMP resolves the URI directly.

