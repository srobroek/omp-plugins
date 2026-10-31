# CAD flow reference

## Stages, gates, and durable outputs

Keep the source of truth in the hardware project's `hw/` design record. `cad-record/references/layout.md` is the generated canonical path table; commands that consume path locations use the `cad-record/references/layout-api.md` API. Every decision, requirement, interface, revision, check result, and release artifact must identify its source or evidence. Preserve millimetres and the product's declared ISO or ASME regime. Stage ordering is intentional: do not detail parts before the layout freezes their interfaces, or release before analysis and critique are reconciled.

| Stage | Work and user gate | Design-record output | Skill / command |
|---|---|---|---|
| GROUND | Inspect needs and existing hardware; on an existing project run `validate.py PROJECT --migration-plan` before freezing. Ask whether generated results are stored in git ([Storage of generated results](#storage-of-generated-results)). | Product identity, rigor, units, regime, tolerances; initial requirements and interface evidence; `storage.results_in_git`. The migration plan is read-only; nothing is moved. | `cad-record`: `uv run --script skill://cad-record/scripts/validate.py <project-dir> [--migration-plan]` |
| INTENT | Present purpose, users, envelope, constraints, unknowns, the planned processes, and whether each process and material can meet each appearance or property requirement (a transparent part printed in FDM is a known contradiction); wait for approval. | Approved intent, `manufacturing.processes`, requirement sources, rationales, priorities, feasibility decisions, and gate decision. | `cad-record`: validate project; resolve each `feasibility.*` finding with a DR and a record change |
| SPECIFY | Set measurable requirements and verification criteria. | Requirements with rationale, source, priority, verification method and criteria; updated interfaces. | `cad-record`: validate project |
| concept | One `cad-concept-designer` per variant drafts 2-4 rapid three.js variants in one batch; merge them, then refine, merge, or drop by feedback. | Scene, options and selection in a decision record. Preview is not verified CAD. | `cad-concept`: `concept.py check <scene>`; handoff: `concept.py handoff <scene>` |
| VARIANT gate | Get explicit concept selection. | Selected concept and gate evidence in workflow record and decision. | `cad-concept`: checked handoff |
| layout | Define subassemblies, interfaces, joints/limits, BOM skeleton. Lay out each clearance at its minimum plus the [clearance margin](#clearance-margin). | Assembly and interfaces; preliminary EBOM. | `cad-record`: validate. Each version runs the [fail-fast checks](#fail-fast-check-order), then the full check. |
| LAYOUT freeze | Provisional gate after the fast checks; L2 may start. Human gate after the full check: present layout, interfaces, BOM skeleton, and the default motion render for approval. | Provisional and frozen decisions with gate evidence; `flow.recheck_from: layout`. | `cad-viewer`: serve, show version and compare checks; `viewer.py animate --case default` plays the motion. |
| parts | One `cad-part-designer` per subassembly and one `cad-sourcing-researcher` per purchased family, in one batch; build one integrated version; a light mechanical and DFM review runs beside its full check; PARTS gates. | Part records and models; PN, revision, material, process, finish, mass target, make/buy, supplier; torque paths and axial retainers. | Fail-fast checks with `cad-design form_check.py --hw hw --parts-dir <version parts> --fidelity F2`; `cad-mech-reviewer` and `cad-dfm-reviewer` for the light review. |
| detail | One `cad-part-designer` per made part applies fits, fasteners, tolerances, and process rules in one batch. Build and check one integrated version, and draw it while its full check runs, for the DETAIL gates. | Part revisions, fit decisions, drawings, and evidence. | `cad-fits`; `cad-design form_check.py` at F3; `cad-drawings` publishes each part drawing for that version. |
| bom | Reconcile part numbers, revisions, quantities, make/buy, suppliers, and assemblies. | Released-intent EBOM. | `cad-bom`: `bom.py --hw hw` or `bom.py --version vN --hw hw` to reconcile against a version snapshot. |
| analysis | One `cad-analyst` per case checks interference, clearance, stack-up, kinematics, static FEA, or a motion case, in one batch. The joint sweep, then FEA at its worst pose, run as the stage's full check; ANALYSIS gates. | Verification tied to requirements/configurations; analysis artifacts and assumptions; accepted motion cases in `hw/motion/cases/<case>/plan.yaml`. | Use `cad-motion`, `cad-analysis` and `cad-fits` on the selected version. Case results publish through cad-record layout; verification links identify the versioned evidence bundle. The lead publishes an accepted motion plan with `motion.py render --hw hw --version vN --case <case> --outputs glb,sheet,video`; a record with coupled joints adds `--crosscheck freecad` and a verification row from `crosscheck.json`, where only `solved` joints count as independent evidence. |
| critique | Spawn mechanical and DFM reviewers in one parallel read-only batch; it may start on the provisional ANALYSIS gate, while the full check runs. | Preserve both verdicts and evidence in workflow record. Neither reviewer waits for the other. | `cad-review-mech`; `cad-review-dfm` |
| reconcile | Resolve critique findings. Rerun affected checks. | Updated decisions, verification, revisions, dispositions. | `cad-flow`; `cad-recheck` stamps the exact staged `hw/` tree only after checks pass. |
| design_freeze | After every stage's human gate, present reconciled design, analyses, and record for approval. | Frozen anchor pins the exact built version and its manifest hash. | `cad-record`: validate project and confirm every custom-made part has complete manufacturing outputs. |
| RELEASE gate | Show the frozen version, the revision letter to issue, its contents and verification. Get approval before release. | Gate decision, recorded as the release approval `decisions/DR-###`. | `cad-record`: `validate.py` and the structured checks. |
| release | After approval, seal the traceable release package. | Immutable release package with definitions, manufacturing outputs, selected bundles, EBOM, verification, and docs. | `cad-record`: first `build_guide.py hw --version vN --rev A --date YYYY-MM-DD --out hw/docs` (the UTC date of the release run), then `release.py HW --rev A --version vN --decision DR-###`; a missing/stale/failing item refuses and seals nothing. Never reuse a revision. Add `--prune` to print the plan of superseded versions once A is sealed (a rerun on a sealed A skips sealing); show the user its `keep` reasons and `remove` list, then rerun with `--prune --yes <digest>`. Only versions older than vN go; released, latest, frozen, change-baseline, DR-named and manifest-referenced versions stay. `prune_incomplete` means rerun the same `--yes` command to finish; it also runs `cad_model.py store gc`. |
When a stage starts the CAD viewer, keep it available through that stage's review. When the stage is complete, tell the user its URL is going away, then run the exact `stop` command printed by `serve` and record `ports_free` before ending the stage.

The canonical `product.yaml` stage enum uses lowercase values: `ground`, `intent`, `specify`, `concept`, `layout`, `parts`, `detail`, `bom`, `analysis`, `critique`, `reconcile`, `design_freeze`, `release`. Prose may use uppercase or L0 to L4; record values use these enum strings.

The full endpoint is STEP AP242 plus drawings, EBOM, verification matrix, and docs. Designs target FDM or CNC, but stop before slicing, CAM, or machine-tool generation. FreeCAD 1.1.4 is the only CAD application. CadQuery 2.8 and build123d 0.13 each run in a separate environment. See `cad-record/references/layout.md` for the project paths and bundle inventory.

## Stage loop and recheck boundary

Draft, show live previews, and collect feedback. Continue until the user says “commit” or “commit batch”. Do not check on every edit.
- Each L1-L4 commit batch builds one version and checks it in the [fail-fast order](#fail-fast-check-order). Stop on any blocking failure. Show that exact version's renders at the stage gates.
- An explicit check output is a new path under `.cad-work/`; generated version and producer paths come from the cad-record layout API.
- The user's commit, the layout threshold, or the hardware git pre-commit hook triggers broader changed-parts/dependents recheck. Use `flow.recheck_from` and applicable earlier-stage checks; stamp the exact staged `hw/` only after every required check passes.
When the cad-recheck pre-commit hook is absent, verify each staged `hw/` tree before committing. Install it with `install-hook.py --project <project-directory>`. The installer exits 3 when the system or global git config sets `core.hooksPath`, as Git Defender does. It exits 2 on another refusal. These exits leave the hook uninstalled. From the project directory, run `uv run --script skill://cad-recheck/scripts/stamp.py --verify` after staging. Exit 0 permits the commit. Exit 2 means do not commit; fix stderr's reason, restamp, and verify again.
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

### Clearance margin

Lay out every clearance at its required minimum plus the margin: the interface's `margin_mm`, else `product.yaml` `design.clearance_margin_mm` (0.1 mm when absent). A 0.5 mm minimum is laid out at 0.6 mm. A measured clearance at or above the minimum but inside the margin is a `margin` warning, never a failure; below the minimum it fails.

## Fail-fast check order

Check each version a commit batch builds cheapest first. Steps 1-4 are the fast checks; step 5 is the full check. Start each fast check once its input exists and run independent ones in parallel: `validate.py` reads only the record, so it runs beside the build; the form check and steps 2-4 need the built version and run in parallel once it exists. Read the results in step order. A failure stops the batch: stop the fast checks still running by their process groups, fix the cause, and build the next version. Never start step 5 on a version with a failed fast check. Run each command through `skill://cad-flow/scripts/run.py` as `skill://cad-flow` shows.

1. Build the changed parts: `cad-model run hw --label vN`. Run the record validator, `validate.py <project-dir>`. From `parts` on it reports as errors the retention rules (`retention.torque_path`, which includes a revolute joint without `torque: transmitted|none`, and `retention.axial_retainer`) and an FDM part declared `transparency: transparent` (`feasibility.transparent_fdm`). A see-through claim in prose (`feasibility.transparency_claim`) stays a warning at every stage; resolve it at INTENT. From L2, run `form_check.py --hw hw --parts-dir <version parts> --fidelity F2` (F3 at L3); it applies the DFM rules, such as each process's minimum wall (`product.yaml` `manufacturing.min_wall_mm`).
2. Static interference on the changed pairs: `cad-model check vN --hw hw --changed-only [--since-version vM]`. The baseline defaults to the previous built version; without one, every pair is selected.
3. Once the version has an independent movable joint, the smoke sweep on the changed pairs: `cad-motion/scripts/sweep.py --hw hw --version vN --smoke --changed-only [--since-version vM]`. It samples every 60 degrees of each revolute range plus its endpoints, and each TDC and dwell event.
4. Renders: `cad-render/scripts/render.py hw --version vN`, which also runs the visibility check of each `visibility` binding in `requirements.yaml`. It exits 1 when a binding fails; each target must reach the binding's `min_visible_fraction` on its own, and `render.json` `visibility` holds the results, summarised as `visibility.<REQ>/<index>`. Once a joint moves, also the default motion render.
5. The full check, after the provisional gate: `cad-model check vN --hw hw` over every pair and, once a joint moves, the full sweep `cad-motion/scripts/sweep.py --hw hw --version vN` with its between-sample check, which runs by default. Gate evidence never uses `--no-continuous` or `--no-spot-check`. Both are [long jobs](#long-jobs). A between-sample finding (`continuous.status: finding`, exit 1) fails the full check. Intervals the check could not prove (`continuous.status: incomplete`, with a `check: continuous` warning) leave the sweep passing: list `continuous.collision_free_unproved_intervals` and `continuous.clearance_unproved_pairs` in the gate packet for the user to decide at the human gate.

A changed-only check or a smoke sweep is fast-check evidence only. Its result reports an incomplete scope (the static check's `scope.complete: false`) and never counts as a full check, a full assembly pass, or verification evidence. The pair cache makes unchanged pairs cheap in step 5; never skip step 5 because an earlier version passed it.

## Long jobs

The full sweep, a FreeCAD assembly run, an FEA case, and the first run of a new tool are long jobs.

- Smoke first: run the sweep with `--smoke` before the full sweep, a FreeCAD run on its first few frames, and a new tool on a tiny fixture. Start the full run only after its smoke run passed.
- Before starting, check for stray runs: a sweep refuses while a recorded process group still runs and prints the `kill -TERM -- -PGID` command. Stop a run by its process group, never by its parent PID.
- Run it in the background and wait for its result file, such as the sweep's `result.json` in its version bundle or the check's `--out` file, not for its process or shell. A run that ended without its result file produced no result; rerun it.
- While it runs, prepare the gate packet ([Gate control](#gate-control)).

## Storage of generated results

Before the first build, ask the user explicitly whether generated results (STEP, GLB, renders and check bundles) are stored in git. Record the answer as `product.yaml` `storage.results_in_git` with a DR. Then run `uv run --script skill://cad-flow/scripts/setup.py --storage --yes` from the project root. It writes the rules for the answer into `hw/.gitignore` or `hw/.gitattributes` (cad-record `references/layout.md` "Git storage"); run it again whenever the answer changes. Only `true` tracks them, with Git LFS for STEP and GLB. With `false` they stay out of git, and the record remains valid. While the setting is absent the question is open: ask it, and commit no generated result.

A `.gitignore` untracks nothing. When git already tracks results and the answer is not `true`, setup lists those paths. The user stops tracking them with `git rm -r --cached <path>` (the files stay on disk) and a commit; never run it yourself. With `true`, setup never runs `git lfs` either: the user installs Git LFS and runs `git lfs install` once per clone.

## Delegation

The lead orchestrates; workers do the independent units of a stage in parallel. One stage runs as: fan out every unit, dispatch all of them in one parallel batch, integrate their results once, build one version, present the stage's gates. Gates belong to stages, not molecules, and only the lead builds `hw/versions/`.

| Fan-out step | Molecule and variables | Unit id | Agent | Worker writes |
|---|---|---|---|---|
| `concept-fanout`, `mol-cad-concept` `round-fanout` | `mol-cad-variant`: `variant`, `tradeoff` | `variant-<id>` | `cad-concept-designer` | `.cad-work/variant-<id>/<id>.scene.json` |
| `parts-fanout` | `mol-cad-part`: `subassembly`, `change`, `kernel`, `process_default` | `part-<subassembly>` | `cad-part-designer` | `.cad-work/part-<subassembly>/`, then its own `hw/parts/<PN>/` through `scratch.py deliver` |
| `parts-fanout` | `mol-cad-sourcing`: `family`, `parts` | `source-<family>` | `cad-sourcing-researcher` | nothing |
| `detail-fanout`; `cad-touch` `revise-fanout`; `mol-cad-iterate` `reopen-fanout` | `mol-cad-detail`: `part`, `change`, `kernel`, `process_default` | `detail-<PN>` | `cad-part-designer` | `.cad-work/detail-<PN>/`, then `hw/parts/<PN>/` through `scratch.py deliver` |
| `analysis-fanout` | `mol-cad-analysis`: `case`, `kind`, `version` | `analysis-<case>` | `cad-analyst` | `.cad-work/analysis-<case>/` |
| `analysis-full-check` | `mol-cad-analysis`: the joint sweep (`kind=sweep`), then FEA at its worst pose | `analysis-<case>-<vN>` | `cad-analyst` | `.cad-work/analysis-<case>/` |
| `parts-mech-review`, `parts-dfm-review` root steps (L2 light review) | none | none | `cad-mech-reviewer`, `cad-dfm-reviewer` | nothing |
| `mech-critique`, `dfm-critique` root steps | none | none | `cad-mech-reviewer`, `cad-dfm-reviewer` | nothing |

Every molecule also takes `product` and `scope`. The lead owns everything else: `product.yaml`, `requirements.yaml`, `assembly.yaml`, `interfaces.yaml`, `bom.csv`, `verification.csv`, `decisions/`, the concept scene, every `hw/versions/` build, renders, drawings of integrated versions, gates, Beads writes, and every question to the user. A part designer's hold on `hw/parts/<PN>/` ends with its batch; after that, the lead edits part records too, such as adopting sourcing values. Give each PN to exactly one unit in a batch.

### Batch with Beads

1. At the fan-out step, list the units from the record: subassemblies from `assembly.yaml`, purchased families from `bom.csv` rows with `make_buy` `buy`, made parts, analysis cases. Bond every molecule onto the fan-out step before dispatching any: `bd mol bond <molecule> <fan-out-step> --type parallel --ref <unit> --var product=<id> --var scope=hw/ ...`. Beads 1.3.1 applies variable defaults on `pour` but not on `bond`, so pass every variable the molecule declares.
2. `bd ready --json` now lists the batch: the ready steps below the fan-out step whose `metadata.execution_mode` is `subagent`. `metadata.execution_agent_type` names the agent. Dispatch all of them in one subagent call or message, one worker per molecule; a worker carries every step of its molecule.
3. Only the lead writes the ledger. When a worker returns, close its molecule's steps with the evidence as the reason, then the molecule root `<fan-out-step>.<unit>`. A failed or `BLOCKED` unit stays open: remove the cause, such as by applying the shared-record change it proposed, then dispatch it again in the next batch.
4. Close the fan-out step once every child is closed; Beads refuses earlier. The integration step waits for all of them (`waits_for = "all-children"`) and becomes ready next.

At L4 the joint sweep is the stage's full check. Bond it onto `analysis-full-check` once the provisional ANALYSIS gate closes, with the version in its ref so that a rerun on a fixed version gets a fresh molecule. A static FEA case at the worst-case pose needs the sweep's `worst_case`: bond and dispatch those cases there as the next batch, once the sweep molecule closes. Every other L4 case runs in the fan-out batch.

The L2 light review runs `cad-mech-reviewer` and `cad-dfm-reviewer` read-only in one parallel batch while the PARTS full check runs. Its scope is the rules a check can miss at L2: every torque path and axial retainer, the anchorage of covers and mounts, and each made part's walls against its process minimum. It is not the final critique.

### Batch without Beads

The units, briefs, and ownership are the same. Keep the unit list and each unit's state in your plan, dispatch every unit of the stage in one subagent call or message, and integrate when all of them return. Gates follow Gate control.

### Brief

Each worker's brief is self-contained. It names:

- the unit id, and the molecule step text or, without Beads, the same instruction;
- the PNs, variant, or case the unit owns; a motion case also names the requirements and use cases its plan must show;
- the inputs as absolute paths (record files, version label, frozen interfaces, shared node ids), plus kernel and fidelity; a part or detail unit also gets each `--attach REF=PARENT_REF` the lead's integrated build passes to `cad-model run`, for its `scratch.py build`;
- the write boundary, and that the worker asks the user nothing and writes no ledger entry;
- the report format, which gives every file as an absolute path.

### Integrate

Read every report of the batch before you change anything. Accept a part delivery only when its scratch build passed; otherwise dispatch the unit again. Decide each proposal: apply an accepted one to the shared record yourself, and record why a declined one was declined. Merge concept variants into the scene, adopt cited sourcing values, write verification rows from analysis results, and copy an accepted motion plan to `hw/motion/cases/<case>/plan.yaml` before publishing it. Then run the stage's commit batch once on `hw/`: the build and the fast checks in the [fail-fast order](#fail-fast-check-order), and the recheck. Present the stage's gates with the absolute path of every file they show.

### Scratch workspace

A part designer works in `.cad-work/<unit>/` next to `hw/`; `scratch.py` writes a `.gitignore` there so git ignores the directory.

- `uv run --script skill://cad-flow/scripts/scratch.py init --hw hw --unit <unit> --part <PN> [--part <PN> ...]` copies `hw/` without `versions/`, `renders/`, `releases/`, `.cad/` (part store, pair cache, run records) or `.git/` and records a baseline. `deliver` ignores the scratch copy's own `.cad/`.
- `scratch.py build --hw hw --unit <unit> --fidelity F2|F3 [--kernel auto|cadquery|build123d] [--attach REF=PARENT_REF ...]` builds and checks the scratch copy under its own label and runs the form check on the unit's PNs; `hw/versions/` is never touched. Pass the same `--attach` entries as the lead's integrated build, so the unit checks the same rigid attachments; the report echoes them as `attach`.
- `scratch.py deliver --hw hw --unit <unit>` accepts only canonical source files under authorized part records (including a PN authorized at `init`), rejects generated subtrees, stray paths and unauthorized PNs, and writes nothing when a conflict is detected. The lead integrates the returned part files only after the passing scratch build.

Every path in its JSON output is absolute. `.cad-work/` is disposable once the stage's human gate passes.

## Gate control

INTENT, VARIANT, DESIGN freeze and RELEASE are single human gates. Every other stage gate approves a built version and comes as two gates: LAYOUT freeze, PARTS, DETAIL and ANALYSIS; the `cad-touch` REVISION and ANALYSIS gates; and in `mol-cad-iterate` the DETAIL gate and the analysis before its DESIGN freeze gate. Each such stage runs three steps in order:

1. **Provisional gate** (`<stage>-provisional-gate`, labels `phase:gate` and `provisional`). Resolve it yourself, without asking the user, once version vN passed every fast check. It is a plain step, not a Beads gate: close it with `bd close <step> --reason 'PROVISIONAL, temporary until the full check: vN passed fast checks 1-4: <result files>'`, and mark the stage's design entry provisional too. It lets the next stage start. It approves, freezes and releases nothing.
2. **Full check** (`<stage>-full-check`). Run fail-fast step 5 on the same vN. At L2 the light review runs beside it, and the full check closes only after both reviews have returned; at L4 the joint sweep case is the full check. While it runs, prepare the human gate's packet: renders and contact sheet, fast-check and form results, review verdicts, decisions, open findings, the sweep's unproved between-sample intervals, and a short summary, and at L3 the drawings. Close the step with its result files once they pass.
3. **Human gate.** It opens only after the full check passed and after the previous stage's human gate passed. Present the packet; only explicit user approval resolves it, through `bd gate resolve`. When the sweep left unproved between-sample intervals, the user either accepts them, which you record as a DR that the approval cites, or asks for a finer run (a smaller `--continuous-grid-deg`, a deeper `--continuous-depth` up to 6, finer `--steps`, or `--subsystem NAME` for the unproved pairs). For a finer run, reopen only the full-check step, rerun it on the same version, and present the gate again.

A failing full check, a MAJOR light-review finding, or a change the user names at the human gate voids the provisional approval and reopens the stage and everything built on it, even after the full check has closed:

1. Stop the stage's long jobs still running by their process groups.
2. List the later steps built on the voided version: `bd dep tree <provisional-gate-step> --direction=up --status=closed --json`. Keep every listed step except steps labelled `fanout` and bonded molecules (ids of the form `<step-id>.<ref>`). Each stage's full-check step spells out its own command.
3. Reopen them together with the stage's own steps: `bd reopen <integrate-step> <provisional-gate-step> <full-check-step> [<both L2 review steps>] <listed later steps> --reason 'VOID: vN <cause>: <result file>'`. The integrate step is the stage's build step (`layout` at L1). Reopening a step that is still open changes nothing, so always name the stage's own steps.

Beads then blocks the stage's full check and human gate, and every later integration, until you build a fixed version in the integrate step, it passes the fast checks, and you close the provisional gate again with the new evidence. Each later human gate stays blocked until its own reopened full check passes again on a version built from the fix. Rebuild each reopened later stage on the fixed version: its fan-out deliveries stay integrated, and a unit whose delivery the fix invalidates is dispatched again. Bond a rerun of a full-check case with the new version in its ref. Nothing is frozen or released before the human gates.

Human gates remain open until explicit user approval is recorded through `bd gate resolve`. Never infer approval from silence, a preview, a successful build, a provisional gate, an agent verdict, or a release artifact. If the current harness or workspace cannot resolve the gate through that command, leave it open and hand the gate to someone who can; do not substitute another gate-closing mechanism. Without Beads, keep the same three steps in your plan, and record each provisional approval and each VOID in the stage's design entry.

Every gate report, question, and summary gives each file it mentions as an absolute path on its own line: records, decisions, model.py, STEP and GLB, check JSON, renders, captures, drawing previews and PDFs, and the BOM. A relative path such as `hw/renders/v2/iso.png` is not enough. Add the URL of the live viewer or preview gallery while one runs.
