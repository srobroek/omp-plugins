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
- joint record authoring or schema questions → `cad-record`
- the static FEA itself, fits, or 1D stack-ups → `cad-analysis` (later), `cad-fits`
- animation in the viewer → later follow-up; this skill has no viewer output

## Workflow

Every script takes `--hw hw` plus zero-pose geometry (all joint values 0) as one of:
`--version vN|latest` (a cad-model version's `hw/versions/vN/parts/`; `latest` via
`hw/versions/latest.json`), `--parts-dir DIR` (one `<PN>.step` per part), or `--step ASSEMBLY.step`
(leaf products named PN first). Pass a cad-model version with `--version`: its `assembly.step` is
posed at the nominal joint values, and `--step` refuses it when any nominal is non-zero. A part
without a joint needs a `fixed` joint or `--attach PN=PARENT_PN`. Revolute values are degrees,
prismatic mm. Full contract: each script's docstring.

1. Pose: `uv run --script skill://cad-motion/scripts/pose.py --hw hw --version vN --set J-002=-90 --out posed.step`
   → posed STEP AP242 with product names kept. A value outside [min, max] exits 1 with a
   `joint_limit` finding and writes no STEP.
2. Sweep: `uv run --script skill://cad-motion/scripts/sweep.py --hw hw --version vN --worst-step worst.step
   [--steps 19] [--grid 3] [--min-clearance MM] [--include-pair PN:PN] [--end-effector PN]`
   → JSON: `collisions` (pose + pair + volume), `min_clearance` per pair with its pose,
   `reach_envelope`, `worst_case` (max horizontal reach of the end effector's centre of mass,
   collision-free poses only; written to `--worst-step`), and `timings_s`.
3. FreeCAD: `uv run --script skill://cad-motion/scripts/freecad_assembly.py --hw hw --version vN [--report-part PN]`
   → JSON: `frames`, start/mid/end `placements`, per-joint `limit_check`, `violations`, `residuals`.
4. Record each result as a `verification.csv` row: `requirement_id` from requirements.yaml,
   `result` pass|fail from the exit code, `evidence` = script, inputs, pose, and key numbers.
5. Hand `worst_case.pose` and `worst.step` to the FEA load case; cite its pose in the FEA row.

Exit codes for all scripts: 0 pass, 1 check failure (limit, collision, clearance, FreeCAD
violation or residual), 2 usage/infrastructure error or a sweep stopped by `--time-limit`.

## Limits

- A sweep samples discrete poses. Passing proves those poses only, not the motion between them;
  state `steps_per_joint` and `grid_per_joint` beside every sweep result. Refine with more steps or
  pose the suspect configuration with `pose.py`.
- Per-joint sweeps hold the other joints at nominal; only the grid combines joints.
- Joint-connected pairs are excluded from interference checks unless `--include-pair` names them.
- FreeCAD 1.1.4 stores AngleMin/AngleMax but its solver does not enforce them; `freecad_assembly.py`
  measures every frame itself. freecadcmd exiting 139 after its completion marker is a warning.

## Rules

MUST Treat exit 1 as a check failure that blocks the stage gate; exit 2 is no result.
MUST Report collision poses and the smallest clearances verbatim from the JSON.
NOT Claim continuous collision freedom from a sweep.
NOT Take the worst-case pose from intuition; it comes from `sweep.py` `worst_case`.

OUTPUT
L1 MOTION <POSE|SWEEP|FREECAD>: <PASS|FAIL>, <poses or frames>, <timing>
   Collisions: pose and pair per entry, only if any
   Clearance: the three smallest pairs with pose
   Worst case: pose, reach mm, STEP path
CAP 80w clean · 160w with findings
