# CAD Beads formulas

The three `cad-*` formulas are poured roots; the four `mol-cad-*` formulas are bondable sub-workflows. A formula's canonical identity is its `.formula.toml` filename stem. Install the formula files in a project's `.beads/formulas/` directory (or the user's Beads formulas directory), with the CAD skills available from `@srobroek/cad`.

```bash
export BEADS_ACTOR=you
root=$(bd mol pour cad-product \
  --var product=widget \
  --var scope=hw/)
root=$(printf '%s\n' "$root" | sed -n 's/.*Root issue: //p')
bd mol bond mol-cad-part "$root" --type parallel \
  --var product=widget --var scope=hw/ --var subassembly=arm \
  --var kernel=cadquery --var process_default=fdm
```

`cad-part` builds one complete part product; `cad-product` defines a multi-part assembly and bonds one `mol-cad-part` per L2 subassembly in the same parallel batch. `cad-touch` is the ECO-style released-part path: it records a decision and requires an immediate released-revision bump. The bondable molecules provide a single-part/subassembly loop, another concept round, a post-freeze intent iteration, and release-package assembly/validation.

All formulas require `product` and `scope`. `kernel` accepts `cadquery` or `build123d` (default `cadquery`); `process_default` accepts `fdm` or `cnc` (default `fdm`). CadQuery 2.8 and build123d 0.13 use separate environments. FreeCAD 1.1.4 is the only CAD application. The formulas use lowercase stage-enum values: `ground`, `intent`, `specify`, `concept`, `layout`, `parts`, `detail`, `bom`, `analysis`, `critique`, `reconcile`, `design_freeze`, `release`.

Each L1 to L4 commit batch runs `cad-model run`, then `cad-model check`. A blocking check stops the batch. Then `cad-render` renders that version and the flow shows images at the stage gate. Before L2, `form_check` must pass at F2 and later. Before L3, it must pass at F3. Before LAYOUT freeze, committed batches build and render without broader recheck. The layout threshold, a user “commit”, or the hardware git pre-commit hook starts broader recheck. After LAYOUT freeze, it checks changed parts and dependents from `flow.recheck_from`. After DESIGN freeze, reopen only affected parts.

The gates INTENT, VARIANT, LAYOUT freeze, DESIGN freeze, and RELEASE are human approval gates. Reviewers run read-only as parallel subagents. Release artifacts are STEP AP242, drawings, EBOM, verification matrix, and documentation (GitBuilding build guide, DIN SPEC 3105-1 checklist, Open Know-How manifest); no slicer, CAM, or machine tooling.

Run `cad/formulas/smoke-pour.sh` to copy the formula set into a temporary Beads workspace, pour each root, bond each molecule, and print each formula's step/gate counts.
