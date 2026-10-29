# CAD flow reference

## Stages, gates, and durable outputs

Keep the source of truth in the hardware project's `hw/` design record. `cad-record/references/layout.md` is the generated canonical path table; commands that consume path locations use the `cad-record/references/layout-api.md` API. Every decision, requirement, interface, revision, check result, and release artifact must identify its source or evidence. Preserve millimetres and the product's declared ISO or ASME regime. Stage ordering is intentional: do not detail parts before the layout freezes their interfaces, or release before analysis and critique are reconciled.

| Stage | Work and user gate | Design-record output | Skill / command |
|---|---|---|---|
| GROUND | Inspect needs and existing hardware; on an existing project run `validate.py PROJECT --migration-plan` before freezing. | Product identity, rigor, units, regime, tolerances; initial requirements and interface evidence. The migration plan is read-only; nothing is moved. | `cad-record`: `uv run --script skill://cad-record/scripts/validate.py <project-dir> [--migration-plan]` |
| INTENT | Present purpose, users, envelope, constraints, unknowns; wait for approval. | Approved intent, requirement sources, rationales, priorities, and gate decision. | `cad-record`: validate project |
| SPECIFY | Set measurable requirements and verification criteria. | Requirements with rationale, source, priority, verification method and criteria; updated interfaces. | `cad-record`: validate project |
| concept | One `cad-concept-designer` per variant drafts 2-4 rapid three.js variants in one batch; merge them, then refine, merge, or drop by feedback. | Scene, options and selection in a decision record. Preview is not verified CAD. | `cad-concept`: `concept.py check <scene>`; handoff: `concept.py handoff <scene>` |
| VARIANT gate | Get explicit concept selection. | Selected concept and gate evidence in workflow record and decision. | `cad-concept`: checked handoff |
| layout | Define subassemblies, interfaces, joints/limits, BOM skeleton. | Assembly and interfaces; preliminary EBOM. | `cad-record`: validate. `cad-model run hw --label vN`, then `cad-model check vN --hw hw`. `cad-render hw --version vN`. Once a joint moves, `cad-motion` `motion.py render --hw hw --version vN --case default --outputs glb,sheet`. |
| LAYOUT freeze | Present layout, interfaces, BOM skeleton, and the default motion render for approval. | Frozen decision and gate evidence; `flow.recheck_from: layout`. | `cad-viewer`: serve, show version and compare checks; `viewer.py animate --case default` plays the motion. |
| parts | One `cad-part-designer` per subassembly and one `cad-sourcing-researcher` per purchased family, in one batch; build one integrated version; PARTS gate. | Part records and models; PN, revision, material, process, finish, mass target, make/buy, supplier. | Run build, check, render and `cad-design form_check.py --hw hw --parts-dir <version parts> --fidelity F2`. |
| detail | One `cad-part-designer` per made part applies fits, fasteners, tolerances, and process rules in one batch. Build, check, and draw one integrated version for the DETAIL gate. | Part revisions, fit decisions, drawings, and evidence. | `cad-fits`; `cad-design form_check.py` at F3; `cad-drawings` publishes each part drawing for that version. |
| bom | Reconcile part numbers, revisions, quantities, make/buy, suppliers, and assemblies. | Released-intent EBOM. | `cad-bom`: `bom.py --hw hw` or `bom.py --version vN --hw hw` to reconcile against a version snapshot. |
| analysis | One `cad-analyst` per case checks interference, clearance, stack-up, kinematics, static FEA at the worst pose, or a motion case, in one batch; FEA at the worst pose follows the sweep; ANALYSIS gate. | Verification tied to requirements/configurations; analysis artifacts and assumptions; accepted motion cases in `hw/motion/cases/<case>/plan.yaml`. | Use `cad-motion`, `cad-analysis` and `cad-fits` on the selected version. Case results publish through cad-record layout; verification links identify the versioned evidence bundle. The lead publishes an accepted motion plan with `motion.py render --hw hw --version vN --case <case> --outputs glb,sheet,video`; a record with coupled joints adds `--crosscheck freecad` and a verification row from `crosscheck.json`, where only `solved` joints count as independent evidence. |
| critique | Spawn mechanical and DFM reviewers in one parallel read-only batch. | Preserve both verdicts and evidence in workflow record. Neither reviewer waits for the other. | `cad-review-mech`; `cad-review-dfm` |
| reconcile | Resolve critique findings. Rerun affected checks. | Updated decisions, verification, revisions, dispositions. | `cad-flow`; `cad-recheck` stamps the exact staged `hw/` tree only after checks pass. |
| design_freeze | Present reconciled design, analyses, and record for approval. | Frozen anchor pins the exact built version and its manifest hash. | `cad-record`: validate project and confirm every custom-made part has complete manufacturing outputs. |
| RELEASE gate | Show the frozen version, the revision letter to issue, its contents and verification. Get approval before release. | Gate decision, recorded as the release approval `decisions/DR-###`. | `cad-record`: `validate.py` and the structured checks. |
| release | After approval, seal the traceable release package. | Immutable release package with definitions, manufacturing outputs, selected bundles, EBOM, verification, and docs. | `cad-record`: `release.py HW --rev A --version vN --decision DR-###`; a missing/stale/failing item refuses and seals nothing. Never reuse a revision. |
When a stage starts the CAD viewer, keep it available through that stage's review. When the stage is complete, tell the user its URL is going away, then run the exact `stop` command printed by `serve` and record `ports_free` before ending the stage.

