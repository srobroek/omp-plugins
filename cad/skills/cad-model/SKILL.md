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
   drawing. LOAD references/contract.md when writing or reviewing a model.py.
2. Build: `uv run --script skill://cad-model/scripts/cad_model.py run hw --label vN [--kernel auto]`
   → `hw/versions/vN/` and `hw/versions/latest.json`; JSON summary on stdout. `auto` runs each
   part in its declared kernel's own uv environment; `cadquery` or `build123d` additionally
   requires every part to declare that kernel.
3. Check: `uv run --script skill://cad-model/scripts/cad_model.py check vN --hw hw [--out FILE]`
   → check result JSON. `build_volume` checks each FDM part against `hw/product.yaml`'s printer envelope.
   It reports an axis-aligned orientation when one fits. Otherwise, it reports the oriented box axes.
   Oversized parts block the check. An undeclared volume warns without blocking.
   `blocking_failures` names every failed blocking check.
4. Diff: `uv run --script skill://cad-model/scripts/cad_model.py diff vA vB --hw hw` → per-part
   volume and bbox deltas, added/removed parts, exact shared / A-only / B-only volumes.
5. Recheck: write the check JSON with `--out`, then pass it to `cad-recheck` `stamp.py --checks`,
   adding `--passed` only when `check` exited 0. A check with `status: warn` is advisory.
6. LOAD references/outputs.md when reading a version file, a check field, or a threshold.

Exit codes: 0 pass; 1 a part model failed (`run`, no version written) or a blocking check failed
(`check`); 2 usage or infrastructure error. `diff` exits 0 or 2.

## Rules

MUST Pick the next label above the newest version; versions are immutable and `run` refuses an existing or lower label.
MUST Treat `check` exit 1 as a failed stage gate; report `blocking_failures` and the numbers verbatim.
MUST Resolve current files through `hw/versions/latest.json`, never by guessing a version path.
MUST Add a missing material density to `assets/materials.yaml` with its source; `mass_g: null` means unknown.
MUST Declare press fits, as a part `pair` or as `hole` and `shaft` feature endpoints, and heat-set
inserts in `hw/interfaces.yaml`; `check` classifies each fit and allows measured interference only
for pairs classified as interference fits and for heat-set pairs. A declared interference fit that
measures clearance is a blocking finding.
DEFAULT Use `--allow-interference PN:PN` only for an undeclared, intentional overlap.
MUST Declare `build_volume` in `product.yaml` for FDM projects; a missing declaration is an advisory warning.
NOT Put a short timeout around `run`: a cold OCP import took 170 to 320 s per fresh environment.
NOT Hand-edit files under `hw/versions/`; rebuild under a new label.

```text
L1 MODEL {RUN|CHECK|DIFF} vN: {PASS|FAIL}, {parts} parts, {wall s}
   Blocking: {each blocking_failures entry with its part or pair and number}
   Changed: {each changed part with volume delta, only for diff}
```
CAP 60w clean · 140w with findings
