# cad-model outputs, checks, and thresholds

## Version layout (`run`)

`hw/versions/vN/`, written to a hidden partial folder and renamed when complete; a failed run
leaves nothing, and `latest.json` keeps naming the previous version. Labels increase: `run` refuses
an existing label and any label at or below the newest built version. Paths follow the cad-record
layout (`skill://cad-record/references/layout.md`); `run` refuses to seal a file the layout does not
admit.

| File | Content |
|---|---|
| `parts/<PN>.step` | AP242 (`AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF`), one free product `"<PN> <title>"`: the definition in the part's `model_frame` |
| `assembly.step` | AP242, top product `"<product id> vN"`, one product per PN and one component per occurrence at T = D P (nominal pose); an explicit occurrence's component is named `"<PN> <title> [@id]"` (cad-motion `pose.write_assembly_step`) |
| `assembly.glb` | binary glTF 2.0 of `assembly.step`: metres, +Y up, one node per occurrence named by its instance name (`"<PN> <title>"`, or `"<PN> <title> [@id]"`), mesh names = product names |
| `part-map.json` | `schema_version: 2`; `occurrences.<id>`: `PN`, `ref`, `nodes`, `node_indices`, `meshes`, matched on the exact instance name (authoritative for selection and motion); `parts.<PN>`: `product`, `occurrences`, and the aggregated `nodes`, `node_indices`, `meshes` |
| `metrics.json` | `schema_version: 2`; `parts.<PN>` (definition level, in its `model_frame`): `model_frame`, `volume_mm3`, `area_mm2`, `bbox_mm` {min, max, size}, `centre_of_volume_mm`, `solids`, `shells`, `faces`, `holes`, `material`, `density_g_cm3`, `mass_g` (unit mass), `mass_target_g`; `occurrences.<id>`: `PN`, `transform`, `bbox_mm` of the placed geometry, `centre_of_volume_mm` and `holes` carried by the placement; `totals` over occurrences (quantity-weighted), with `quantity` per PN, `parts_without_density` and `occurrences_without_density` |
| `drawing-features.json` | only when a model defines `drawing_features`: `label`, `units`, `frames.<PN>` (its `model_frame`), and `parts.<PN>` = that model's locators in that frame (semantic ID → locator, `references/contract.md`); parts without the hook are absent |
| `record/` | byte copies of the records the version was built from: `product.yaml`, `assembly.yaml`, `interfaces.yaml` when present, and `parts/<PN>/part.yaml` of every part record. `run` reads them once, before the kernels, and refuses to seal if any record or `model.py` changed during the run |
| `manufacturing/<PN>/` | every custom-made PN (below): `part.step`, `part.stl` for an FDM part, and `manufacturing.json` |
| `manifest.json` | `schema_version: 2`. Per PN, `parts.<PN>`: `kernel`, `model_frame`, `occurrences`, `model`, `source_sha256`, `record_sha256` (part.yaml), `params` and the kernel's volume, solids and validity. Per occurrence, `occurrences.<id>`: `PN`, `ref`, `explicit`, `group` and `rest` (P). `pose` holds `values` (independent joints at nominal, coupled joints derived from them; a derived value outside its limits fails the run) and, per occurrence, `transforms` (T) and `motions` (D). `joints` lists each joint with occurrence-id `parent` and `child` (a coupled joint's `nominal` is null); `joint_pairs` lists their sorted pairs with `joint` id and `type` (an `--attach` joint is fixed, id `attach:<REF>`). `record` maps each snapshot path to its sha256; `manufacturing.<PN>` is each custom-made PN's manufacturing entry (below). Also: `ground`, `tools`, `glb`, `drawing_features` and the `files` sha256 map of every file but itself. |

A file without `schema_version` is a version 1 version, written before occurrences: it reads as one
occurrence per PN whose id is the PN (cad-render `scripts/versions.py`, `built_occurrences`, the
one reader for render, viewer and check). A newer schema is refused. Versions are never rewritten.
Definition metrics and bboxes are in each part's model frame, read back from the per-part STEP.
Every volume is BRepGProp's adaptive integration to 1e-9 relative (cad-motion `pose.VOLUME_EPS`,
through `pose.volume_properties`, which cad-motion's sweep uses too); the default fixed-order rule
is off by up to ~6e-6 on revolved and filleted B-spline faces.
Mass is solid-material mass: `volume_mm3 * density / 1000`, density from `assets/materials.yaml`.

`holes` lists the part's cylindrical bores (`cadmodel/holes.py`), sorted by (`diameter_mm`,
`position`), `[]` when there are none:

```json
{"id": "H1", "diameter_mm": 5.0, "axis": [0.0, 0.0, -1.0], "position": [10.0, 15.0, 8.0],
 "depth_mm": 8.0, "through": true}
```

- A bore is the concave cylindrical faces of one solid on one axis line with one radius (within
  1e-4 mm) that close the full circle on each axial slice; slices are cut at every face boundary.
  Seam-split faces side by side close it. Faces that only follow each other along the axis (a
  half-round channel cut in two pieces) do not. A convex cylinder (boss, pin) is not a hole;
  neither is a stretch that covers less than the full circle (slot end, concave fillet, open
  channel). Slots and non-cylindrical cut-outs are not listed.
- An end is open when a face across its rim reaches more than 1e-4 mm outside the bore radius:
  a boundary face, a slot, a cross bore, a larger coaxial step, or a lead-in chamfer or round.
  There is no minimum lead-in angle: a chamfer of half-angle α and axial length L opens the end
  once L·tan α > 1e-4 mm. An end is closed when every face across its rim stays within the
  radius: a flat floor, a drill point, a ball end, a corner radius, or a counterbore shoulder.
- Two stretches on one axis make one bore only when both facing ends are open, as in a clevis pin
  bore across its slot. Otherwise each is its own bore, as with two blind holes drilled from
  opposite faces.
- Each coaxial step is its own bore. A Ø5 through hole with a Ø9 x 3 counterbore lists the Ø5
  through from the shoulder, and the Ø9 blind with depth 3 down to the shoulder. They share the
  axis line, and the larger bore's floor (`position + axis * depth_mm`) is one end of the smaller
  bore. Steps are not merged into one entry because each is its own tool and depth, which is what
  a manufacturability check reads, and because the step chain stays recoverable from the axis.
- `diameter_mm` is rounded to 3 decimals. `depth_mm` is the axial length of the cylindrical wall,
  entry chamfers, rounds and drill points excluded, gaps across slots included.
- `through` is true when the bore is open at both ends.
- `axis` is the unit drilling direction and `position` the axis point at the entry end. A blind
  bore enters at its open end. A through bore enters so its axis points down: the first non-zero
  component of z, y, x is negative.
- Detection reads the STEP read-back, so both kernels list the same holes.

`hw/versions/latest.json` names the newest successful version, every path relative to `hw/`:

```json
{"label": "v3", "assembly_step": "versions/v3/assembly.step",
 "parts": {"LMP-0001": "versions/v3/parts/LMP-0001.step"},
 "glb": "versions/v3/assembly.glb", "metrics": "versions/v3/metrics.json",
 "part_map": "versions/v3/part-map.json", "manifest": "versions/v3/manifest.json",
 "manufacturing": {"LMP-0001": "versions/v3/manufacturing/LMP-0001"}}
```

With a `drawing-features.json` it also has `"drawing_features": "versions/v3/drawing-features.json"`.
When `run` sealed a version but could not write `latest.json`, it exits 2, keeps the version and
names the command that points the pointer at it: `cad_model.py latest <hw> --label vN`. That
command checks every file of the newest version against its manifest first and rebuilds nothing.

`run` stdout: `status`, `label`, `version_dir`, per-part `kernel`/`volume_mm3`/`solids`/`mass_g`,
`manufacturing` per custom-made PN (`status`, `complete`, `path`, `process`, `state`),
`timings_s` (`<kernel>_import_s`, `<kernel>_runner_wall_s`, `manufacturing_s`, `glb_s`, `total_s`).
On exit 1: `findings`, one per failed part: `pn`, `check`, `type`, `message`, `where`, plus
`runners` timings when the kernels ran. `check` is one of:

- `contract`: a model folder not named by its PN, or a missing or unsupported `KERNEL`
  (`type` `ContractError`, `where` null)
- `kernel`: the part's `KERNEL` differs from `--kernel` (`ContractError`, `where` null)
- `build`: the runner's exception `type`, with `where` = `model.py:<line> in <function>`, null when
  the failure is not in model.py
- `manufacture`: a refused part.yaml `manufacture` declaration (`ContractError`, before any kernel
  runs), or a failed manufacturing check (`ManufactureError`). The message names each failed
  check and condition, and `manufacturing.<PN>` carries the part's rows.

`product.yaml` can declare a printer volume for FDM parts:

```yaml
build_volume:
  x_mm: 256 # Bambu Lab X1/P1 class printer envelope
  y_mm: 256
  z_mm: 256
  orientations: [xyz, xzy, yxz, yzx, zxy, zyx] # optional; defaults to all six axis permutations
  margin_mm: 5 # optional; removed from both ends of each usable axis
```

`cadmodel/orientation.py` is the one owner of build orientation, for `run` and `check`. It tests the
part's axis-aligned box under each permitted permutation. A permutation names which part axis each
printer axis takes: `xzy` maps part X to printer X, part Y to printer Z and part Z to printer Y.
Alone that can be a mirror, so the printer X row is reversed whenever the plain permutation has
determinant -1; every rotation is proper. `xyz` wins when it fits, else the lowest print height,
then the largest XY clearance, then the name. The margin reduces each usable printer axis at both
ends.

When no permutation fits, it tries the minimum-volume oriented box. Its axes, each signed so that
its largest component is positive, go to the printer axes in every order under the same
preference. Every candidate is rotated and its box measured again; only a measured fit counts.

`check.build_volume` fits each FDM part in the state it is printed in: the manufacturing STEP of a
version with manufacturing outputs (already on the bed, so `xyz` fits), else the definition. It
reads the printer and the process from the version's record snapshot. Each row reports
`orientation`, `method`, `size_mm`, `model_frame_size_mm` (the size of the shape fitted),
`rotation` (rows: the printer axes in part coordinates) and `determinant`; an oriented fit also
repeats `rotation` as `axes`. If neither box fits, the row names the PN, size, printer volume, and
both fit failures. An undeclared volume warns without blocking. Non-FDM parts are ignored.

## Manufacturing outputs

A part is custom-made when part.yaml has `make_buy: make` or `procurement.mode: made_to_drawing`
(cad-record `layout.custom_made`); a catalogue buy has no manufacturing output. `run` writes
`manufacturing/<PN>/` for each custom-made PN, once per PN however many occurrences place it:

| File | Content |
|---|---|
| `part.step` | AP242, exact B-rep, millimetres, one product `"<PN> <title>"` (the state is metadata, never a second PN) with its geometry in the bed frame, not placed by a location |
| `part.stl` | FDM only: binary STL in millimetres, tessellated from `part.step` with absolute deflections, 0.05 mm and 0.1 rad unless part.yaml `manufacture.mesh` declares others. STL carries no units; `manufacturing.json` states them |
| `manufacturing.json` | the manifest entry below, `files` (sha256 of `part.step` and `part.stl`), and the check rows `run` measured |

The state is the installed definition, or the `build_manufacture(params)` shape of a part whose
part.yaml declares `manufacture.relationship: different` (`references/contract.md`). An FDM part is
placed on the printer bed of `product.yaml` `build_volume` (above): turned by one proper rotation
from `cadmodel/orientation.py`, its box centred in X and Y, its lowest point at Z 0. The margin
reserves size; it never lifts the part. Without a declared volume, or without a fit, the part keeps
its native +Z (with a declared volume it is still centred; without one its box corner sits at the
origin) and is incomplete. A CNC or made-to-drawing part keeps its model frame (identity).

The manifest entry `manufacturing.<PN>` holds:

- identity: `PN`, `rev`, `title`, `product`, `material`, `process`, `finish`, and `eligibility`
  (`make_buy`, `procurement_mode`)
- `state`: `relationship`, `name`, `reason`, `decision`, and `source` (`build_manufacture` or
  `installed definition`)
- `tolerance`: `volume_rel`, `volume_abs_mm3` and `allowed_mm3`, the larger of the absolute floor
  and the relative share of the installed volume. cad-record `manufacture_policy` gives 1e-9
  relative for a part made as installed, and the declared values otherwise.
