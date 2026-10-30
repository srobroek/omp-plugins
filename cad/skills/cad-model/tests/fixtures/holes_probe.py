# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["cadquery-ocp-novtk==8.0.1.1.0", "pyyaml>=6.0"]
# ///
"""Write two plates as per-part STEP, read them back, and print `holes.holes` for each as JSON.

TST-0001: 40 x 30 x 8 plate on z 0..8 with a Ø5 through hole on (10, 15) and a Ø3 x 4 blind hole
drilled from the top on (30, 15). TST-0002: the same plate carrying a convex Ø6 x 5 boss on (20, 15).
Usage: uv run --script holes_probe.py DIR  (stdout: {PN: holes})
"""

import json
import sys
from pathlib import Path

from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from cadmodel import holes  # noqa: E402
from cadmodel.motion import load_pose  # noqa: E402


def cylinder(x: float, y: float, z: float, d: float, h: float):
    return BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(x, y, z), gp_Dir(0, 0, 1)), d / 2.0, h).Shape()


plate = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), 40.0, 30.0, 8.0).Shape()
drilled = BRepAlgoAPI_Cut(BRepAlgoAPI_Cut(plate, cylinder(10, 15, -1, 5, 10)).Shape(), cylinder(30, 15, 4, 3, 5)).Shape()
bossed = BRepAlgoAPI_Fuse(plate, cylinder(20, 15, 8, 6, 5)).Shape()

pose = load_pose()
folder = Path(sys.argv[1])
for pn, title, shape in (("TST-0001", "Drilled plate", drilled), ("TST-0002", "Bossed plate", bossed)):
    pose.write_part_step(folder / f"{pn}.step", pose.Part(pn, f"{pn} {title}", shape))
parts = pose.load_definitions(folder, folder)
print(json.dumps({pn: holes.holes(part.shape) for pn, part in sorted(parts.items())}))
