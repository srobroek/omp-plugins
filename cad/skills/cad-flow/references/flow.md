# CAD flow reference

## Stages, gates, and durable outputs

Keep the source of truth in the hardware project's `hw/` design record. Every decision, requirement, interface, revision, check result, and release artifact must identify its source or evidence. Preserve millimetres and the product's declared ISO or ASME regime. Stage ordering is intentional: do not detail parts before the layout freezes their interfaces, or release before analysis and critique are reconciled.

| Stage | Work and user gate | Design-record output | Skill / command |
|---|---|---|---|
| GROUND | Inspect needs and existing hardware. | Product identity, rigor, units, regime, tolerances; initial requirements and interface evidence. | `cad-record`: `uv run --script skill://cad-record/scripts/validate.py <project-dir>` |
| INTENT | Present purpose, users, envelope, constraints, unknowns; wait for approval. | Approved intent, requirement sources, rationales, priorities, and gate decision. | `cad-record`: `uv run --script skill://cad-record/scripts/validate.py <project-dir>` |
| SPECIFY | Set measurable requirements and verification criteria. | `requirements.yaml` with REQ-###, rationale, source, priority, verification method and criteria; updated `interfaces.yaml`. | `cad-record`: `uv run --script skill://cad-record/scripts/validate.py <project-dir>` |
| concept | One `cad-concept-designer` per variant drafts 2-4 rapid three.js variants in one batch; merge them, then refine, merge, or drop by feedback. | `hw/concept/<product-id>.scene.json`; options and selection in `decisions/DR-###.md`. Preview is not verified CAD. | `cad-concept`: `uv run --script skill://cad-concept/scripts/concept.py check <scene>`; handoff: `uv run --script skill://cad-concept/scripts/concept.py handoff <scene> --out hw/concept/handoff.json` |
| VARIANT gate | Get explicit concept selection. | Selected concept and gate evidence in workflow record and `DR-###`. | `cad-concept`: `uv run --script skill://cad-concept/scripts/concept.py handoff <scene> --out hw/concept/handoff.json` |
| layout | Define subassemblies, interfaces, joints/limits, BOM skeleton. | `assembly.yaml`, `interfaces.yaml`, preliminary `bom.csv`. | `cad-record`: `uv run --script skill://cad-record/scripts/validate.py <project-dir>`; `cad-model`: `uv run --script skill://cad-model/scripts/cad_model.py run hw --label vN [--kernel auto]`, then `uv run --script skill://cad-model/scripts/cad_model.py check vN --hw hw [--out FILE]`; press fits declared in `hw/interfaces.yaml` are automatically allowed. `cad-render`: `uv run --script skill://cad-render/scripts/render.py hw [--version latest|vN] [--views iso front side exploded closeup-<PN>]` |
| LAYOUT freeze | Present layout, interfaces, BOM skeleton for approval. | Frozen decision and gate evidence; `flow.recheck_from: layout`. | `cad-viewer`: `uv run --script skill://cad-viewer/scripts/viewer.py serve`; then `uv run --script skill://cad-viewer/scripts/viewer.py show hw [--version vN] --check FILE`; compare: `uv run --script skill://cad-viewer/scripts/viewer.py compare vA vB --hw hw --check-a FA --check-b FB`. `serve` starts a user viewer pair and a presenter viewer pair. |
| parts | One `cad-part-designer` per subassembly and one `cad-sourcing-researcher` per purchased family, in one batch; build one integrated version; PARTS gate. | `parts/<PN>/part.yaml` and `model.py`; PN, revision, material, process, finish, mass target, make/buy, supplier. | Run `cad-model run`, `cad-model check`, and `cad-render` with the LAYOUT commands. Before L2, run `uv run --script skill://cad-design/scripts/form_check.py --hw hw --parts-dir hw/versions/vN/parts --fidelity F2`. After each build/check, run `uv run --script skill://cad-viewer/scripts/viewer.py show hw [--version vN] --check FILE`. At gates, run `uv run --script skill://cad-viewer/scripts/viewer.py compare vA vB --hw hw --check-a FA --check-b FB`, animate joint limits, and capture iso. Capture a revolute section with `uv run --script skill://cad-viewer/scripts/viewer.py capture --view section --joint J-00x --out PNG`. `capture --view current` follows the user's camera when their tab is open. |
| detail | One `cad-part-designer` per made part applies fits, fasteners, tolerances, and process rules in one batch. Build, check, and draw one integrated version for the DETAIL gate. | Part revisions, fit decisions, drawings, and evidence. | `cad-fits`: `uv run --script skill://cad-fits/scripts/fits.py SIZE FIT [--expect TYPE]` and `uv run --script skill://cad-fits/scripts/stackup.py STACK.yaml`; `cad-design`: run `uv run --script skill://cad-design/scripts/form_check.py --hw hw --parts-dir hw/versions/vN/parts --fidelity F3` before L3 gate; L3 needs F3. `cad-drawings` command: `uv run --script skill://cad-drawings/scripts/drawing.py hw/versions/vN/parts/<PN>.step --part hw/parts/<PN>/part.yaml --product hw/product.yaml --metrics hw/versions/vN/metrics.json --output-dir <dir> [--scale <ratio>]`. Use `uv run --script skill://cad-model/scripts/cad_model.py check vN --hw hw [--out FILE]` for each L3 batch; press fits are declared in `hw/interfaces.yaml` and automatically allowed. |
| bom | Reconcile part numbers, revisions, quantities, make/buy, suppliers, and assemblies. | Released-intent EBOM `bom.csv`. | `cad-bom`: `uv run --script skill://cad-bom/scripts/bom.py ASSEMBLY.step --hw hw [--out hw/bom.csv]` |
| analysis | One `cad-analyst` per case checks interference, clearance, stack-up, kinematics, or static FEA at the worst pose, in one batch; FEA at the worst pose follows the sweep; ANALYSIS gate. | `verification.csv` tied to requirements/configurations; analysis artifacts and assumptions. | Kinematic sweep `cad-motion`: `uv run --script skill://cad-motion/scripts/sweep.py --hw hw --version vN --worst-step worst.step`; static FEA `cad-analysis`: `uv run --script skill://cad-analysis/scripts/fea_static.py <case.yaml>`. Each L4 batch runs `uv run --script skill://cad-model/scripts/cad_model.py check vN --hw hw [--out FILE]`; press fits declared in `hw/interfaces.yaml` are automatically allowed. |
| critique | Spawn mechanical and DFM reviewers in one parallel read-only batch. | Preserve both verdicts and evidence in workflow record. Neither reviewer waits for the other. | `cad-review-mech`; `cad-review-dfm` |
| reconcile | Resolve critique findings. Rerun affected checks. | Updated `decisions/DR-###.md`, `verification.csv`, revisions, dispositions. | `cad-flow`; `cad-recheck`: `uv run --script skill://cad-recheck/scripts/stamp.py --stage <stage> --checks <json-file> --passed` only when checks pass. |
| design_freeze | Present reconciled design, analyses, and record for approval. | Frozen decision and gate evidence. Reopen affected parts/dependents only after freeze. | `cad-record`: `uv run --script skill://cad-record/scripts/validate.py <project-dir>`; OCP Studio look-dev: `uv run --script skill://cad-viewer/scripts/viewer.py studio --environment studio --tone-mapping ACES --exposure 1.0 --env-intensity 1.0 --env-rotation 0 --background gradient --shadow-intensity 1.0 --shadow-softness 0.5 --ao-intensity 1.0 --texture-mapping triplanar`. Only Studio flags affect captures. |
| release | Prepare and inspect a traceable release package. | `releases/<rev>/manifest.json`, BOM, verification, drawings, STEP AP242, docs. | `cad-record`: `uv run --script skill://cad-record/scripts/validate.py <project-dir>`; `cad-bom`: `uv run --script skill://cad-bom/scripts/bom.py ASSEMBLY.step --hw hw [--out hw/bom.csv]`; `cad-drawings`: `uv run --script skill://cad-drawings/scripts/drawing.py hw/versions/vN/parts/<PN>.step --part hw/parts/<PN>/part.yaml --product hw/product.yaml --metrics hw/versions/vN/metrics.json --output-dir <dir> [--scale <ratio>]`. |
| RELEASE gate | Show contents and verification. Get approval before release. | Gate decision and release manifest/status. | Capture a release view with `uv run --script skill://cad-viewer/scripts/viewer.py capture --view iso --out PNG`. On session end run `uv run --script skill://cad-viewer/scripts/viewer.py stop`; record `ports_free`. |

