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

The plugin's `.claude-plugin/plugin.json` loads the reviewers generated for Claude Code from `harness/claude/agents/`, as `cad:cad-mech-reviewer` and `cad:cad-dfm-reviewer`. The files in `agents/` are the OMP sources; Claude Code does not load them.

This plugin ships no Kiro or OpenCode package, so copy its generated agents into your project. Run these commands from the project root, with `CAD` set to the `cad` directory of an omp-plugins checkout.

For Kiro, link the plugin at `cad/` in the workspace root and copy the agents into `.kiro/agents/`. Each reviewer loads its skill as `skill://cad/skills/<skill>/SKILL.md`, which Kiro resolves from the workspace root, so the plugin must sit at exactly that path:

```sh
ln -s "$CAD" cad
mkdir -p .kiro/agents
cp cad/harness/kiro/agents/*.json .kiro/agents/
```

`kiro-cli agent list` then shows both reviewers as workspace agents. To use the workflow skills from another Kiro agent, add `skill://cad/skills/**/SKILL.md` to that agent's `resources`.

For OpenCode, copy the agents into `.opencode/agents/` and the skills into `.opencode/skills/`:

```sh
mkdir -p .opencode/agents .opencode/skills
cp "$CAD"/harness/opencode/agents/*.md .opencode/agents/
cp -R "$CAD"/skills/. .opencode/skills/
```

Copy the files again after you update the checkout. The workflow instructions use project files, previews, feedback, and agent delegation rather than harness-specific commands.

Install a Beads workspace for the workflow formulas and approval gates. Plugin installation takes effect in a new session.

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
