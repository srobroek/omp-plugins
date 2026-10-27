---
name: cad-motion
description: Poses jointed assemblies, sweeps joints for interference, picks the worst-case FEA pose. Triggers on "pose the arm", "sweep the joints", "does it collide".
---

# CAD Motion

Stage L1 LAYOUT (joints and limits in `assembly.yaml`) and L4 ANALYSIS (sweep, worst-case pose for FEA).
Numbers come from the scripts. Kinematic only: no masses, forces, speeds, or dynamics.

TRIGGER
+ "pose the arm at J-002=-90", "export the folded pose", "check the joint limits"
+ "sweep the joints", "does the head hit the base", "minimum clearance", "reach envelope"
+ "worst-case pose for FEA", "simulate the assembly in FreeCAD"
++ "couple the cams to the crank", "sweep the engine through 720 degrees", "do the valves hit the pistons"
- joint record authoring or schema questions → `cad-record`
- the static FEA itself, fits, or 1D stack-ups → `cad-analysis` (later), `cad-fits`
- animation in the viewer → later follow-up; this skill has no viewer output

## Workflow

Every script takes `--hw hw` plus the part definitions as one of:
`--version vN|latest` (a cad-model version's `hw/versions/vN/parts/`; `latest` via
`hw/versions/latest.json`), `--parts-dir DIR` (one `<PN>.step` per part), or `--step ASSEMBLY.step`
(leaf products named PN first). Pass a cad-model version with `--version`: its `assembly.step` is
posed at the nominal joint values, and `--step` refuses it when any nominal is non-zero. A part
without a joint needs a `fixed` joint or `--attach REF=PARENT_REF`. Revolute values are degrees,
prismatic mm. Full contract: each script's docstring.

Occurrences: a PN placed several times has one occurrence per placement in `assembly.yaml`
(`occurrences`, `@id` references); joints attach to occurrences, so moving one leaves its
siblings. A REF is `@id`, or a PN placed once; a bare PN placed twice is refused as ambiguous.
Results key placements by occurrence id and report pairs as REFs. Each occurrence's placement is
T = D P: its joint motion D times its rest placement P, applied once to the PN's definition.

Coupled joints (`scripts/coupling.py`): a movable joint with a `coupling` instead of a `nominal`
derives its value from a driver joint, through one of three laws:

- `linear`: `ratio` and `offset`, for gears, belts, or a cam at 1:2.
- `periodic_table`: a named `profiles` entry (degrees in, mm or degrees out, piecewise linear)
  shifted by `phase_deg`, for cam lift.
- `slider_crank`: a shared `mechanisms` entry (crank axis, bank axis, crank radius, rod length,
  phase). `output: displacement` goes on the prismatic piston joint, `output: rod_angle` on the
  rod's revolute joint, a child of the piston through the TDC wrist.

Coordinates stay unwrapped: a four-stroke crank runs 0..720. Limits apply to derived values too.
Only independent joints take `--set`; setting a coupled one exits 2 and names its driver. The
FreeCAD Assembly simulation drives every joint independently, so `freecad_assembly.py` refuses a
record with couplings (exit 2). Verify coupled motion with `pose.py` and `sweep.py`.

1. Pose: `uv run --script skill://cad-flow/scripts/run.py cad-motion/scripts/pose.py --hw hw --version vN --set J-002=-90 --out posed.step`
   → posed STEP AP242 with product names kept. A value outside [min, max] exits 1 with a
   `joint_limit` finding and writes no STEP.
