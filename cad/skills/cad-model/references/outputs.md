# cad-model outputs, checks, and thresholds

## Version layout (`run`)

`hw/versions/vN/`, written to a hidden partial folder and renamed when complete; a failed run
leaves nothing.

| File | Content |
|---|---|
| `parts/<PN>.step` | AP242 (`AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF`), one free product `"<PN> <title>"`, zero pose |
| `assembly.step` | AP242, top product `"<product id> vN"`, each part a component at the nominal pose (cad-motion `pose.write_step`) |
| `assembly.glb` | binary glTF 2.0 of `assembly.step`: metres, +Y up, node and mesh names = product names, one mesh per part |
| `part-map.json` | `parts.<PN>`: `product`, `nodes`, `node_indices`, `meshes` in the GLB |
| `metrics.json` | `parts.<PN>`: `volume_mm3`, `area_mm2`, `bbox_mm` {min, max, size}, `centre_of_volume_mm`, `solids`, `shells`, `faces`, `material`, `density_g_cm3`, `mass_g`, `mass_target_g`; `totals` |
| `manifest.json` | `parts.<PN>`: `kernel`, `model`, `source_sha256`, `params`, `kernel_volume_mm3`, `kernel_solids`, `kernel_valid`, `kernel_errors`; `tools` per environment with `import_s`; `pose` (values, transforms); `joint_pairs`; `ground`; `glb` tessellation; `files` sha256 |

Metrics and bboxes are in assembly coordinates at the zero pose, read back from the per-part STEP.
Mass is solid-material mass: `volume_mm3 * density / 1000`, density from `assets/materials.yaml`.

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
`findings`, one per failed part: `pn`, `check` (`contract`, `kernel`, `build`), `type`, `message`,
`where` (`model.py:<line> in <function>`).

## Check result (`check`)

Top level: `status` pass|fail, `label`, `pose: nominal`, `baseline` (previous label or null),
`blocking_failures`, `warnings`, `checks`, `timings_s`. Every check has `status`
(pass|fail|warn) and `blocking`.

| Check | Blocking | Fails when |
|---|---|---|
| `step_readback` | yes | a STEP schema is not AP242; a product name differs from `"<PN> <title>"` in the part or assembly STEP; the top product is missing; a read-back volume differs from the kernel volume by more than 1e-6 relative; the read-back solid count differs from the kernel's |
| `brep_validity` | yes | BRepCheck rejects the kernel's in-memory shape or the STEP read-back |
| `solid_structure` | yes | a part has no solid, or its solid count differs from `--expect-solids` or else from the previous version |
| `interference` | yes | two parts share more than 1e-3 mm^3 at the nominal pose, unless `--allow-interference` names the pair; joint-connected pairs are listed under `joint_pairs`, others under `pairs`; `min_clearance` names the closest pair |
| `connection` | yes | a part is `disconnected` (nearest part > 2.0 mm away) or `floating` (0.01 to 2.0 mm) without a joint; `touching` is <= 0.01 mm |
| `mesh_watertight` | yes | a part's GLB triangles, welded by position, are not a closed 2-manifold (trimesh) |
| `slivers_tolerances` | no (warn) | a face is smaller than 1e-3 mm^2, or a vertex/edge/face tolerance exceeds 0.01 mm |

`--pair PN:PN` restricts `interference` to the named pairs; every pair still feeds `connection`.

## Diff result (`diff`)

`a`, `b`, `added`, `removed`, `changed`, and `parts.<PN>`: `status`
(unchanged|changed|added|removed), `volume_a_mm3`, `volume_b_mm3`, `volume_delta_mm3`,
`volume_delta_rel`, `bbox_delta_mm` {min, max, size}, `solids_a`, `solids_b`, and the exact
Boolean volumes `shared_mm3`, `a_only_mm3`, `b_only_mm3` of the zero-pose part shapes. A part is
`unchanged` when both exclusive volumes are within 1e-6 relative of zero.
