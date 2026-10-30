# Sweep internals

How `sweep.py` decides what to measure, what it proves between samples, and how subsystem runs
merge. The script docstrings hold the full contract.

## Fast sweeps

A sweep measures a pair-pose with pose.py's `interference`, the one rule; fast mode only decides
which pair-poses need it (pair_measure.py, mesh_bound.py).

- Planning: the sweep poses each occurrence's mesh-vertex box once per sample and gives every
  request the gap between its two boxes less sqrt(3) x both mesh deviations, a lower bound that no
  BRep is posed for (`posed_boxes`, `planned_requests` in `timings_s`).
- Repeats: a revolute angle and a slider-crank angle are reduced to (-180, 180] and snapped to
  1e-9 degree before their sine and cosine, so a crank at q and q + 360 places its 360 degree train
  with the very same bits, and a piston at -theta from TDC as at +theta. Each distinct key is
  evaluated once: a constant relative pose and a periodic repeat need no special case. A reused
  exact reading is the one a fresh measurement gives; a hit on the rounded relative transform alone
  is only a bound, inflated by how far the body can move within the rounding (`cache-bound`).
- Clearing: a request whose own lower bound exceeds 1e-6 mm and its pair's clearing threshold (the
  greatest requirement plus its margin) by more than `--mesh-band` (default 2 mm) is not measured
  (`cleared_box`, `cleared_mesh`). The bound is the corrected box gap, else the mesh bound: each
  part tessellated once (0.02 mm linear, 0.2 rad angular deflection) into a python-fcl BVH, the BVH
  distance minus each part's deviation, kept only where no vertex of one part can lie inside a
  solid of the other. Meshes that touch, nest or come within the band always measure exactly.
  What is cleared depends on each request alone, so `--jobs` and a cold or warm cache report the
  same JSON.
- Reporting: every measured value is exact. A pair whose minimum may lie at a cleared request is a
  bounded row: `method` "mesh", "box" or "cache-bound", `clearance_mm` the proved lower bound,
  `bound_mm` [lower, upper] (upper null when only a box gap is known), rounded outward. Collisions,
  findings, margin warnings, verdicts, the worst case whenever its margin is within the band, and
  every `method: "exact"` row equal `--exact`'s; bounded rows bracket the exact minimum instead.
- Suspects: every exact measurement is checked against its box and mesh bounds, in fast mode and
  with `--exact` alike (BRepExtrema has read 0 mm for parts 8 mm apart). A suspect value answers
  nothing: it is re-measured with every independent joint +-0.1 and with the two parts swapped, and
  listed in `suspect_measurements` with its re-measurements. One they do not resolve fails the
  sweep: a suspect never passes or fails silently.
- Spot check, on by default in fast mode (`--no-spot-check` skips it): per pair with a
  mesh-cleared request, the one of the smallest bound is measured exactly. It must lie inside its
  bounds, above threshold + band - 2 x the deflection, without overlap, or the sweep fails
  (`spot_check`). `spot_check.py --hw hw --version vN --result hw/motion/vN/<case>
  [--all-mesh-poses] [--no-cache]` audits a published sweep the same way, with `--all-mesh-poses`
  every unique mesh-cleared pose; `--no-cache` measures each one again.
- Resume: each task's results are committed to the cache as the task finishes, so a killed sweep
  rerun with the same cache measures only what it had not committed.
- Counters in `timings_s` (`kernel_evaluations`, `fcl_queries`, `exact_hits`, `bucket_hits`,
  `committed_chunks`, per-phase seconds) let a cold, a warm and an `--exact` run diff; a warm
  rerun evaluates nothing.
- Without python-fcl (no wheel for the platform), the BRep box gap alone clears, nothing is
  checked against a mesh, the between-sample check is off, and `broad_phase.mesh` says why.

## Between-sample check

On by default (`--no-continuous` skips it; `--smoke` never runs it). Along each one-dimensional path
of the sweep (each independent joint across its range with the others at nominal, each grid edge),
every pair's interval between consecutive samples is bounded from the samples' lower bounds and a
sampled motion rate: the largest corner displacement of either part's mesh box, inflated by its
deviation, in the other's frame on a `--continuous-grid-deg`/`--continuous-grid-mm` grid, times
`--continuous-safety`. An interval not proved collision-free is bisected up to
`--continuous-depth` times, its midpoints measured in bound mode and cached like samples.

`continuous.status` is one of:

- `proved_collision_free`: every interval is proved.
- `finding`: a collision or clearance finding between samples. It fails the sweep (exit 1) and
  replays at its `pose`.
- `incomplete`: some interval is not proved, and a `continuous` row in `warnings` names the pairs
  and paths. The sampled verdict stands and the exit code does not change, unless
  `--require-continuous` is set (then `status: incomplete`, exit 2).
- `disabled`: no proof ran, because of `--no-continuous` or `--smoke`, or because the mesh bounds
  are unavailable (`continuous.reason`). `--require-continuous` refuses the first two (exit 2) and
  treats the third as `incomplete`.

Resolve an incomplete proof by sweeping the unproved pairs' subsystem (`--subsystem`) with a finer
`--steps` or a deeper `--continuous-depth`, until it reads `proved_collision_free`, or accept the
remaining intervals in a decision record (DR).

Proved collision-free and proved to the clearance minimum are reported apart: a sliding
near-constant gap can prove the first only, and then its exact sampled minimum stays the evidence.
The guarantee is conditional (`rigorous: false`): the rate is sampled, not derived from joint-rate
Jacobians, and coverage is the sweep's paths, not the whole joint space (`continuous.limitation`).

## Subsystems

The record's subassemblies own the pairs (`subsystems.py`). Subassembly ids are unique, and each
moving occurrence must belong to exactly one; a moving/static pair belongs to the moving part's
subassembly, a pair of two subassemblies' moving parts to `interface`, a static pair to `static`.
`subsystems.owners` reports each owner's members, pair and finding counts, and its period per
independent joint, detected from the transforms over a whole verified cycle (a 5.5:1 starter
pinion on its crank is 720 degrees).
`--subsystem NAME` (repeatable; `interface` and `static` too) measures only that owner's pairs over
the same samples. Merge runs that together cover every owner (one run, when a single owner owns
every pair):

`uv run --script skill://cad-flow/scripts/run.py cad-motion/scripts/merge_sweeps.py --hw hw --version vN --case NAME --inputs hw/motion/vN/A hw/motion/vN/B ...`

The merge refuses inputs swept with other options, partition, rule or code, a missing or doubly
measured pair, or an unfinished run. It publishes the result the whole sweep gives, with the worst
pose posed again.
