# Part model script contract

`hw/parts/<PN>/model.py`, one per part, next to its `part.yaml`.

| Name | Required | Contract |
|---|---|---|
| `KERNEL` | yes | top-level string literal, `"cadquery"` or `"build123d"`; read with `ast`, never by import |
| `PARAMS` | yes | dict of JSON-serialisable defaults; lengths in mm, angles in degrees |
| `build(params)` | yes | returns one part: a solid, or a compound when the part is several solids |
| `drawing_features(params, shape)` | no | returns semantic feature locators for drawings; see below |
| `build_manufacture(params)` | only with a declared state | returns the part in its manufacturing state, such as a bent strap's flat blank; see below |

`build` receives a private copy of `PARAMS`; the manifest records the declared values. A model that
sets `REQUIRES_OSIFONT = True` additionally receives the resolved, verified `font_path` at build
time; runner context is not persisted as a design parameter.
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

### Text fonts

Text geometry MUST use a path to a font file. Set `REQUIRES_OSIFONT = True` to use FreeCAD TechDraw Osifont.
The runner asks cad-flow preflight for its FreeCAD command. It checks the bundled font's SHA-256 before the build.
Then it passes `font_path` to the private copy of `build(params)`. That path is execution context, not a design parameter.

Pass `font_path` to build123d or `fontPath` to CadQuery. Do not select a font by family name alone.
The source parser refuses `text()` or `Text()` calls without an explicit font-file path.
An explicit path may name another font, but only Osifont bytes are pinned by the runner.

If FreeCAD or the pinned font is missing, the runner fails the part. It does not use the host's default font.
This fail-closed rule prevents publishing geometry with text that changes by host.
The font is FreeCAD 1.1.4's 114,764-byte `osifont-lgpl3fe.ttf` file.
Its SHA-256 is `f681b2419818198a8421b9db01602862367dbc3338c0e8e963fda73f545262b8`.
The license allows LGPL v3, GPL v2, or GPL v3, each with the GPL font exception.


Candidate inventory: the pinned CadQuery/OCP environment includes Matplotlib 3.11.2 and DejaVuSans
(756,072 bytes, SHA-256 `3fdf69cabf06049ea70a00b5919340e2ce1e6d02b0cc3c4b44fb6801bd1e0d22`) on both
hosts. Its Bitstream Vera / Arev license permits redistribution when notices are included. The
build123d 0.13.0 environment includes ReliefSingleLineCAD (53,496 bytes, SHA-256
`8b30ea7ea8a2b17fb9d5c70b5c7c37e6a9285b4f8aced4fbd646bc591dba59b3`), licensed under OFL-1.1.
Neither option was selected: these are not the established drawing lettering face, and Osifont is
available byte-identically through FreeCAD on both systems. The independent matplotlib fonts are
not shared by the build123d environment; ReliefSingleLineCAD is not shared by CadQuery.

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

## Manufacturing state

`run` writes the manufacturing outputs of every custom-made part (`references/outputs.md`). A part
made in its installed shape needs nothing: its definition is reused, not built again. A part
manufactured in another state, such as a TPU strap that is printed flat and bent when it is
installed, declares that state in part.yaml and builds it in `build_manufacture(params)`:

```yaml
manufacture:
  relationship: different
  state: flat               # lower_snake_case name of the state
  reason: elastic_bending   # why the states differ
  decision: DR-007          # the decision record approving the difference
  volume_rel_tolerance: 1.0e-6     # and/or volume_abs_tolerance_mm3: the allowed volume difference
  mesh: {linear_deflection_mm: 0.05, angular_deflection_rad: 0.1}   # optional, FDM part.stl
```

```python
def build_manufacture(params: dict):
    length = math.radians(params["angle"]) * (params["inner_radius"] + params["thickness"] / 2)
    return cq.Solid.makeBox(length, params["thickness"], params["width"])
```

- The hook runs exactly when part.yaml declares `relationship: different`; a hook without that
  declaration, a declaration without a hook, and a hook that is not callable each fail the part with
  a `ContractError`. A `different` declaration also needs `state`, `reason`, `decision` and a
  positive volume tolerance; one without them is refused before any kernel runs.
- It receives its own private copy of the same `PARAMS` that `build` gets and returns a shape as
  `build` does. It writes no files.
- It cannot change the PN, revision or material: part.yaml stays their authority, and the STEP
  product keeps the name `"<PN> <title>"`.
- Share construction between `build` and `build_manufacture` through private helpers of the
  model.py, so both states follow one set of parameters.
- Model the state in any frame and orientation: `run` sets an FDM part on the printer bed itself
  (one proper rotation, no mirror) and keeps a CNC part in its model frame.
- The run fails and writes no version when the state differs from the installed definition. That
  is a kernel volume difference beyond the declared tolerance, another solid count, or an invalid
  B-rep. Equal volume does not prove the same holes, walls or material, so the state's rationale
  stays a reviewed engineering decision.

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

The runner rejects invalid, null, non-solid, or zero-volume inputs.
It rejects kernel errors and invalid results.
Results must contain solids that do not overlap.

Volume bounds allow 1e-7 relative kernel noise, or at least 1e-6 mm^3.
An operation preserves the first argument's type.
CadQuery `Shape` and `Workplane` inputs keep their types.
Build123d `Part` inputs remain `Part` values.
Other build123d shapes return as shapes.

On refusal, the operation raises `SafeEditError`.
`run` reports the failure for that part and names its `model.py` line.
It does not write a version.
