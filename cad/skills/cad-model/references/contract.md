# Part model script contract

`hw/parts/<PN>/model.py`, one per part, next to its `part.yaml`.

| Name | Required | Contract |
|---|---|---|
| `KERNEL` | yes | top-level string literal, `"cadquery"` or `"build123d"`; read with `ast`, never by import |
| `PARAMS` | yes | dict of JSON-serialisable defaults; lengths in mm, angles in degrees |
| `build(params)` | yes | returns one part: a solid, or a compound when the part is several solids |
| `drawing_features(params, shape)` | no | returns semantic feature locators for drawings; see below |

- `build` receives a private copy of `PARAMS`; the manifest records the values it received.
- Accepted return values: CadQuery `Shape` or `Workplane` (every stack object; several become one
  compound), build123d `Shape`/`Part`/`Compound` or a `BuildPart` builder (`.part`).
- Geometry is in the part's `model_frame` (part.yaml). `assembly_zero`, the default, is assembly
  coordinates at the zero joint pose (every joint value 0), the `cad-motion` convention, and admits
  one identity-placed occurrence. `part_local` is the definition's own origin and axes; each
  `assembly.yaml` occurrence places it (`placement`: rotation about the local origin, then
  translation). A part placed more than once, or anywhere but identity, is `part_local`; nothing
  guesses a frame from the geometry. `run` places each occurrence at T = D P (joint motion at the
  nominal values times the rest placement) for `assembly.step`; `parts/<PN>.step` keeps the frame.
- Drawing feature locators carry the same `frame` as the part's `model_frame`.
- The STEP product name is `"<PN> <title>"`, title from `part.yaml`; the script never names it.
- Import only the declared kernel, OCP, the standard library, `cadmodel.safe`, and the kernel's
  warehouse: `bd_warehouse` 0.4.0 is in the build123d environment. `cq_warehouse` is not on PyPI
  and is not in the CadQuery environment.
- `print` output and OCCT console messages are runner console output; the runner returns its result
  in a file the orchestrator names, so console output never corrupts it.

## Drawing feature locators

`drawing_features(params, shape)` gets its own copy of `PARAMS` and the value `build` returned,
after every cut, fillet and chamfer. It returns a dict of semantic ID → locator, made of JSON
primitives only (a kernel object fails the part with a `ContractError`):

```python
{"hub_bore": {"kind": "bore", "frame": "assembly_zero",
              "patches": [{"support_type": "cylinder", "point_mm": [12.0, 0.0, 4.0],
                           "normal": [-1.0, 0.0, 0.0], "region": "head_side_cheek"}],
              "anchors": {"entry": {"point_mm": [9.0, 0.0, 8.0], "direction": [0.0, 0.0, -1.0]}},
              "relations": {"coaxial_with": ["press_band"]}}}
```

- Semantic IDs, `kind`, `region`, anchor and relation names are lower_snake_case; relations name
  other IDs of the same result. `frame` is always `assembly_zero`, the coordinates `build` returns.
- `support_type` is one of `plane`, `cylinder`, `cone`, `sphere`, `torus`, `bezier`, `bspline`,
  `revolution`, `extrusion`, `offset`, `other`. `normal` and `direction` are unit vectors.
- Each patch is a witness point on a final surface with its normal, taken from the kernel's own
  selectors, such as CadQuery `faces("%CYLINDER")` with `normalAt(u, v)` or build123d
  `filter_by(GeomType.CYLINDER)` with `position_at`/`normal_at`. A feature holds one patch per
  surface span, such as both cheek spans of a clevis bore. Witnesses identify geometry; drawings
  measure every value from the STEP, so never put dimensions here.
- Without the hook the model still builds; producer-ready drawings need it.

## Kernel environments

| Runner | Pins | Python |
|---|---|---|
| `scripts/run_cadquery.py` | cadquery 2.8.0, cadquery-ocp 7.9.3.1.1, vtk 9.6.2 | 3.12 |
| `scripts/run_build123d.py` | build123d 0.13.0, cadquery-ocp-novtk 8.0.1.1.0, bd_warehouse 0.4.0 | 3.12 |
| `scripts/cad_model.py` (orchestrator) | cadquery-ocp-novtk 8.0.1.1.0, pyyaml, trimesh 4, numpy | 3.11-3.14 |

The OCP builds of the two kernels clash, so each runner has its own uv environment.
`cadmodel.scriptenv` starts each runner as a subprocess:

    uv run --isolated --no-project --python <requires-python> --with-requirements <runner> python <runner>

uv keys that environment by the resolved dependency set of the header and by the interpreter, not
by the path of the runner. Every copy of the plugin therefore loads the same installed kernel,
whether it is a project's skill copy, an eval trial, or a worktree.

With `--kernel auto` and parts in both kernels, both runners run concurrently: each is fed its
request and drained by its own thread. When one runner fails, the other is killed with its uv
process group before the partial version folder is removed, so a failed run leaves nothing.
Every file the orchestrator writes after the runners (assembly, GLB, metrics, checks) is computed
from the per-part STEP files through one OCP, so the JSON is identical whichever kernel built a
part. cad-design's `build_reference.py` builds its reference models through the same runners.

## Safe edits

`from cadmodel.safe import safe_cut, safe_fuse, safe_intersect, SafeEditError`

| Call | Refused when the result volume V is outside |
|---|---|
| `safe_cut(shape, *tools)` | V(shape) - sum V(tools) <= V <= V(shape) |
| `safe_fuse(shape, *others)` | max V(inputs) <= V <= sum V(inputs) |
| `safe_intersect(shape, *others)` | 0 < V <= min V(inputs) |

Also refused: an invalid, null, non-solid, or non-positive-volume input; a kernel error; an
invalid or solid-free result; a result whose solid members overlap. Bounds allow 1e-7 relative
(at least 1e-6 mm^3) of kernel noise. The result keeps the first argument's type: CadQuery
`Shape` → cast `Shape`, `Workplane` → new `Workplane`, build123d `Part` → `Part`, other build123d
shapes → cast shape. A refusal raises `SafeEditError`; `run` reports it per part with the
`model.py` line and writes no version.
