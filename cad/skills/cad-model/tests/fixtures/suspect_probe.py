# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["cadquery-ocp-novtk==8.0.1.1.0", "pyyaml>=6.0", "numpy>=1.26", "python-fcl==0.7.0.11"]
# ///
"""Feed check's pair geometry a degenerate kernel reading, as BRepExtrema gave a stand and a clutch
8.04 mm apart (0.0 mm), and report what the static check makes of it.

TST-0401 and TST-0402: two 10 mm cubes 8.04 mm apart along X. `pose.interference` is patched so
that its first reading, or every reading, is (0.0, 0.0). Scenarios:
  exact_first:      exact mode, the first reading degenerate (re-evaluations are real)
  exact_every:      exact mode, every reading degenerate
  required_first:   exact mode on an exact-required pair (a fixed joint), the first reading degenerate
  fast:             fast mode, no patch: the mesh bound clears the pair, no kernel reading
Usage: uv run --script suspect_probe.py DIR
stdout: {scenario: {"row": geometry row, "interference": status, "clearance": status,
"suspects": [suspect report], "kernel_evaluations": n}}.
"""

import json
import sys
from pathlib import Path

from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.gp import gp_Pnt

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from cadmodel import check  # noqa: E402
from cadmodel.motion import load_pose  # noqa: E402

pose = load_pose()
folder = Path(sys.argv[1])
cubes = {"TST-0401": (0.0, 0.0, 0.0), "TST-0402": (18.04, 0.0, 0.0)}
with pose.stdout_to_stderr():
    for pn, (x, y, z) in cubes.items():
        shape = BRepPrimAPI_MakeBox(gp_Pnt(x, y, z), gp_Pnt(x + 10, y + 10, z + 10)).Shape()
        pose.write_part_step(folder / f"{pn}.step", pose.Part(pn, f"{pn} Cube", shape))
    parts = pose.load_definitions(folder, folder)
real = pose.interference
mesh, _ = check.mesh_bounds({pn: part.shape for pn, part in parts.items()})
pair = ("a", "b")
requirement = {"pair": list(pair), "min_clearance_mm": 0.5, "margin_mm": 0.1, "interface": "IF-001",
               "source": "interfaces.yaml#/interfaces/0"}


def degenerate(every: bool):
    calls = []

    def reading(*args, **kwargs):
        calls.append(1)
        return (0.0, 0.0) if every or len(calls) == 1 else real(*args, **kwargs)
    return reading


report = {}
for name, exact, required, patched in (("exact_first", True, False, degenerate(False)),
                                       ("exact_every", True, False, degenerate(True)),
                                       ("required_first", True, True, degenerate(False)),
                                       ("fast", False, False, real)):
    pose.interference = patched
    spec = check.PairSpec("TST-0401", "TST-0402", pose.Rigid.identity(), 0.6, required)
    with pose.stdout_to_stderr():
        geometry, suspects, measurer = check.pair_geometry(parts, {pair: spec}, mesh=mesh, exact=exact, nearest=False)
    report[name] = {"row": geometry[pair], "suspects": suspects,
                    "interference": check.interference(geometry, None, set(), set())["status"],
                    "clearance": check.pair_clearance(geometry, [requirement])["status"],
                    "kernel_evaluations": measurer.counters.kernel_evaluations}
pose.interference = real
print(json.dumps(report))
