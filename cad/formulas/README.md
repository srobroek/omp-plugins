# CAD Beads formulas

The three `cad-*` formulas are poured roots; the eight `mol-cad-*` formulas are bondable molecules. A formula's canonical identity is its `.formula.toml` filename stem. Copy the formula files into a project's `.beads/formulas/` directory (or the user's Beads formulas directory), with the CAD skills and agents installed as `cad/README.md` describes.

## Roots and stages

The roots orchestrate; the lead runs their steps. A stage with independent units runs these steps in order; L1 LAYOUT, which the lead builds alone, runs steps 3 to 5 after its layout step:

1. A fan-out step, labelled `fanout`. The lead bonds one worker molecule per unit onto it, all before dispatching any, and sends every ready worker step to its agent in one parallel batch.
2. An integration step with `waits_for = "all-children"`. It becomes ready only after every bonded molecule and the fan-out step are closed. The lead applies accepted proposals, builds one version for the stage, and runs its fast checks.
3. A provisional gate, labelled `phase:gate` and `provisional`: a plain step, not a Beads gate. The lead closes it without the user once that version passed every fast check, with a reason marked `PROVISIONAL`. The next stage may start after it; it freezes and releases nothing.
4. A full check, labelled `full-check`: the full check on the same version, during which the lead prepares the gate packet. A failure voids the provisional approval: the lead runs `bd reopen` on the integration and provisional steps, and Beads blocks the full check and the next stage's integration until a fixed version passes the fast checks.
5. One human gate for the stage. It needs the full check and the previous stage's human gate; molecules carry no gates.

INTENT, VARIANT, DESIGN freeze, and RELEASE are single human gates. `skill://cad-flow` describes the fail-fast check order and the gate rules.

| Root | Stages that fan out | Human gates | Provisional gates |
|---|---|---|---|
| `cad-product`, `cad-part` | concept (variants), parts (subassemblies plus purchased families), the L2 light review, detail (made parts), analysis (cases, then the joint sweep and its worst-pose FEA at the full check), and the two critique steps | INTENT, VARIANT, LAYOUT freeze, PARTS, DETAIL, ANALYSIS, DESIGN freeze, RELEASE | LAYOUT, PARTS, DETAIL, ANALYSIS |
| `cad-touch` | revise (the ECO impact set), analysis (affected cases, then the joint sweep at the full check), and the two critique steps | INTENT, REVISION, ANALYSIS, RELEASE | REVISION, ANALYSIS |

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
| `mol-cad-iterate` | a change after DESIGN freeze | classify, INTENT gate, reopen-fanout, reopen-integrate, DETAIL provisional gate, DETAIL full check, DETAIL gate, analysis-fanout, analysis-integrate, ANALYSIS provisional gate, ANALYSIS full check, DESIGN freeze gate | lead, bonding `mol-cad-detail` and `mol-cad-analysis` |
| `mol-cad-release` | release package | gather, validate, RELEASE gate, assemble | lead |

Every worker step carries `execution_mode = "subagent"` and an `execution_agent_type` that names an agent in `cad/agents/`. A part designer builds only a scratch copy and delivers canonical record-source files for authorized parts via `scratch.py`; generated outputs, stray paths and unauthorized PNs are refused. New PN records are authorized at `init`. Conflicts write nothing. The lead alone integrates accepted proposals and builds versions.

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

Each L1 to L4 commit batch builds one version with `cad-model run` and checks it cheapest first, as `skill://cad-flow` orders: the record validator and form check, `cad-model check --changed-only`, a smoke sweep, renders with the visibility check, and only after the provisional gate the full check (`cad-model check` over every pair and the full sweep with its between-sample check). A blocking check stops the batch. Before PARTS, `form_check` must pass at F2; before DETAIL, at F3. Before LAYOUT freeze, committed batches run the build, blocking check, and render without the broader recheck. The layout threshold, a user “commit”, or the hardware git pre-commit hook starts the broader recheck. After LAYOUT freeze, recheck changed parts and dependents from `flow.recheck_from`. After DESIGN freeze, reopen only affected parts.
`cad-record/references/layout.md` is the canonical path table generated from `layout.json`; commands resolve paths through `layout-api.md`. Version-bound producers publish immutable bundles with manifests that pin the version, recipe, and file hashes. Matching recipes reuse a bundle, even with `--replace`; a changed recipe needs `--replace` and retains the prior bundle under `.cad-work/replaced/`. Explicit outputs must be new `.cad-work/` paths; inputs come from the selected version's `record/` snapshot.
Before freezing an existing project, run `validate.py PROJECT --migration-plan`; it is read-only. Layout findings warn before `design_freeze`, error from freeze on, and remain errors after `flow.frozen` or any release. Nothing moves automatically. Legacy versions and v1 releases remain as they are and are never reissued.
Custom-made parts receive checked manufacturing geometry during build; manufacturing completeness is required at freeze and release and failures cannot be waived. Before DESIGN freeze, set released part revisions and build the exact version; pin its label, manifest SHA-256 and approved decision in `flow.frozen`. Verification rows must pass or be waived and cite evidence from the frozen version. Any post-freeze record/model change needs an approved ECO, new version and re-freeze before release.

Run `cad/formulas/smoke-pour.sh` to copy the formula set into a temporary Beads workspace, pour each root, bond each molecule onto its fan-out or full-check step, check that every worker step names a shipped agent, and show that one approved gate makes a whole batch ready at once. It also walks the `cad-product` LAYOUT stage: the provisional gate makes the full check and L2 PARTS ready, a VOID reopen blocks both again, and the human gate opens only after the full check passes. It prints each formula's step, gate, provisional-gate, and worker-step counts. The full canonical hardware path table is generated at `cad/skills/cad-record/references/layout.md`; use `layout-api.md` from commands instead of writing alternate path conventions.

The RELEASE gate comes before `release.py`, which seals `hw/releases/<REV>/` for good: after approval the lead records it as `decisions/DR-###`, then runs `release.py` with that decision. Release gates and package reports MUST show print/make files, buy rows (including OPEN identity fields and reasons), assembly steps, and checks as structured lists or tables. Give every cited file as a separate absolute-path line; never inline comma prose.