- `installed` (`step`, `sha256`, the kernel volume and solids) and `native` (the manufacturing
  state's kernel volume, solids, validity and errors)
- `units` mm, `up` +Z, `build_volume` (FDM: size, margin, usable size, orientations) and `mesh`
  (FDM: format and deflections)
- `placement`: `method` (axis_aligned, oriented, native or identity), `orientation`, `bed`
  (centred, origin or null), `transform` (3x4 rows, unrounded) and `determinant`
- `path`, `outputs`, `files` (sha256 of every output, the sidecar included), `status`, `complete`
  and `blocking_failures`

A custom-made PN without a model.py gets `path: null`, `status: warn`, `complete: false` and a
`message`.

Each part row has `status` (pass|warn|fail), `complete`, `blocking_failures` and `checks`; each
check has `status`, `blocking` and `failed`, the conditions that do not hold:

| Check | Fails when |
|---|---|
| `outputs` | a file the layout requires for the process is missing, another file is present, or a file's sha256 differs from the manifest (`check` only) |
| `record` | `PN`, `rev`, `material`, `process` or `finish` differs from the version's part.yaml snapshot |
| `native` | the manufacturing state is not a valid B-rep (BRepCheck in the kernel), has no solid, or has no positive volume |
| `identity` | the manufacturing state's kernel volume differs from the installed one by more than `allowed_mm3`, compared unrounded, or their solid counts differ. Equal volume is not proof of the same holes, walls or material |
| `step` | `part.step` is not AP242 or does not declare millimetres only. It holds anything but one product `"<PN> <title>"` at identity. It is an invalid B-rep, or has another solid count than the state. Its read-back volume differs from the state's kernel volume by more than 1e-6 relative |
| `mesh` | FDM: `part.stl` is not binary, or holds a non-finite coordinate. After welding by position and dropping collapsed triangles, a triangle has an area of 1e-12 mm^2 or less. It is not watertight, not consistently wound, or has non-positive signed volume (inward). It has another shell count than the STEP. Its volume differs from the STEP's by more than area x (deflection + float32 rounding), or a box face sits farther than the deflection inside the STEP's. Nothing is repaired, so a crack stays open |
| `placement` | the transform is not a proper rotation (orthonormal, determinant +1 within 1e-9); an FDM part does not touch Z 0 within 1e-6 mm; a CNC part is not at identity. An FDM part outside the reserved extents of the declared volume (X and Y: margin to size - margin; Z: 0 to size - 2 margin), or without a declared volume, warns and is incomplete |

Any failed check fails the run (exit 1): no version, no new `latest.json`. A part is `complete` when
every check passes; incompleteness (no build volume, no fit, no model) warns without blocking.
cad-model does not resolve `drawing.manufacturing.build_direction` datums; cad-drawings compares the
declared direction with `placement.transform`.

## Check result (`check`)

Top level: `status` pass|fail, `label`, `pose: nominal`, `baseline` (previous label or null),
`blocking_failures`, `warnings`, `checks`, `timings_s` (`total_s`; `pair_evaluations`, the pairs
measured, and `disk_hits`, the pairs read from the pair cache). Every check has `status`
(pass|fail|warn) and `blocking`.

| Check | Blocking | Fails when |
|---|---|---|
| `step_readback` | yes | a STEP schema is not AP242; a product name differs from `"<PN> <title>"` in the part or assembly STEP; the top product is missing; a read-back volume differs from the kernel volume by more than 1e-6 relative; the read-back solid count differs from the kernel's |
| `build_volume` | yes | neither the AABB permutations nor the minimum-volume oriented box of the printed shape fit within the printer volume after margin; missing `build_volume` warns without blocking |
| `artifact_integrity` | yes | a file of the version is missing, changed, unlisted in the manifest `files`, a link or special file (`problems`; cad-record `layout.verify`) |
| `manufacturing` | yes | a custom-made PN of the record snapshot has no manufacturing entry, a manufacturing entry or folder belongs to no custom-made PN, or a part row fails (`parts.<PN>`, the rows above, judged again on the sealed files). `complete` is true when every part is complete; an incomplete part warns. A version built before manufacturing outputs warns, `blocking: false` |
| `brep_validity` | yes | BRepCheck rejects the kernel's in-memory shape or the STEP read-back |
| `solid_structure` | yes | a part has no solid, or its solid count differs from `--expect-solids` or else from the previous version; `--expect-solids` naming a PN outside the version fails (`unknown_parts`) |
| `interference` | yes | two parts share more than 1e-3 mm^3 at the nominal pose, unless the pair is a declared interference fit or heat-set insert (below) or `--allow-interference` names an undeclared intentional overlap; a declared interference fit that measures no interference is reported in `declared_fit_findings` and fails; a pair whose measurement failed (`error`, `interference_mm3` null) fails even when allowed; `--pair` or `--allow-interference` naming a PN outside the version fails (`unknown_pairs`, `unknown_allowed`); joint-connected pairs are listed under `joint_pairs`, others under `pairs`; `min_clearance` names the closest pair |
| `pair_clearance` | yes | a clearance requirement in `hw/interfaces.yaml` (`type: clearance`, `pair`, `min_clearance_mm`, resolved by cad-motion's `pair_policy.py`) measures below its `min_clearance_mm` at the nominal pose, compared unrounded; its pair's measurement failed (`error`); or the version has no such occurrence pair. A requirement binds its pair whatever joins it, so it also binds a joint-connected or fitted pair. Each `requirements` row has `pair` (occurrence ids), `refs`, `required_mm`, `clearance_mm`, `status` (pass/fail), `interface` and YAML `source`; with no requirement declared the check passes |
| `connection` | yes | the two parts of a fixed joint or `--attach` are more than 0.01 mm apart (`fixed_joints`: `joint`, `pair`, `distance_mm`, `ok`); or a part is `disconnected` (nearest part > 2.0 mm away), or `floating` (0.01 to 2.0 mm) without a movable joint (revolute, prismatic) linking its rigid body to the nearest part's; `touching` is <= 0.01 mm. Fixed joints weld their parts into one rigid body, so a float to a part of the same body is never a joint clearance. Each `parts` row has `nearest`, `distance_mm`, `joint` (the movable joint between the two bodies, else null), `joint_connected` |
| `mesh_watertight` | yes | a part's GLB triangles, welded by position, are not a closed 2-manifold (trimesh); triangles whose corners weld to fewer than three vertices (BRepMesh emits one at a sphere pole on a face boundary) are dropped first and counted in `collapsed_triangles` |
| `slivers_tolerances` | no (warn) | a face is smaller than 1e-3 mm^2, or a vertex/edge/face tolerance exceeds 0.01 mm |

`--pair PN:PN` restricts `interference` to the named pairs; every pair still feeds `connection`.
Clearance and shared volume come from cad-motion's pair measurer (`pair_measure.py`, around
`pose.interference`), the one `sweep.py` uses at every pose. It places part b's definition by
T_a^-1 T_b in part a's definition frame. The distance is the BRepExtrema minimum distance, 0 when
one part lies inside a solid of the other, a solid of a compound part included. Within 1e-6 mm,
the shared volume is the non-destructive Boolean common (fuzzy 1e-7 mm), measured with the adaptive
volume rule. By default (`--jobs 1`), check measures in this process on OCCT's thread pool.
`--jobs N` measures in N worker processes, largest pairs first; `auto` is the CPU count, at most 8.
Measurements go through cad-motion's pair cache
(`$XDG_CACHE_HOME/cad-motion/pairs.sqlite`, else `~/.cache/cad-motion`; `--cache DIR` moves it,
`--no-cache` skips it). The cache is keyed by both parts' geometry and the exact placement. A check
of v2 after v1 measures only the pairs whose part or placement changed, and a hit is the value a
measurement gives.

Declared fits and inserts come from `hw/interfaces.yaml`. `declared_pairs` lists each press fit with
its `fit`, `classification`, `interface` and YAML `source`. A fit that names feature endpoints
instead of a `pair` also carries `endpoints`: `hole` and `shaft`, each with `PN`, `feature` and an
optional `region`. `declared_heat_sets` lists each `limits.heat_set` entry with its sorted `pair`,
`host` PN, `insert` designation, `hole_d`, `interface` and `source`. A heat-set pair passes with or
without measured overlap, because a model can draw the insert at its bore size.

A tolerant B-rep fails `step_readback` on purpose: when filleted edges carry tolerances of
0.01 to 0.1 mm, a STEP round trip rebuilds their face boundaries and moves the volume by about
1e-5, and again on each further trip. Fix the model (tangent-continuous outlines under fillets),
not the bound.

## Diff result (`diff`)

`a`, `b`, `added`, `removed`, `changed`, `error`, and `parts.<PN>`: `status`
(unchanged|changed|added|removed|error), `volume_a_mm3`, `volume_b_mm3`, `volume_delta_mm3`,
`volume_delta_rel`, `bbox_delta_mm` {min, max, size}, `solids_a`, `solids_b`, and the exact
Boolean volumes `shared_mm3`, `a_only_mm3`, `b_only_mm3` of the zero-pose part shapes. A part is
`unchanged` when both exclusive volumes are within 1e-6 relative of zero. When the kernel fails
on those Booleans the part is `error`, its exact volumes are null and `error` carries the
message; whether it changed is unknown.

`manufacturing` compares the manifest manufacturing entries apart from the definitions, so a
change to the manufacturing state alone shows. It has `changed`, the PNs that changed, were added
or were removed, and `parts.<PN>` with `status` (unchanged, changed, added or removed) and
`changed`, the aspects that differ: `state`, `tolerance`, `output_policy` (mesh deflections or
build volume), `geometry` (the state's kernel volume or solids) and `placement`. Each row also has
`relationship_a`/`_b` and `volume_a_mm3`/`_b`. When a version was built before manufacturing
outputs, it is `available: false`.
