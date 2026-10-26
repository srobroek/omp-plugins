# cad-model outputs, checks, and thresholds

## Version layout (`run`)

`hw/versions/vN/`, written to a hidden partial folder and renamed when complete; a failed run
leaves nothing. Labels increase: `run` refuses an existing label and any label at or below the
newest built version.

| File | Content |
|---|---|
| `parts/<PN>.step` | AP242 (`AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF`), one free product `"<PN> <title>"`, zero pose |
| `assembly.step` | AP242, top product `"<product id> vN"`, each part a component at the nominal pose (cad-motion `pose.write_step`) |
| `assembly.glb` | binary glTF 2.0 of `assembly.step`: metres, +Y up, node and mesh names = product names, one mesh per part |
| `part-map.json` | `parts.<PN>`: `product`, `nodes`, `node_indices`, `meshes` in the GLB |
| `metrics.json` | `parts.<PN>`: `volume_mm3`, `area_mm2`, `bbox_mm` {min, max, size}, `centre_of_volume_mm`, `solids`, `shells`, `faces`, `holes`, `material`, `density_g_cm3`, `mass_g`, `mass_target_g`; `totals` |
| `manifest.json` | `parts.<PN>`: `kernel`, `model`, `source_sha256`, `params`, `kernel_volume_mm3`, `kernel_solids`, `kernel_valid`, `kernel_errors`; `tools` per environment with `import_s`; `pose` (values, transforms); `joint_pairs` (`pair`, `joint` id, `type`: revolute, prismatic, or fixed; `--attach` joints are fixed, id `attach:<PN>`); `ground`; `glb` tessellation; `files` sha256 |

Metrics and bboxes are in assembly coordinates at the zero pose, read back from the per-part STEP.
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
  1e-4 mm): seam-split faces and coaxial stretches across a slot (a clevis pin bore) are one bore.
  A convex cylinder (boss, pin) is not a hole; neither is a stretch that covers less than the full
  circle (slot end, concave fillet, open channel). Slots and non-cylindrical cut-outs are not listed.
- `diameter_mm` is rounded to 3 decimals. `depth_mm` is the axial length of the cylindrical wall,
  entry chamfers and drill points excluded, gaps across slots included.
- `through` is true when the bore opens onto a boundary face at both ends; an end closed by a
  floor (flat or drill point) makes it blind.
- `axis` is the unit drilling direction and `position` the axis point at the entry end. A blind
  bore enters at its open end. A through bore enters so its axis points down: the first non-zero
  component of z, y, x is negative.
- Detection reads the STEP read-back, so both kernels list the same holes.

`hw/versions/latest.json` names the newest successful version, every path relative to `hw/`:

```json
{"label": "v3", "assembly_step": "versions/v3/assembly.step",
 "parts": {"LMP-0001": "versions/v3/parts/LMP-0001.step"},
 "glb": "versions/v3/assembly.glb", "metrics": "versions/v3/metrics.json",
 "part_map": "versions/v3/part-map.json", "manifest": "versions/v3/manifest.json"}
```

Graders, renderers, and viewers resolve the current files through it. A GLB node belongs to a
part when its name starts with the PN.

`run` stdout: `status`, `label`, `version_dir`, per-part `kernel`/`volume_mm3`/`solids`/`mass_g`,
`timings_s` (`<kernel>_import_s`, `<kernel>_runner_wall_s`, `glb_s`, `total_s`). On exit 1:
`findings`, one per failed part: `pn`, `check`, `type`, `message`, `where`, plus `runners` timings
when the kernels ran. `check` is `contract` (a model folder not named by its PN, or a missing or
unsupported `KERNEL`; `type` `ContractError`, `where` null), `kernel` (the part's `KERNEL` differs
from `--kernel`; `ContractError`, `where` null), or `build` (the runner's exception `type`, `where`
= `model.py:<line> in <function>`, null when the failure is not in model.py).

## Check result (`check`)

Top level: `status` pass|fail, `label`, `pose: nominal`, `baseline` (previous label or null),
`blocking_failures`, `warnings`, `checks`, `timings_s`. Every check has `status`
(pass|fail|warn) and `blocking`.

| Check | Blocking | Fails when |
|---|---|---|
| `step_readback` | yes | a STEP schema is not AP242; a product name differs from `"<PN> <title>"` in the part or assembly STEP; the top product is missing; a read-back volume differs from the kernel volume by more than 1e-6 relative; the read-back solid count differs from the kernel's |
| `brep_validity` | yes | BRepCheck rejects the kernel's in-memory shape or the STEP read-back |
| `solid_structure` | yes | a part has no solid, or its solid count differs from `--expect-solids` or else from the previous version; `--expect-solids` naming a PN outside the version fails (`unknown_parts`) |
| `interference` | yes | two parts share more than 1e-3 mm^3 at the nominal pose, unless `--allow-interference` names the pair; a pair whose measurement failed (`error`, `interference_mm3` null) fails even when allowed; `--pair` or `--allow-interference` naming a PN outside the version fails (`unknown_pairs`, `unknown_allowed`); joint-connected pairs are listed under `joint_pairs`, others under `pairs`; `min_clearance` names the closest pair |
| `connection` | yes | the two parts of a fixed joint or `--attach` are more than 0.01 mm apart (`fixed_joints`: `joint`, `pair`, `distance_mm`, `ok`); or a part is `disconnected` (nearest part > 2.0 mm away), or `floating` (0.01 to 2.0 mm) without a movable joint (revolute, prismatic) linking its rigid body to the nearest part's; `touching` is <= 0.01 mm. Fixed joints weld their parts into one rigid body, so a float to a part of the same body is never a joint clearance. Each `parts` row has `nearest`, `distance_mm`, `joint` (the movable joint between the two bodies, else null), `joint_connected` |
| `mesh_watertight` | yes | a part's GLB triangles, welded by position, are not a closed 2-manifold (trimesh); triangles whose corners weld to fewer than three vertices (BRepMesh emits one at a sphere pole on a face boundary) are dropped first and counted in `collapsed_triangles` |
| `slivers_tolerances` | no (warn) | a face is smaller than 1e-3 mm^2, or a vertex/edge/face tolerance exceeds 0.01 mm |

`--pair PN:PN` restricts `interference` to the named pairs; every pair still feeds `connection`.
Clearance and shared volume come from cad-motion's `pose.interference`, the rule `sweep.py` applies
at every pose: BRepExtrema minimum distance, and within 1e-6 mm the non-destructive Boolean common
(fuzzy 1e-7 mm) measured with the adaptive volume rule.

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