2. Sweep: `uv run --script skill://cad-flow/scripts/run.py cad-motion/scripts/sweep.py --hw hw --version vN --worst-step worst.step
   [--steps 19] [--grid 3] [--min-clearance MM] [--pair-clearance REF:REF=MM] [--include-pair REF:REF] [--end-effector REF]`
   → JSON: `collisions` (sample, independent and complete pose, pair, volume), `min_clearance` per
   pair with its pose, `pair_clearance` per clearance requirement, `limit_findings`,
   `reach_envelope`, `worst_case` (written to `--worst-step`, evidence in `<worst-step>.json`), and
   `timings_s`. Only independent joints are sampled; every coupled joint is derived at each sample.
   `--worst-criterion` picks the worst case:
   `max_horizontal_reach` (default; collision-free poses, the end effector's cantilever arm),
   `minimum_clearance` (smallest clearance margin), or `maximum_interference` (largest undeclared
   overlap). One-driver engine over 720 degrees at 5 degree steps:
   `uv run --script skill://cad-flow/scripts/run.py cad-motion/scripts/sweep.py --hw hw --version vN --steps 145 --grid 0 --worst-criterion minimum_clearance --worst-step worst.step`
   Pair requirements: the sweep measures every clearance requirement in `hw/interfaces.yaml`
   (`type: clearance`, `pair: [REF, REF]`, `min_clearance_mm`, such as valve-to-piston >= 1 mm) at
   every sample. `--pair-clearance REF:REF=MM` adds a requirement for one run or overrides the
   record's on that pair (`overrides` names it). Each `pair_clearance` row reports the pair,
   `required_mm`, the smallest `clearance_mm` with its sample and pose (the larger overlap breaks a
   tie at 0 mm), `samples_below`, `status`, and its `source`. A row below its requirement exits 1.
3. FreeCAD: `uv run --script skill://cad-flow/scripts/run.py cad-motion/scripts/freecad_assembly.py --hw hw --version vN [--report-part REF]`
   → JSON: `frames`, start/mid/end `placements`, per-joint `limit_check`, `violations`, `residuals`.
4. Record each result as a `verification.csv` row: `requirement_id` from requirements.yaml,
   `result` pass|fail from the exit code, `evidence` = script, inputs, pose, and key numbers.
5. Hand `worst.step` to the FEA load case with `evidence: worst.step.json` (cad-analysis checks the
   STEP hash and pose, never re-poses); cite its pose in the FEA row. The clearance and
   interference criteria select geometric poses; a stress case needs its own load criterion.

Exit codes for all scripts:

- 0: pass.
- 1: a check failed. `sweep.py` reports joint-limit, collision, clearance and pair-requirement
  findings, `pose.py` joint-limit findings, and `freecad_assembly.py` violations and residuals.
- 2: a usage or infrastructure error, or a sweep stopped by `--time-limit`.

## Limits

- A sweep samples discrete poses. Passing proves those poses only, not the motion between them;
  state `steps_per_joint` and `grid_per_joint` beside every sweep result. Refine with more steps or
  pose the suspect configuration with `pose.py`.
- Per-joint sweeps hold the other independent joints at nominal; only the grid combines them.
  Coupled joints are never sampled on their own.
- Interference checks cover every occurrence pair except joint-connected parent/child pairs; `--include-pair` adds such a pair back.
  Two occurrences of one PN are checked like any other pair. An overlap declared in
  `interfaces.yaml` (interference press fit, heat-set insert) on exactly that occurrence pair is
  not a collision (`pair_policy.py`, shared with cad-model `check`).
- Collision and clearance differ. The collision and `--min-clearance` checks leave out
  joint-connected pairs, and a declared fit or insert excuses its pair's overlap. Neither exempts
  a pair from its own clearance requirement: the sweep measures it at every sample.
- The sweep caches a pair measurement by the two definitions and their relative placement. When a
  threshold lies within the most the placement difference can move a cached distance, the sweep
  measures the pair again (`threshold_rechecks` in `timings_s`). No cached value decides a verdict
  across a threshold.
- FreeCAD 1.1.4 stores AngleMin/AngleMax but its solver does not enforce them; `freecad_assembly.py`
  measures every frame itself. freecadcmd exiting 139 after its completion marker is a warning.

## Rules

MUST Treat exit 1 as a check failure that blocks the stage gate; exit 2 is no result.
MUST Report collision poses and the smallest clearances verbatim from the JSON.
NOT Claim continuous collision freedom from a sweep.
NOT Take the worst-case pose from intuition; it comes from `sweep.py` `worst_case`.

```text
L1 MOTION {POSE|SWEEP|FREECAD}: {PASS|FAIL}, {poses or frames}, {timing}
   Collisions: {pose and pair per entry, only if any}
   Clearance: {the three smallest pairs with pose}
   Pair requirements: {pair, required, measured minimum and pose per failing row, only if any}
   Worst case: {criterion, pose, metric, STEP path}
```
CAP 80w clean · 160w with findings