The canonical `product.yaml` stage enum uses lowercase values: `ground`, `intent`, `specify`, `concept`, `layout`, `parts`, `detail`, `bom`, `analysis`, `critique`, `reconcile`, `design_freeze`, `release`. Prose may use uppercase or L0 to L4; record values use these enum strings.

The full endpoint is STEP AP242 plus drawings, EBOM, verification matrix, and docs. Designs target FDM or CNC, but stop before slicing, CAM, or machine-tool generation. FreeCAD 1.1.4 is the only CAD application. CadQuery 2.8 and build123d 0.13 each run in a separate environment. See `cad-record/references/layout.md` for the project paths and bundle inventory.

## Stage loop and recheck boundary

Draft, show live previews, and collect feedback. Continue until the user says “commit” or “commit batch”. Do not check on every edit.
 - Each L1-L4 commit batch runs `cad-model run`, then `cad-model check`. Stop on any blocking failure. Render that exact version and show its images at the stage gate.
- An explicit check output is a new path under `.cad-work/`; generated version and producer paths come from the cad-record layout API.
- The user's commit, the layout threshold, or the hardware git pre-commit hook triggers broader changed-parts/dependents recheck. Use `flow.recheck_from` and applicable earlier-stage checks; stamp the exact staged `hw/` only after every required check passes.
- Record changed items, dependents, checks, results, and artifacts. A later edit starts a new batch on the next commit.
- After DESIGN freeze, reopen only affected parts and dependents. Preserve unaffected parts and their evidence. Before another release, build a new version and re-freeze its exact manifest anchor.
- Before using `uv run --script skill://<name>/scripts/...` on a non-OMP harness, resolve `skill://<name>/` to that skill's base directory; OMP resolves the URI directly.
- A preview or render is not a check result. Tie reported checks to a design revision/configuration.

Once a version has an independent movable joint, each commit batch also runs the default motion render beside cad-render: `uv run --script skill://cad-flow/scripts/run.py cad-motion/scripts/motion.py render --hw hw --version vN --case default --outputs glb,sheet`. Only the contact-sheet tiles render, so it takes seconds to a minute. Exit 1, a coverage gap or a limit finding, blocks the gate; exit 2 is no result. The LAYOUT freeze gate shows:

```text
L1 MOTION RENDER vN default: PASS|FLAGGED|FAIL, {frames} frames, {segments} segments, {timings_s.total} s
   Coverage -- {summary}
   Files -- {contact-sheet.png absolute path}, {motion.glb absolute path}
```

## Delegation

The lead orchestrates; workers do the independent units of a stage in parallel. One stage runs as: fan out every unit, dispatch all of them in one parallel batch, integrate their results once, build one version, present one gate. Gates belong to stages, not molecules, and only the lead builds `hw/versions/`.

| Fan-out step | Molecule and variables | Unit id | Agent | Worker writes |
|---|---|---|---|---|
| `concept-fanout`, `mol-cad-concept` `round-fanout` | `mol-cad-variant`: `variant`, `tradeoff` | `variant-<id>` | `cad-concept-designer` | `.cad-work/variant-<id>/<id>.scene.json` |
| `parts-fanout` | `mol-cad-part`: `subassembly`, `change`, `kernel`, `process_default` | `part-<subassembly>` | `cad-part-designer` | `.cad-work/part-<subassembly>/`, then its own `hw/parts/<PN>/` through `scratch.py deliver` |
| `parts-fanout` | `mol-cad-sourcing`: `family`, `parts` | `source-<family>` | `cad-sourcing-researcher` | nothing |
| `detail-fanout`; `cad-touch` `revise-fanout`; `mol-cad-iterate` `reopen-fanout` | `mol-cad-detail`: `part`, `change`, `kernel`, `process_default` | `detail-<PN>` | `cad-part-designer` | `.cad-work/detail-<PN>/`, then `hw/parts/<PN>/` through `scratch.py deliver` |
| `analysis-fanout` | `mol-cad-analysis`: `case`, `kind`, `version` | `analysis-<case>` | `cad-analyst` | `.cad-work/analysis-<case>/` |
| `mech-critique`, `dfm-critique` root steps | none | none | `cad-mech-reviewer`, `cad-dfm-reviewer` | nothing |

