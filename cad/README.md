# cad

Agent-assisted mechanical CAD for taking a product from a rapid visual prototype to a released, documented design. The endpoint is a STEP AP242 model, drawings, EBOM, verification matrix, and design documentation. Parts are designed for FDM or CNC; the workflow does not produce slicer, CAM, or machine-tool output.

FreeCAD 1.1.4 is the CAD application. CadQuery 2.8 and build123d 0.13 are supported as separate kernel environments.

## Install

For OMP, add this marketplace once and install the plugin:

```sh
omp plugin marketplace add srobroek/omp-plugins
omp plugin install cad@srobroek-omp
```

For Claude Code, install it from the same marketplace, or load a checkout for one session:

```sh
claude plugin marketplace add srobroek/omp-plugins
claude plugin install cad@srobroek-omp
# or, from a checkout:
claude --plugin-dir /path/to/omp-plugins/cad
```

The plugin's `.claude-plugin/plugin.json` loads the agents generated for Claude Code from `harness/claude/agents/`. Claude Code names them `cad:<agent>`, such as `cad:cad-part-designer` and `cad:cad-mech-reviewer`. The files in `agents/` are the OMP sources. Claude Code does not load them. Start the workflow with `/cad:cad-flow`, the plugin's `cad-flow` skill. If needed, verify the exact command with `claude --plugin-dir <checkout>/cad`.

This plugin has no Kiro or OpenCode package. Copy its generated agents and, for OpenCode, the command into your project. Run these commands from the project root. Set `CAD` to the `cad` directory of an omp-plugins checkout.

For Kiro, link the plugin at `cad/` in the workspace root and copy the agents into `.kiro/agents/`. Each agent loads its skills as `skill://cad/skills/<skill>/SKILL.md`, which Kiro resolves from the workspace root, so the plugin must sit at exactly that path:

```sh
ln -s "$CAD" cad
mkdir -p .kiro/agents
cp cad/harness/kiro/agents/*.json .kiro/agents/
```

`kiro-cli agent list` then shows the six cad agents as workspace agents. To use the workflow skills from another Kiro agent, add `skill://cad/skills/**/SKILL.md` to that agent's `resources`.

For OpenCode, copy the agents into `.opencode/agents/`. Copy the command into `.opencode/commands/` and the skills into `.opencode/skills/`.

```sh
mkdir -p .opencode/agents .opencode/skills .opencode/commands
cp "$CAD"/harness/opencode/agents/*.md .opencode/agents/
cp "$CAD"/harness/opencode/commands/*.md .opencode/commands/
cp -R "$CAD"/skills/. .opencode/skills/
```

OpenCode lists `/cad-flow` and the skills in its skills list. The cad plugin does not appear under `/plugins` because there is no OpenCode package yet. Run `/cad-flow a desk lamp arm` to start. Run `/cad-flow` to resume the existing `hw/` design record. After you update the checkout, copy the files again. The workflow uses project files, previews, feedback, and agent delegation rather than harness-specific commands.

In OMP, use the `cad-flow` skill. In Kiro, use the linked `cad/` workspace skill `cad-flow`. In Claude Code, use `/cad:cad-flow` as documented above.

To run the flow with Beads formulas and approval gates, initialise Beads in the project and copy the formulas into `.beads/formulas/`. Set `CAD` as above; for OMP it can also be the installed plugin, `~/.omp/plugins/node_modules/@srobroek/cad`. In Kiro, `cad` is the link made above.

```sh
bd init
mkdir -p .beads/formulas
cp "$CAD"/formulas/*.formula.toml .beads/formulas/
bd formula list
```

`bd formula list` then shows `cad-product`, `cad-part`, `cad-touch`, and the eight `mol-cad-*` molecules. Copy the formulas again after you update the checkout. Without them, the lead runs the same per-stage worker batches from its own plan, but gates need Beads to close. Plugin installation takes effect in a new session.

## Setup

Run setup at the CAD project root before a new design:

```sh
uv run --script cad/skills/cad-flow/scripts/setup.py
```

Setup checks for FreeCAD 1.1.4 first. When the command or version check fails, setup exits nonzero before any other action. Its error shows the release URL and lookup order. Install FreeCAD manually as described in `cad/skills/cad-drawings/SKILL.md`, then rerun setup. Add `--yes` to perform the remaining user-level actions.

