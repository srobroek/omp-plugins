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

All formulas require `product` and `scope`. `kernel` accepts `cadquery` or `build123d` (default `cadquery`); `process_default` accepts `fdm` or `cnc` (default `fdm`). CadQuery 2.8 and build123d 0.13 stay in separate environments. FreeCAD 1.1.4 is the only CAD application. Formulas carry the stage loop: draft, live preview without checks, user feedback, then commit the record and bead note. Before LAYOUT freeze a committed batch builds and renders only. At or after LAYOUT freeze, recheck changed parts and dependents with the current stage's checks and all earlier applicable checks. After DESIGN freeze, reopen only affected parts.

The gates INTENT, VARIANT, LAYOUT freeze, DESIGN freeze, and RELEASE are human approval gates. Reviewers run read-only as parallel subagents. Release artifacts are STEP AP242, drawings, EBOM, verification matrix, and documentation (GitBuilding build guide, DIN SPEC 3105-1 checklist, Open Know-How manifest); no slicer, CAM, or machine tooling.

Run `cad/formulas/smoke-pour.sh` to copy the formula set into a temporary Beads workspace, pour each root, bond each molecule, and print each formula's step/gate counts.