Every molecule also takes `product` and `scope`. The lead owns everything else: `product.yaml`, `requirements.yaml`, `assembly.yaml`, `interfaces.yaml`, `bom.csv`, `verification.csv`, `decisions/`, the concept scene, every `hw/versions/` build, renders, drawings of integrated versions, gates, Beads writes, and every question to the user. A part designer's hold on `hw/parts/<PN>/` ends with its batch; after that, the lead edits part records too, such as adopting sourcing values. Give each PN to exactly one unit in a batch.

### Batch with Beads

1. At the fan-out step, list the units from the record: subassemblies from `assembly.yaml`, purchased families from `bom.csv` rows with `make_buy` `buy`, made parts, analysis cases. Bond every molecule onto the fan-out step before dispatching any: `bd mol bond <molecule> <fan-out-step> --type parallel --ref <unit> --var product=<id> --var scope=hw/ ...`. Beads 1.3.1 applies variable defaults on `pour` but not on `bond`, so pass every variable the molecule declares.
2. `bd ready --json` now lists the batch: the ready steps below the fan-out step whose `metadata.execution_mode` is `subagent`. `metadata.execution_agent_type` names the agent. Dispatch all of them in one subagent call or message, one worker per molecule; a worker carries every step of its molecule.
3. Only the lead writes the ledger. When a worker returns, close its molecule's steps with the evidence as the reason, then the molecule root `<fan-out-step>.<unit>`. A failed or `BLOCKED` unit stays open: remove the cause, such as by applying the shared-record change it proposed, then dispatch it again in the next batch.
4. Close the fan-out step once every child is closed; Beads refuses earlier. The integration step waits for all of them (`waits_for = "all-children"`) and becomes ready next.

A static FEA case at the worst-case pose needs the sweep's `worst_case`. Bond and dispatch those cases as a second batch, once the sweep molecule closes; every other L4 case runs in the first batch.

### Batch without Beads

The units, briefs, and ownership are the same. Keep the unit list and each unit's state in your plan, dispatch every unit of the stage in one subagent call or message, and integrate when all of them return. Gates follow Gate control.

### Brief

Each worker's brief is self-contained. It names:

- the unit id, and the molecule step text or, without Beads, the same instruction;
- the PNs, variant, or case the unit owns; a motion case also names the requirements and use cases its plan must show;
- the inputs as absolute paths (record files, version label, frozen interfaces, shared node ids), plus kernel and fidelity;
- the write boundary, and that the worker asks the user nothing and writes no ledger entry;
- the report format, which gives every file as an absolute path.

### Integrate

Read every report of the batch before you change anything. Accept a part delivery only when its scratch build passed; otherwise dispatch the unit again. Decide each proposal: apply an accepted one to the shared record yourself, and record why a declined one was declined. Merge concept variants into the scene, adopt cited sourcing values, write verification rows from analysis results, and copy an accepted motion plan to `hw/motion/cases/<case>/plan.yaml` before publishing it. Then run the stage's commit batch once on `hw/`; at L2 and L3 that is `cad-model run` and `check`, the form check, the render, the L3 drawings, and the recheck. Present the stage gate with the absolute path of every file it shows.

### Scratch workspace

A part designer works in `.cad-work/<unit>/` next to `hw/`; `scratch.py` writes a `.gitignore` there so git ignores the directory.

- `uv run --script skill://cad-flow/scripts/scratch.py init --hw hw --unit <unit> --part <PN> [--part <PN> ...]` copies `hw/` without `versions/`, `renders/`, `releases/`, or `.git/` and records a baseline.
 - `scratch.py deliver --hw hw --unit <unit>` accepts only canonical source files under authorized part records (including a PN authorized at `init`), rejects generated subtrees, stray paths and unauthorized PNs, and writes nothing when a conflict is detected. The lead integrates the returned part files only after the passing scratch build.

Every path in its JSON output is absolute. `.cad-work/` is disposable once the stage gate passes.

## Gate control

Gates remain open until explicit user approval is recorded through `bd gate resolve`. Never infer approval from silence, a preview, a successful build, an agent verdict, or a release artifact. If the current harness or workspace cannot resolve the gate through that command, leave it open and hand the gate to someone who can; do not substitute another gate-closing mechanism.

Every gate report, question, and summary gives each file it mentions as an absolute path on its own line: records, decisions, model.py, STEP and GLB, check JSON, renders, captures, drawing previews and PDFs, and the BOM. A relative path such as `hw/renders/v2/iso.png` is not enough. Add the URL of the live viewer or preview gallery while one runs.
