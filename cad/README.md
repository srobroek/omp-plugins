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

The plugin's `.claude-plugin/plugin.json` loads the reviewers generated for Claude Code from `harness/claude/agents/`. Claude Code names them `cad:cad-mech-reviewer` and `cad:cad-dfm-reviewer`. The files in `agents/` are the OMP sources. Claude Code does not load them. Start the workflow with `/cad:cad-flow`, the plugin's `cad-flow` skill. If needed, verify the exact command with `claude --plugin-dir <checkout>/cad`.

This plugin has no Kiro or OpenCode package. Copy its generated agents and, for OpenCode, the command into your project. Run these commands from the project root. Set `CAD` to the `cad` directory of an omp-plugins checkout.

For Kiro, link the plugin at `cad/` in the workspace root and copy the agents into `.kiro/agents/`. Each reviewer loads its skill as `skill://cad/skills/<skill>/SKILL.md`, which Kiro resolves from the workspace root, so the plugin must sit at exactly that path:

```sh
ln -s "$CAD" cad
mkdir -p .kiro/agents
cp cad/harness/kiro/agents/*.json .kiro/agents/
```

`kiro-cli agent list` then shows both reviewers as workspace agents. To use the workflow skills from another Kiro agent, add `skill://cad/skills/**/SKILL.md` to that agent's `resources`.

For OpenCode, copy the agents into `.opencode/agents/`. Copy the command into `.opencode/commands/` and the skills into `.opencode/skills/`.

```sh
mkdir -p .opencode/agents .opencode/skills .opencode/commands
cp "$CAD"/harness/opencode/agents/*.md .opencode/agents/
cp "$CAD"/harness/opencode/commands/*.md .opencode/commands/
cp -R "$CAD"/skills/. .opencode/skills/
```

OpenCode lists `/cad-flow` and the skills in its skills list. The cad plugin does not appear under `/plugins` because there is no OpenCode package yet. Run `/cad-flow a desk lamp arm` to start. Run `/cad-flow` to resume the existing `hw/` design record. After you update the checkout, copy the files again. The workflow uses project files, previews, feedback, and agent delegation rather than harness-specific commands.

In OMP, use the `cad-flow` skill. In Kiro, use the linked `cad/` workspace skill `cad-flow`. In Claude Code, use `/cad:cad-flow` as documented above.

Install a Beads workspace for the workflow formulas and approval gates. Plugin installation takes effect in a new session.

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

Every plugin copy then loads the same installed kernel, whether it is a project's skill copy, an eval trial, or a worktree. Scripts started with `uv run --script` still get one environment per script path.

`--warm` also installs Playwright Chromium and fills the three.js cache. It records its progress and report for this plugin copy under `${XDG_CACHE_HOME:-~/.cache}/cad-flow/warm/`. `--warm --background` starts the warm-up in a detached process and returns once the warm-up has started. `--status [--wait SECONDS]` reports on the last warm-up and exits with one of these codes:

- 0: it passed.
- 1: a required check failed.
- 2: no warm-up is recorded, or it stopped without a report.
- 3: it is still running.

The `cad-flow` GROUND step starts the background warm-up and checks its status before the first L1 build. See `cad/skills/cad-drawings/SKILL.md` for FreeCAD installation steps.

Each path a script runs from with `uv run --script` leaves its own environment in the uv cache. To list the stale ones that belong to cad scripts:

```sh
uv run --script cad/skills/cad-flow/scripts/clean_envs.py
```

It shows each environment's apparent size and the space deleting it frees. That figure accounts for APFS clones and for files hard-linked from the uv cache. The listing keeps the environments this plugin copy uses now and any environment modified within the last 24 hours (`--min-age-hours`). Without `--delete` it deletes nothing. uv recreates a deleted environment the next time its script runs.

## Flow

`cad-flow` leads GROUND → INTENT → SPECIFY → L0 CONCEPT → VARIANT gate → L1 LAYOUT → LAYOUT freeze → L2 PARTS → L3 DETAIL → BOM → L4 ANALYSIS → parallel CRITIQUE → RECONCILE → DESIGN freeze → RELEASE → RELEASE gate. On each L1 to L4 commit batch, run `cad-model run`, then `cad-model check`; a blocking failure stops it. Then run `cad-render` for that version and show images at the gate. Before L2, `form_check` must pass at F2 or higher. Before L3, it must pass at F3. The layout threshold, user “commit”, or hardware git pre-commit hook starts the broader changed-parts/dependents recheck.

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
| `cad-mech-reviewer` | Available | Read-only mechanical design critique |
| `cad-dfm-reviewer` | Available | Read-only FDM/CNC design-for-manufacture critique |

The lead spawns both reviewers in the same parallel batch during CRITIQUE. Neither reviewer changes the design record or CAD files.

## Formulas

Poured formulas start a workflow root. Bondable `mol-` formulas attach a focused sub-process or iteration to an existing root.

| Formula | Use |
|---|---|
| `cad-touch` | Poured: a scoped change to an existing design |
| `cad-part` | Poured: design one part or subassembly within an established layout |
| `cad-product` | Poured: a new product flow from ground through release |
| `mol-cad-part` | Bonded: one subassembly's L2 parts loop onto the product workflow |
| `mol-cad-concept` | Bonded: a bounded concept exploration or concept refinement loop |
| `mol-cad-iterate` | Bonded: an approved change/iteration on an existing design node |
| `mol-cad-release` | Bonded: the release-specific checks and handoff for a design frozen for release |
