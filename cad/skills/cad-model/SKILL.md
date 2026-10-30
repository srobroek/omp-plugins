---
name: cad-model
description: Builds part model scripts into versioned STEP AP242, GLB, and metrics, then checks or diffs versions. Triggers on "build v3", "check the model", "diff".
---

# CAD Model Build and Check

Stages L1 LAYOUT to L4 ANALYSIS: every commit batch builds a version; at or after
`flow.recheck_from` the recheck consumes `check`. L0 CONCEPT stays in `cad-concept`.

TRIGGER
+ "build the parts", "build v3", "export STEP", "rebuild after the model.py edit"
+ "check the model", "does anything overlap", "is the B-rep valid", "is the mesh watertight"
+ "diff v2 v3", "what changed in the upper link", "add a cut without breaking the solid"
- joint posing, sweeps, worst-case pose → `cad-motion`
- the BOM roll-up → `cad-bom`; fits and stack-ups → `cad-fits`
- pushing to a viewer → out of scope; read `part-map.json` and `latest.json` instead

## Workflow

1. Write each `hw/parts/<PN>/model.py`: one kernel per file, `KERNEL`, `PARAMS`, `build(params)`,
   modelled in place at the zero pose; Booleans through `cadmodel.safe` (`safe_cut`, `safe_fuse`,
   `safe_intersect`). Add `drawing_features(params, shape)` for a part that needs a production
   drawing. Add `build_manufacture(params)`, declared in part.yaml `manufacture`, for a part made in
   another state than it is installed in, such as a strap printed flat. LOAD references/contract.md
   when writing or reviewing a model.py.
2. Build: `uv run --script skill://cad-flow/scripts/run.py cad-model/scripts/cad_model.py run hw --label vN [--kernel auto]`
   → `hw/versions/vN/` and `hw/versions/latest.json`; JSON summary on stdout. `auto` runs each
   part in its declared kernel's own uv environment; `cadquery` or `build123d` additionally
   requires every part to declare that kernel. The version snapshots its records in `record/` and
   holds `manufacturing/<PN>/` for every custom-made part: `part.step` (AP242, mm), `part.stl`
   for FDM (binary, mm, on the printer bed) and `manufacturing.json`. A manufacturing output that
   fails its checks fails the run: no version, latest unchanged.
3. Check: `uv run --script skill://cad-flow/scripts/run.py cad-model/scripts/cad_model.py check vN --hw hw [--out .cad-work/<unit>/check.json] [--jobs 1|N|auto] [--cache DIR | --no-cache]` (explicit results must be new `.cad-work/` paths).
   → check result JSON; press fits and heat-set inserts declared in `hw/interfaces.yaml` are allowed
   to interfere automatically. `build_volume` checks each FDM part, in the state it is printed in,
   against the printer envelope of the version's `product.yaml`.
   It reports an axis-aligned orientation when one fits. Otherwise, it reports the oriented box axes.
   Oversized parts block the check. An undeclared volume warns without blocking.
   `manufacturing` judges every manufacturing output again on the sealed files, and
   `artifact_integrity` every file of the version against its manifest.
   `pair_clearance` holds each clearance requirement in `hw/interfaces.yaml` (`type: clearance`,
   `pair`, `min_clearance_mm`) at the nominal pose, joint-connected and fitted pairs included; a
   pair below its requirement blocks the check.
   `blocking_failures` names every failed blocking check.
4. Diff: `uv run --script skill://cad-flow/scripts/run.py cad-model/scripts/cad_model.py diff vA vB --hw hw` → per-part
   volume and bbox deltas, added/removed parts, exact shared / A-only / B-only volumes, and the
   manufacturing state, tolerance, output policy and placement changes per custom-made part.
5. Recheck: write the check JSON with `--out`, then pass it to `cad-recheck` `stamp.py --checks`,
   adding `--passed` only when `check` exited 0. A check with `status: warn` is advisory.
6. LOAD references/outputs.md when reading a version file, a check field, or a threshold.

Exit codes: 0 pass; 1 a part model or a manufacturing output failed (`run`, no version written) or
a blocking check failed (`check`); 2 usage or infrastructure error. `diff` exits 0 or 2. When `run`
exits 2 because it sealed a version but could not write `latest.json`, run the `cad_model.py latest
hw --label vN` command it names; never rebuild the sealed label.

## Rules

MUST Pick the next label above the newest version; versions are immutable and `run` refuses an existing or lower label.
MUST Treat `check` exit 1 as a failed stage gate; report `blocking_failures` and the numbers verbatim.
MUST Use the cad-record layout API for version and manufacturing paths; its generated `references/layout.md` is the one canonical path table.
MUST Add a missing material density to `assets/materials.yaml` with its source; `mass_g: null` means unknown.
MUST Declare press fits, as a part `pair` or as `hole` and `shaft` feature endpoints, and heat-set inserts in `hw/interfaces.yaml`; `check` classifies each fit and allows measured interference only for intentional interference fits and heat-set pairs.
DEFAULT Use `--allow-interference PN:PN` only for an undeclared, intentional overlap.
MUST Declare `build_volume` in `product.yaml` for FDM projects; a missing declaration is an advisory warning.
NOT Put a short timeout around `run`: a cold OCP import took 170 to 320 s per fresh environment.

```text
L1 MODEL {RUN|CHECK|DIFF} vN: {PASS|FAIL}, {parts} parts, {wall s}
   Blocking: {each blocking_failures entry with its part or pair and number}
   Changed: {each changed part with volume delta, only for diff}
```
CAP 60w clean · 140w with findings
