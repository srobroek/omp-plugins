# Changelog

## 0.1.0

### Features

- Scope cad-viewer hosts by project and harness or named session; add idle shutdown and per-session stop instructions.
- Add runtime preflight for CAD tools, kernel environments, drawing templates, and harness installation.
- Add `cad-flow/scripts/setup.py`, which runs the user-level setup steps preflight reports missing. It requires FreeCAD 1.1.4 before it continues; the user installs FreeCAD from the official release and verifies its published checksum.
- Add `cad-record` for design records, `cad-concept` for three.js concept exploration, `cad-model` for CadQuery/build123d builds and checks, and `cad-design` for the F0–F3 fidelity ladder and form checks.
- Add `cad-motion` for kinematic poses/sweeps, `cad-render` for automated PBR images, and `cad-viewer` for interactive OCP inspection and Studio look-dev.
- Add `cad-recheck` for batch-boundary/dependent rechecks, `cad-fits` for fits and stack-ups, and `cad-bom` for EBOM roll-up.
- Add `cad-review-mech` and `cad-review-dfm` skills and their read-only critique agents.
- Add `cad-flow` for the staged prototype-to-release workflow; `cad-analysis` for static FEA; and `cad-drawings` for technical drawings.
- `cad-drawings` part drawings bind `drawing_features` locators to the final STEP, measure every required characteristic in the datum frame, take fit limits from cad-fits, and fail a completeness gate with the drawing architecture's codes. Catalogue items get vendor specification sheets that control only the specification's limits; a specification can be cited by url and sha256, its frozen copy recorded as a sourcing input. Every lamp template part carries drawing or procurement intent. Section views fill each cut face on its own and every face of a part alike (ISO 128-3, ASME Y14.3): 45° lining spaced a third of the part's typical width (0.7 to 3 mm), or solid when that width is under 2.1 mm; the `section_hatch` gate checks each face's filled area and each part's single fill, line density and solid-only-when-thin.
- Add assembly drawings to `cad-drawings`: ISO 6433 / ASME Y14.34 balloons on each occurrence's visible geometry, a parts list from `bom.csv`, and assembly notes whose seating is measured on the model; `assembly_check.py` re-checks a package. `cad-record` gains the `assembly.yaml` `drawing` schema, and the lamp template its drawing intent and ring occurrence pairs.
- Add eleven Beads formulas: the `cad-touch`, `cad-part`, and `cad-product` orchestrator roots, whose stages fan out bondable worker molecules (`mol-cad-variant`, `mol-cad-part`, `mol-cad-sourcing`, `mol-cad-detail`, `mol-cad-analysis`) in one parallel batch before one lead integration step and one human gate, plus the `mol-cad-concept`, `mol-cad-iterate`, and `mol-cad-release` sub-workflows.
- Add the `cad-concept-designer`, `cad-part-designer`, `cad-sourcing-researcher`, and `cad-analyst` worker agents. A part designer builds and checks a scratch copy of `hw/` (`cad-flow/scripts/scratch.py`) and delivers only its own part directories, so `hw/versions/` changes only in the lead's integrated builds.
- Generate Claude Code, Kiro, and OpenCode files for every CAD agent from the canonical OMP agents, with write access only under `.cad-work/` and shell access only for `uv`.
- Add the eval harness for cross-harness/model trials, geometry and record graders, smoke tests, and pairwise judging.
- Add per-pair clearance requirements: an `interfaces.yaml` `type: clearance` interface names a `pair` and `min_clearance_mm`, validated by `cad-record`, held by cad-model `check` (`pair_clearance`) at the nominal pose and by cad-motion `sweep.py` at every sample, joint-connected and fitted pairs included; `--pair-clearance REF:REF=MM` adds or overrides one for a run. A pair declared as a press fit, running fit or heat-set insert no longer inherits the sweep's global `--min-clearance`, and the `minimum_clearance` worst case ranks each pair against its tightest requirement.
- Measure the pairs of cad-motion `sweep.py` and cad-model `check` with one pair measurer, `cad-motion/scripts/pair_measure.py`. Every reported value is bitwise the one a separate measurement of each pair request gives. The speed-ups:
  - A pair whose bounding boxes are apart skips OCCT's containment test.
  - The sweep reuses a measurement only on the exact bits of a pair's placement, which it composes from the joints below the pair's lowest common ancestor.
  - The sweep skips a request when an exact lower bound (the box gap, or a nearby sample's distance minus the motion between them) lies beyond the pair's minimum and each of its thresholds.
  - By default (`--jobs 1`), measurements run in one process on OCCT's thread pool. `--jobs N` measures in N worker processes; `--jobs auto` uses the CPU count, at most 8.
  - A pair cache keeps measurements across runs and tools, `$XDG_CACHE_HOME/cad-motion/pairs.sqlite` (`--cache DIR`, `--no-cache`). Its key is both parts' geometry, the exact placement, the measuring code, OCP version and platform.

  On pace (32 cores, load average about 20), the lamp template's default sweep went from 1 147 s to 35 s, and to 5 s with a warm cache. After one part changed, it took 13.6 s instead of 45.6 s. Its check went from 39.0 s to 6.6 s, and to 4.0 s warm.
- Two outputs moved once with the new measurer, at float-noise level only. Exact reuse resolves a tie between equally close samples as a separate measurement does. On the V6 fixture, 17 of 210 pairs report another tied sample at the same distance. Its `minimum_clearance` worst case is now crank 640°, the 360° repeat of crank 280°, with the same pair and 0.8788 mm. On the lamp template, 8 of 66 pairs report another tied sample. cad-model `check` now measures part b in part a's definition frame, like the sweep, so that the two share cache entries. Its reported distances and volumes moved by at most 2.6e-13.
- Sweep `timings_s` drops `threshold_rechecks` and gains `pair_requests`, `pruned` and `disk_hits`. Check `timings_s` gains `pair_evaluations` and `disk_hits`. A sweep stopped by `--time-limit` reports only the leading samples it measured in full. Requests are measured out of sample order, so that can be fewer samples than before. A kernel exception during a sweep exits 2 with a message instead of a traceback.

### Bug Fixes

- The interference rule of cad-model `check` and cad-motion `sweep.py` reports a part buried inside a solid of a compound part (a definition that reads back as a COMPOUND, such as one fused from separate solids), no faces touching, as overlapping at distance 0. BRepExtrema detects containment only inside a SOLID or COMPSOLID operand, so such a part read as clear before.
