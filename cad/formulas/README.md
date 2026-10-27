# CAD Beads formulas

The three `cad-*` formulas are poured roots; the eight `mol-cad-*` formulas are bondable molecules. A formula's canonical identity is its `.formula.toml` filename stem. Copy the formula files into a project's `.beads/formulas/` directory (or the user's Beads formulas directory), with the CAD skills and agents installed as `cad/README.md` describes.

## Roots and stages

The roots orchestrate; the lead runs their steps. A stage with independent units has three parts:

1. A fan-out step, labelled `fanout`. The lead bonds one worker molecule per unit onto it, all before dispatching any, and sends every ready worker step to its agent in one parallel batch.
2. An integration step with `waits_for = "all-children"`. It becomes ready only after every bonded molecule and the fan-out step are closed. The lead applies accepted proposals and builds one version for the stage.
3. One human gate for the stage; molecules carry no gates.

| Root | Stages that fan out | Gates |
|---|---|---|
| `cad-product`, `cad-part` | concept (variants), parts (subassemblies plus purchased families), detail (made parts), analysis (cases), and the two critique steps | INTENT, VARIANT, LAYOUT freeze, PARTS, DETAIL, ANALYSIS, DESIGN freeze, RELEASE |
| `cad-touch` | revise (the ECO impact set), analysis (affected cases), and the two critique steps | INTENT, REVISION, ANALYSIS, RELEASE |

GROUND, INTENT, SPECIFY, LAYOUT, BOM, and RELEASE stay with the lead.

## Molecules

| Molecule | Unit | Steps | Agent |
|---|---|---|---|
| `mol-cad-variant` | `variant-<id>` | draft-variant | `cad-concept-designer` |
| `mol-cad-part` | `part-<subassembly>` | design, scratch-check | `cad-part-designer` |
| `mol-cad-sourcing` | `source-<family>` | research | `cad-sourcing-researcher` |
| `mol-cad-detail` | `detail-<PN>` | detail, scratch-check | `cad-part-designer` |
| `mol-cad-analysis` | `analysis-<case>` | run-case | `cad-analyst` |
| `mol-cad-concept` | another concept round | round-fanout, round-integrate, VARIANT gate, record-variant | lead, bonding `mol-cad-variant` |
| `mol-cad-iterate` | a change after DESIGN freeze | classify, INTENT gate, reopen-fanout, reopen-integrate, DETAIL gate, analysis-fanout, analysis-integrate, DESIGN freeze gate | lead, bonding `mol-cad-detail` and `mol-cad-analysis` |
| `mol-cad-release` | release package | gather, assemble, validate, RELEASE gate | lead |

Every worker step carries `execution_mode = "subagent"` and an `execution_agent_type` that names an agent in `cad/agents/`. A part designer builds only a scratch copy of `hw/` (`skill://cad-flow/scripts/scratch.py`), so `hw/versions/` changes only when the lead integrates.

## Bonding

```bash
export BEADS_ACTOR=you
root=$(bd mol pour cad-product --var product=widget --var scope=hw/)
root=$(printf '%s\n' "$root" | sed -n 's/.*Root issue: //p')
parts=$(bd list --parent "$root" --label fanout --label phase:parts --json | jq -r '.[0].id')
for sub in base_sub arm_sub; do
  bd mol bond mol-cad-part "$parts" --type parallel --ref "part-$sub" \
    --var product=widget --var scope=hw/ --var subassembly="$sub" \
    --var change="model $sub to F2" --var kernel=cadquery --var process_default=fdm
done
bd mol bond mol-cad-sourcing "$parts" --type parallel --ref source-pins \
  --var product=widget --var scope=hw/ --var family=pins --var parts=LMP-0005,LMP-0006
bd ready --json   # once the fan-out step is unblocked: every bonded worker step, one batch
```

Beads 1.3.1 applies variable defaults on `pour` but not on `bond`: pass every variable a molecule declares. Bond `mol-cad-concept` onto the VARIANT gate step and `mol-cad-iterate` or `mol-cad-release` onto the root, each with `--type parallel`.

All formulas require `product` and `scope`. `kernel` accepts `cadquery` or `build123d` (default `cadquery`); `process_default` accepts `fdm` or `cnc` (default `fdm`). CadQuery 2.8 and build123d 0.13 use separate environments. FreeCAD 1.1.4 is the only CAD application. The formulas use lowercase stage-enum values: `ground`, `intent`, `specify`, `concept`, `layout`, `parts`, `detail`, `bom`, `analysis`, `critique`, `reconcile`, `design_freeze`, `release`.

Each L1 to L4 commit batch runs `cad-model run`, then `cad-model check`. A blocking check stops the batch. Then `cad-render` renders that version and the flow shows images at the stage gate. Before the PARTS gate, `form_check` must pass at F2; before the DETAIL gate, at F3. Before LAYOUT freeze, committed batches run the build, blocking check, and render without the broader recheck. The layout threshold, a user “commit”, or the hardware git pre-commit hook starts the broader recheck. After LAYOUT freeze, recheck changed parts and dependents from `flow.recheck_from`. After DESIGN freeze, reopen only affected parts.

Every gate is a human approval gate. Reviewers run read-only as parallel subagents. Release artifacts are STEP AP242, drawings, EBOM, verification matrix, and documentation (GitBuilding build guide, DIN SPEC 3105-1 checklist, Open Know-How manifest); no slicer, CAM, or machine tooling.

Run `cad/formulas/smoke-pour.sh` to copy the formula set into a temporary Beads workspace, pour each root, bond each molecule onto its fan-out step, check that every worker step names a shipped agent, and show that one approved gate makes a whole batch ready at once. It prints each formula's step, gate, and worker-step counts.
