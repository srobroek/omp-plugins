# Changelog

## 0.1.0

### Features

- Scope cad-viewer hosts by project and harness or named session; add idle shutdown and per-session stop instructions.
- Add runtime preflight for CAD tools, kernel environments, drawing templates, and harness installation.
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
- Add per-pair clearance requirements: an `interfaces.yaml` `type: clearance` interface names a `pair` and `min_clearance_mm`, validated by `cad-record`, held by cad-model `check` (`pair_clearance`) at the nominal pose and by cad-motion `sweep.py` at every sample, joint-connected and fitted pairs included; `--pair-clearance REF:REF=MM` adds or overrides one for a run, and a cached pair measurement near a threshold is measured again. A pair declared as a press fit, running fit or heat-set insert no longer inherits the sweep's global `--min-clearance`, and the `minimum_clearance` worst case ranks each pair against its tightest requirement.
- Add bounded `--jobs` capture in cad-render. Each Chromium page loads the scene once and captures its assigned views concurrently. Seed GTAO noise per view/retry and invalidate floor-shadow bakes when visible geometry or framing changes so parallel images remain deterministic.
