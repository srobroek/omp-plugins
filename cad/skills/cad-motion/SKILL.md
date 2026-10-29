---
name: cad-motion
description: Poses, sweeps and renders jointed assemblies for interference, worst-case FEA pose and motion video. Triggers on "pose the arm", "sweep the joints", "render the motion".
---

# CAD Motion

Stage L1 LAYOUT (joints and limits in `assembly.yaml`, the default motion render) and L4 ANALYSIS (sweep,
worst-case pose for FEA, authored motion cases).
Numbers come from the scripts. Kinematic only: no masses, forces, speeds, or dynamics.

TRIGGER
+ "pose the arm at J-002=-90", "export the folded pose", "check the joint limits"
+ "sweep the joints", "does the head hit the base", "minimum clearance", "reach envelope"
+ "worst-case pose for FEA", "simulate the assembly in FreeCAD"
+ "couple the cams to the crank", "sweep the engine through 720 degrees", "do the valves hit the pistons"
+ "render the motion", "animate the lamp", "make a video of the engine", "is all the motion shown"
- joint record authoring or schema questions → `cad-record`
- the static FEA itself, fits, or 1D stack-ups → `cad-analysis` (later), `cad-fits`
- interactive playback of a plan → `cad-viewer` `animate --case`

## Workflow

Every script takes `--hw hw` plus one of:
`--version vN|latest` (a verified cad-model version's `hw/versions/vN/parts/`, with assembly and part records read
from `hw/versions/vN/record/`), `--parts-dir DIR` (one `<PN>.step` per part), or `--step ASSEMBLY.step` (leaf
products named PN first). Pass a cad-model version with `--version`; its `assembly.step` is posed at the nominal
joint values, and `--step` refuses it when any nominal is non-zero. A part without a joint needs a `fixed` joint
or `--attach REF=PARENT_REF`. Revolute values are degrees, prismatic mm. Full contract: each script's docstring.

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
FreeCAD limit simulation drives every joint independently, so `freecad_assembly.py` refuses a record
with couplings (exit 2) unless it runs on a motion plan's frames (`--frames`, the cross-check below).
Verify coupled motion with `pose.py` and `sweep.py`.

1. Pose:
   `uv run --script skill://cad-flow/scripts/run.py cad-motion/scripts/pose.py --hw hw --version vN --set J-002=-90`
   publishes immutable `pose.step`, `result.json`, and a manifest under `hw/motion/vN/<pose-name>/` in millimetres.
   Use `--case ID` to select the bundle subject; the default is `pose`. A rerun with the same recipe reuses the
   bundle; changed settings require `--replace`, which retains the previous bundle under `.cad-work/replaced/`.
   With scratch geometry (`--step` or `--parts-dir`), pass `--out .cad-work/<unit>/posed.step`.
