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
- Add eleven Beads formulas: the `cad-touch`, `cad-part`, and `cad-product` orchestrator roots, whose stages fan out bondable worker molecules (`mol-cad-variant`, `mol-cad-part`, `mol-cad-sourcing`, `mol-cad-detail`, `mol-cad-analysis`) in one parallel batch before one lead integration step and one human gate, plus the `mol-cad-concept`, `mol-cad-iterate`, and `mol-cad-release` sub-workflows.
- Add the `cad-concept-designer`, `cad-part-designer`, `cad-sourcing-researcher`, and `cad-analyst` worker agents. A part designer builds and checks a scratch copy of `hw/` (`cad-flow/scripts/scratch.py`) and delivers only its own part directories, so `hw/versions/` changes only in the lead's integrated builds.
- Generate Claude Code, Kiro, and OpenCode files for every CAD agent from the canonical OMP agents, with write access only under `.cad-work/` and shell access only for `uv`.
- Add the eval harness for cross-harness/model trials, geometry and record graders, smoke tests, and pairwise judging.