The canonical `product.yaml` stage enum uses lowercase values: `ground`, `intent`, `specify`, `concept`, `layout`, `parts`, `detail`, `bom`, `analysis`, `critique`, `reconcile`, `design_freeze`, `release`. Prose may use uppercase or L0 to L4; record values use these enum strings.

The full endpoint is STEP AP242 plus drawings, EBOM, verification matrix, and docs. Designs target FDM or CNC, but stop before slicing, CAM, or machine-tool generation. FreeCAD 1.1.4 is the only CAD application. CadQuery 2.8 and build123d 0.13 each run in a separate environment.

## Stage loop and recheck boundary

Draft, show live previews, and collect feedback. Continue until the user says “commit” or “commit batch”. Do not check on every edit.
- Each L1 to L4 commit batch runs `cad-model run` and then `cad-model check`. Stop if that check has a blocking failure. Render the successful version with `cad-render` and show its images at the stage gate.
- The user's commit, the layout threshold, or the hardware git pre-commit hook triggers the broader changed-parts/dependents recheck. Use `flow.recheck_from` and all applicable earlier-stage checks. `cad-recheck` stamps the exact staged `hw/` tree. Use `--passed` only after every required check passes.
- Record changed items, dependents, checks, results, and artifacts. A later edit starts a new batch on the next commit.
- After DESIGN freeze, reopen only affected parts and dependents. Preserve unaffected parts and evidence.
- Before using commands such as `uv run --script skill://<name>/scripts/...` on a non-OMP harness, resolve `skill://<name>/` to that skill's base directory; OMP resolves the URI directly.
- A preview or render is not a check result. Tie reported checks to a design revision/configuration.

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
- the PNs, variant, or case the unit owns;
- the inputs as absolute paths (record files, version label, frozen interfaces, shared node ids), plus kernel and fidelity;
- the write boundary, and that the worker asks the user nothing and writes no ledger entry;
- the report format, which gives every file as an absolute path.