2. Sweep: `uv run --script skill://cad-flow/scripts/run.py cad-motion/scripts/sweep.py --hw hw --version vN
   [--case ID] [--replace] [--steps 19] [--grid 3] [--min-clearance MM] [--pair-clearance REF:REF=MM]
   [--include-pair REF:REF] [--end-effector REF] [--jobs 1|N|auto] [--cache DIR | --no-cache]`
   → immutable `hw/motion/vN/<case>/` with `worst.step`, `worst.step.json`, and `result.json`; also reports
   collisions, clearances, `reach_envelope`, and `timings_s`. With scratch geometry, `--worst-step` must be a
   new path under `.cad-work/`.
   `--jobs 1`, the default, measures in this process on OCCT's thread pool. `--jobs N` measures
   pairs in N worker processes (forkserver; spawn on macOS), each about 110 MB; `auto` is the CPU
   count, at most 8. Workers pay off for many small parts and on a busy host. The result is the
   same either way.
   Measurements persist in the pair cache, `$XDG_CACHE_HOME/cad-motion/pairs.sqlite` (else
   `~/.cache/cad-motion`; `--cache DIR` moves it), the one cad-model `check` uses. It is keyed by
   both parts' geometry, the exact placement, the measuring code, OCP version and platform, so a
   repeat measures only what changed and reports the same bits (`disk_hits`). Requirements and
   thresholds are not in the key, so changing them reuses every entry. `--no-cache` reads and
   writes none; an unusable cache file is skipped with a note on stderr.
   `--worst-criterion` picks the worst case:
   `max_horizontal_reach` (default; collision-free poses, the end effector's cantilever arm),
   `minimum_clearance` (smallest margin: a pair's distance minus its tightest requirement), or
   `maximum_interference` (largest undeclared overlap). One-driver engine over 720 degrees at 5
   degree steps, published as `hw/motion/vN/engine-cycle/`:
   `uv run --script skill://cad-flow/scripts/run.py cad-motion/scripts/sweep.py --hw hw --version vN --case engine-cycle --steps 145 --grid 0 --worst-criterion minimum_clearance`
   The same sweep on scratch geometry writes its worst-case STEP to a new `.cad-work/` path:
   `... sweep.py --hw hw --parts-dir .cad-work/UNIT/parts --steps 145 --grid 0 --worst-criterion minimum_clearance --worst-step .cad-work/UNIT/worst.step`
   Pair requirements: the sweep measures every clearance requirement in `hw/interfaces.yaml`
   (`type: clearance`, `pair: [REF, REF]`, `min_clearance_mm`, such as valve-to-piston >= 1 mm) at
   every sample. `--pair-clearance REF:REF=MM` adds a requirement for one run or overrides the
   record's on that pair (`overrides` names it). Each `pair_clearance` row reports the pair,
   `required_mm`, the smallest `clearance_mm` with its sample and pose (the larger overlap breaks a
   tie at 0 mm), `samples_below`, `status`, and its `source`. A row below its requirement exits 1.
3. FreeCAD: `uv run --script skill://cad-flow/scripts/run.py cad-motion/scripts/freecad_assembly.py --hw hw --version vN [--case ID] [--replace] [--report-part REF]`
   publishes `result.json` and its retained FreeCAD job files under `hw/motion/vN/<case>/evidence/`; its JSON summary includes
   `frames`, start/mid/end `placements`, `limit_check`, `violations`, and `residuals`.
4. Record each result as a `verification.csv` row: `requirement_id` from requirements.yaml,
   `result` pass|fail from the exit code, `evidence` = bundle path, inputs, pose, and key numbers.
5. Hand `hw/motion/vN/<case>/worst.step` and its sibling `worst.step.json` to the FEA case
   (`cad-analysis` checks the STEP hash and pose, never re-poses); cite the bundle as evidence.
   The clearance and interference criteria select geometric poses; a stress case needs its own load criterion.

Exit codes for all scripts:

- 0: pass.
- 1: a check failed. `sweep.py` reports joint-limit, collision, clearance and pair-requirement
  findings, `pose.py` joint-limit findings, and `freecad_assembly.py` violations and residuals.
- 2: a usage or infrastructure error, or a sweep stopped by `--time-limit`.

## Motion render

`scripts/motion.py` renders the motion of any built version from a motion plan; `scripts/plan.py`
expands the plan through pose.py's Chain, the only kinematics. Case `default` is generated from the
record and never authored: each independent joint nominal → min → max → nominal, then all to min,
all to max and home. An authored case lives at `hw/motion/cases/<case>/plan.yaml` (the lead
accepts it). A scratch plan is `--plan .cad-work/<unit>/plan.yaml` and renders only to `--out-dir`.

Plan schema 1: `fps`, `max_step {deg, mm}` (default 5 deg / 1 mm between frames), optional `start`,
ordered `segments` (`id`, `title`, `to: {J-…: value}` absolute targets of independent joints,
`easing: linear|ease_in_out`, `camera: iso|front|side`, or a hold `{id, hold_frames: N}`), and
`coverage: full` (default) or `partial` with `coverage_reason`. Full reference: `scripts/plan.py`.

Coverage contract: every independent joint must visit its whole `[min, max]`, and every frame,
derived joints included, stays inside its limits. A gap fails (exit 1) unless the plan declares
`partial` with a reason, which passes as `flagged`. Coupled, fixed or unknown joints and targets
outside the limits are plan errors (exit 2; a coupled joint names its driver).

1. Plan: `uv run --script skill://cad-flow/scripts/run.py cad-motion/scripts/motion.py plan --hw hw --version vN
   [--case C | --plan .cad-work/<unit>/plan.yaml] [--print-default] [--frames-out .cad-work/<unit>/frames.json]`
   prints the coverage report; `--print-default` prints the default plan as YAML to start a case from.
2. Render: `... motion.py render --hw hw --version vN [--case C] [--outputs glb,sheet,video,frames]
   [--size 1280x720] [--crosscheck freecad] [--replace] [--out-dir .cad-work/<unit>/render]` checks
   coverage first (a failure writes nothing), then publishes `hw/motion/vN/<case>/`: `plan.json`,
   `coverage.json`, `result.json`, and as asked `motion.glb` (the version's own GLB nodes and
   materials with one LINEAR clip, keys refined until the interpolation is within 0.1 mm / 0.1 deg),
   `contact-sheet.png` (the start and each segment end, captioned), `video.mp4` (H.264, constant fps)
   and `frames/`. cad-render draws the frames with one camera per segment, fitted to what the segment
   sweeps; motion frames have no floor shadow. Default outputs are `glb,sheet`: seconds, as only the
   sheet tiles render. The same recipe reuses the bundle; another needs `--replace`.
3. Cross-check: `--crosscheck freecad` first solves the coupled record in FreeCAD on the same frames
   (`freecad_assembly.py --frames`): Belt or Gears joints for parallel linear couplings, closed
   loops for slider-cranks, formulas for the rest. Every joint must agree within 1e-3, and only
   `solved` joints count as independent evidence (`crosscheck.json`, `evidence/motion.FCStd`).
   A deviation exits 1 and names the joint and frame; no FreeCAD result exits 2. The negative
   control `freecad_assembly.py --frames F --job-dir .cad-work/<unit>/fc --start far-branch` must fail.
4. MUST read the contact sheet and sample frames before reporting a render, as cad-render requires
   for PNGs.

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
  joint-connected pairs. `--min-clearance` also leaves out a pair declared as a press fit, running
  fit or heat-set insert (`pairs.declared_fit`), joint-connected or not: fitted or contacting by
  design, it inherits no global running clearance. An interference fit or an insert excuses its
  pair's overlap. None of these exempts a pair from its own clearance requirement: the sweep
  measures it at every sample.
- The sweep reuses a pair measurement within the run when the two definitions and the exact bits of
  their relative placement repeat (`cache_hits` in `timings_s`). That placement is composed from the
  joints below the pair's lowest common ancestor, so a joint that moves both parts alike leaves it
  unchanged. A reused value is the one a fresh measurement gives. A pair request whose exact lower
  bound (box gap, or a nearby sample's distance minus the motion between them) lies beyond the
  pair's minimum and each of its thresholds is not measured (`pruned`): no reported value depends on it.
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

```text
L1 MOTION RENDER vN <case>: {PASS|FLAGGED|FAIL}, {frames} frames, {segments} segments, {timings_s.total} s
   Coverage -- {summary}; derived: {unmoved_derived, only if any}
   Files -- {absolute paths: contact sheet, video, motion.glb}
```
