# Part model script contract

`hw/parts/<PN>/model.py`, one per part, next to its `part.yaml`.

| Name | Required | Contract |
|---|---|---|
| `KERNEL` | yes | top-level string literal, `"cadquery"` or `"build123d"`; read with `ast`, never by import |
| `PARAMS` | yes | dict of JSON-serialisable defaults; lengths in mm, angles in degrees |
| `build(params)` | yes | returns one part: a solid, or a compound when the part is several solids |

- `build` receives a private copy of `PARAMS`; the manifest records the values it received.
- Accepted return values: CadQuery `Shape` or `Workplane` (every stack object; several become one
  compound), build123d `Shape`/`Part`/`Compound` or a `BuildPart` builder (`.part`).
- Geometry is in assembly coordinates at the zero joint pose (every joint value 0), the
  `cad-motion` convention. `run` places parts at the joints' nominal values for `assembly.step`.
- The STEP product name is `"<PN> <title>"`, title from `part.yaml`; the script never names it.
- Import only the declared kernel, OCP, the standard library, `cadmodel.safe`, and the kernel's
  warehouse: `bd_warehouse` 0.4.0 is in the build123d environment. `cq_warehouse` is not on PyPI
  and is not in the CadQuery environment.
- `print` output and OCCT console messages are runner console output; the runner returns its result
  in a file the orchestrator names, so console output never corrupts it.

## Kernel environments

| Runner | Pins | Python |
|---|---|---|
| `scripts/run_cadquery.py` | cadquery 2.8.0, cadquery-ocp 7.9.3.1.1, vtk 9.6.2 | 3.12 |
| `scripts/run_build123d.py` | build123d 0.13.0, cadquery-ocp-novtk 8.0.1.1.0, bd_warehouse 0.4.0 | 3.12 |
| `scripts/cad_model.py` (orchestrator) | cadquery-ocp-novtk 8.0.1.1.0, pyyaml, trimesh 4, numpy | 3.11-3.14 |

The two kernels' OCP builds clash, so each runner is its own uv script environment, started as a
subprocess. With `--kernel auto` and parts in both kernels, both runners run concurrently: each is
fed its request and drained by its own thread. When one runner fails, the other is killed with its
uv process group before the partial version folder is removed, so a failed run leaves nothing.
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
