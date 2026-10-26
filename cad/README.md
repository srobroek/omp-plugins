# cad

Agent-assisted mechanical CAD for taking a product from a rapid visual prototype to a released, documented design. The endpoint is a STEP AP242 model, drawings, EBOM, verification matrix, and design documentation. Parts are designed for FDM or CNC; the workflow does not produce slicer, CAM, or machine-tool output.

FreeCAD 1.1.4 is the CAD application. CadQuery 2.8 and build123d 0.13 are supported as separate kernel environments.

## Install

For OMP, add this marketplace once and install the plugin:

```sh
omp plugin marketplace add srobroek/omp-plugins
omp plugin install cad@srobroek-omp
```

For Claude Code, add the `srobroek/omp-plugins` marketplace in the plugin browser and install `cad`. For Kiro and OpenCode, install or link this plugin through the harness's plugin mechanism so its skills and agents are available. The workflow instructions use project files, previews, feedback, and agent delegation rather than harness-specific commands.

Install a Beads workspace for the workflow formulas and approval gates. Plugin installation takes effect in a new session.

## Flow

`cad-flow` leads GROUND → INTENT → SPECIFY → L0 CONCEPT → VARIANT gate → L1 LAYOUT → LAYOUT freeze → L2 PARTS → L3 DETAIL → BOM → L4 ANALYSIS → parallel CRITIQUE → RECONCILE → DESIGN freeze → RELEASE → RELEASE gate. Each stage drafts, previews live without checks, and incorporates user feedback. “Commit batch” builds and renders before LAYOUT freeze; at or after the freeze it runs one batched recheck over changed parts and their dependents. A stage gate follows the commit. The user can request more detail to loop within the stage.

## Skills

Batch 1 includes these skills; only `cad-flow` ships in this initial skeleton. The others are planned for later batches.

| Skill | Status | Responsibility |
|---|---|---|
| `cad-flow` | Available | Lead procedure, stage loops, formula routing, gates, and release boundary |
| `cad-record` | Later | Create and maintain the structured hardware design record |
| `cad-concept` | Later | Explore and compare rapid visual concepts |
| `cad-review-mech` | Later | Mechanical critique method and evidence |
| `cad-review-dfm` | Later | FDM/CNC design-for-manufacture critique method and evidence |
| `cad-recheck` | Later | Batched changed-parts-and-dependents verification |
| `cad-fits` | Later | Fits, fasteners, tolerances, and process design rules |
| `cad-bom` | Later | EBOM and item/revision consistency |

## Agents

| Agent | Status | Role |
|---|---|---|
| `cad-mech-reviewer` | Later | Read-only mechanical design critique |
| `cad-dfm-reviewer` | Later | Read-only FDM/CNC design-for-manufacture critique |

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