### Integrate

Read every report of the batch before you change anything. Accept a part delivery only when its scratch build passed; otherwise dispatch the unit again. Decide each proposal: apply an accepted one to the shared record yourself, and record why a declined one was declined. Merge concept variants into the scene, adopt cited sourcing values, and write verification rows from analysis results. Then run the stage's commit batch once on `hw/`; at L2 and L3 that is `cad-model run` and `check`, the form check, the render, the L3 drawings, and the recheck. Present the stage gate with the absolute path of every file it shows.

### Scratch workspace

A part designer works in `.cad-work/<unit>/` next to `hw/`; `scratch.py` writes a `.gitignore` there so git ignores the directory.

- `uv run --script skill://cad-flow/scripts/scratch.py init --hw hw --unit <unit> --part <PN> [--part <PN> ...]` copies `hw/` without `versions/`, `renders/`, `releases/`, or `.git/` and records a baseline.
- `scratch.py build --hw hw --unit <unit> --fidelity F2|F3 [--kernel auto]` runs `cad-model run`, `check`, and `form_check` on the copy only, so `hw/versions/` is never created or changed. Form findings on other units' parts do not block it.
- `scratch.py deliver --hw hw --unit <unit>` replaces only the unit's `hw/parts/<PN>/` and lists every other changed file as a proposal. It writes nothing when one of those part directories changed since `init`.

Every path in its JSON output is absolute. `.cad-work/` is disposable once the stage gate passes.

## Gate control

Gates remain open until explicit user approval is recorded through `bd gate resolve`. Never infer approval from silence, a preview, a successful build, an agent verdict, or a release artifact. If the current harness or workspace cannot resolve the gate through that command, leave it open and hand the gate to someone who can; do not substitute another gate-closing mechanism.

Every gate report, question, and summary gives each file it mentions as an absolute path on its own line: records, decisions, model.py, STEP and GLB, check JSON, renders, captures, drawing previews and PDFs, and the BOM. A relative path such as `hw/renders/v2/iso.png` is not enough. Add the URL of the live viewer or preview gallery while one runs.