Setup delegates kernel environments, the viewer, Chromium, and the three.js cache to `preflight.py --warm`. It then reruns preflight and prints a summary. Setup copies formula files to `.beads/formulas/` when a Beads workspace exists. It prints a warning otherwise. Pass `--harness opencode`, `--harness kiro`, or `--harness claude` to install harness files.

For manual installation, place the FreeCAD 1.1.4 app bundle in `/Applications` on macOS. On Linux, verify the AppImage against the published `-SHA256.txt`, then extract it. Add `freecadcmd` to `PATH` or set `FREECADCMD`. See `cad/skills/cad-drawings/SKILL.md` for the download and checksum commands.

## Preflight

Run the environment check before starting a CAD project:

```sh
uv run --script cad/skills/cad-flow/scripts/preflight.py
```

The preflight reports each check as pass, fail, or warning, with a fix hint and elapsed time. It exits non-zero when any required runtime check fails. Use `--json` for machine-readable results or `--harness omp|claude|opencode|kiro` to check one harness. Each check is time-bounded and prints progress with its elapsed time.

The required checks are FreeCAD 1.1.4 and its TechDraw templates, CadQuery 2.8, build123d 0.13, the cad-model orchestrator environment, and ocp_viewer. Playwright Chromium (launched headless) and the SRI-checked three.js cache are also required. Beads and detected harness installation are warnings. This plugin ships no MCP server, so there is no MCP check.

Each environment check imports its packages in the environment the pipeline uses, so the check is also that environment's first load. The kernel runners `run_cadquery.py` and `run_build123d.py` run in uv environments shared by dependency set:

```sh
uv run --isolated --no-project --python <requires-python> --with-requirements <runner> python <runner>
```

The CAD plugin's heavier scripts (OCP, VTK, ocp_viewer, Playwright, and similar kernels) use one environment per dependency set, shared across project copies. Launch them with `uv run --script skill://cad-flow/scripts/run.py <skill>/scripts/<script.py> [args...]`; the target is relative to `cad/skills/`. The wrapper reads the target's PEP 723 header and runs it through `cadmodel.scriptenv`. `uv run --script` remains appropriate for lightweight scripts.

`--warm` also installs Playwright Chromium and fills the three.js cache. It records its progress and report for this plugin copy under `${XDG_CACHE_HOME:-~/.cache}/cad-flow/warm/`. `--warm --background` starts the warm-up in a detached process and returns once the warm-up has started. `--status [--wait SECONDS]` reports on the last warm-up and exits with one of these codes:

- 0: it passed.
- 1: a required check failed.
- 2: no warm-up is recorded, or it stopped without a report.
- 3: it is still running.

The `cad-flow` GROUND step starts the background warm-up and checks its status before the first L1 build. See `cad/skills/cad-drawings/SKILL.md` for FreeCAD installation steps.

Every path-keyed `uv run --script` environment is isolated to a script path. Heavy-script environments are shared by dependency set through `cad-flow/scripts/run.py`; the cleanup tool lists only path-keyed script environments. To list stale CAD script environments:

```sh
uv run --script cad/skills/cad-flow/scripts/clean_envs.py
```

It shows each environment's apparent size and the space deleting it frees. That figure accounts for APFS clones and for files hard-linked from the uv cache. The listing keeps the environments this plugin copy uses now and any environment modified within the last 24 hours (`--min-age-hours`). Without `--delete` it deletes nothing. uv recreates a deleted environment the next time its script runs.

## Flow

`cad-flow` leads GROUND → INTENT → SPECIFY → L0 CONCEPT → VARIANT gate → L1 LAYOUT → LAYOUT freeze → L2 PARTS → L3 DETAIL → BOM → L4 ANALYSIS → parallel CRITIQUE → RECONCILE → DESIGN freeze → RELEASE gate → RELEASE. On each L1 to L4 commit batch, run `cad-model run`, then `cad-model check`; a blocking failure stops it. Then run `cad-render` for that version and show images at the gate. Before L2, `form_check` must pass at F2 or higher; before L3, at F3. The layout threshold, user “commit”, or hardware git pre-commit hook starts the broader changed-parts/dependents recheck.
`cad-record/references/layout.md` is the generated source of truth for every `hw/` path; use its `layout-api.md` from commands. Versioned producers publish immutable bundles with manifests, reusing matching recipes; changed recipes require `--replace` and retain old bundles. Explicit output paths are new `.cad-work/` paths only. Inputs are read from each version's `record/` snapshot. On an existing project, validate `--migration-plan` before freeze; it is read-only and nothing is moved. Legacy versions and v1 releases are not changed or reissued. Freeze pins the exact version and manifest hash, and `release.py` seals a deterministic package; it refuses failed or incomplete manufacturing/evidence instead of accepting an agent-written inventory. See `cad-flow` and `cad/formulas/README.md` for the workflow and gates.

## Skills

The table lists every directory under `cad/skills/`, including the OCP viewer and side panel.

| Skill | Status | Responsibility |
|---|---|---|
| `cad-flow` | Available | Lead procedure, stage loops, formula routing, gates, and release boundary |
| `cad-record` | Available | Create and maintain the structured hardware design record |
| `cad-concept` | Available | Explore and compare rapid visual concepts |
| `cad-model` | Available | Build, check, and diff parametric CadQuery/build123d models |
| `cad-design` | Available | F0 to F3 product fidelity and form-check gates |
| `cad-motion` | Available | Pose assemblies, sweep joint motion, and select worst-case poses |
| `cad-render` | Available | Automated three.js PBR version renders and gate imagery |
| `cad-viewer` | Available | Interactive OCP CAD Viewer inspection and Studio look-dev |
| `cad-analysis` | Available | Static finite-element analysis at worst-case poses |
| `cad-bom` | Available | Roll up the engineering bill of materials |
| `cad-drawings` | Available | Create engineering drawings from STEP and design-record data |
| `cad-fits` | Available | Calculate fit limits and tolerance stack-ups |
| `cad-recheck` | Available | Recheck changed parts and dependents at the configured threshold |
| `cad-review-dfm` | Available | Evidence-based read-only FDM/CNC manufacturability critique |
| `cad-review-mech` | Available | Evidence-based read-only mechanical design critique |

| Agent | Status | Role |
|---|---|---|
| `cad-concept-designer` | Available | Drafts one L0 concept variant in its own work directory |
| `cad-part-designer` | Available | Designs or details one unit's parts in a scratch copy of `hw/` and delivers only its own part directories |
| `cad-sourcing-researcher` | Available | Read-only, cited catalogue, datasheet, and limit research for one purchased-part family |
| `cad-analyst` | Available | Runs one L4 analysis case on an integrated version, read-only on `hw/` |
| `cad-mech-reviewer` | Available | Read-only mechanical design critique |
| `cad-dfm-reviewer` | Available | Read-only FDM/CNC design-for-manufacture critique |

The lead dispatches each stage's workers in one parallel batch, then integrates their results and builds one version. Workers never change the shared design record, build `hw/versions/`, or ask the user; `cad-flow` lists the units and ownership per stage.

## Formulas

Poured formulas start a workflow root. Each stage that has independent units starts with a fan-out step that bonds one worker molecule per unit, all in one parallel batch. The stage then has one lead integration step that waits for every unit, followed by one human gate. `cad/formulas/README.md` shows the bond commands.

| Formula | Use |
|---|---|
| `cad-product` | Poured: a new multi-part product flow from ground through release |
| `cad-part` | Poured: the same flow for a one-part product |
| `cad-touch` | Poured: an ECO on a released part, with a revision bump |
| `mol-cad-variant` | Bonded worker unit: one concept variant (`cad-concept-designer`) |
| `mol-cad-part` | Bonded worker unit: one L2 subassembly, scratch-built and delivered (`cad-part-designer`) |
| `mol-cad-sourcing` | Bonded worker unit: one purchased-part family (`cad-sourcing-researcher`) |
| `mol-cad-detail` | Bonded worker unit: one part's L3 detail or post-freeze revision (`cad-part-designer`) |
| `mol-cad-analysis` | Bonded worker unit: one L4 analysis case (`cad-analyst`) |
| `mol-cad-concept` | Bonded: another concept round, fanning out its own variants |
| `mol-cad-iterate` | Bonded: an approved change after DESIGN freeze, fanning out the affected parts and cases |
| `mol-cad-release` | Bonded: the release package and RELEASE gate for a frozen design |
