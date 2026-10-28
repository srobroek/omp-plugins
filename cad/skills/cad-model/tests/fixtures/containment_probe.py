# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["cadquery-ocp-novtk==8.0.1.1.0", "pyyaml>=6.0"]
# ///
"""Measure a 2 mm cube buried in a 10 mm cube, no faces touching, through check's pair geometry.

TST-0302: the cube x, y, z 4..6. TST-0303: the container 0..10, a SOLID. TST-0301: the container
plus a 1 mm cube at x 20..21, which reads back as a COMPOUND of two solids. Each container is
measured with the buried cube in both argument orders.
Usage: uv run --script containment_probe.py DIR
stdout: {"shape_types": {PN: type}, "solid"|"compound": {"container_first"|"buried_first":
{clearance_mm, interference_mm3, status}}}, status being check's interference verdict.
"""

import json
import sys
from pathlib import Path

from OCP.BRep import BRep_Builder
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.TopoDS import TopoDS_Compound
from OCP.gp import gp_Pnt

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from cadmodel import check  # noqa: E402
from cadmodel.motion import load_pose  # noqa: E402


def box(x0: float, y0: float, z0: float, x1: float, y1: float, z1: float):
    return BRepPrimAPI_MakeBox(gp_Pnt(x0, y0, z0), gp_Pnt(x1, y1, z1)).Shape()


def compound(*shapes):
    result, builder = TopoDS_Compound(), BRep_Builder()
    builder.MakeCompound(result)
    for shape in shapes:
        builder.Add(result, shape)
    return result


pose = load_pose()
folder = Path(sys.argv[1])
shapes = {"TST-0301": compound(box(0, 0, 0, 10, 10, 10), box(20, 0, 0, 21, 1, 1)),
          "TST-0302": box(4, 4, 4, 6, 6, 6), "TST-0303": box(0, 0, 0, 10, 10, 10)}
with pose.stdout_to_stderr():
    for pn, shape in shapes.items():
        pose.write_part_step(folder / f"{pn}.step", pose.Part(pn, f"{pn} Probe", shape))
    parts = pose.load_definitions(folder, folder)
report = {"shape_types": {pn: part.shape.ShapeType().name for pn, part in sorted(parts.items())}}
at = pose.Rigid.identity()
for name, container in (("solid", "TST-0303"), ("compound", "TST-0301")):
    report[name] = {}
    for order, ids in (("container_first", ("a-container", "b-buried")), ("buried_first", ("b-container", "a-buried"))):
        placements = {ids[0]: (container, at), ids[1]: ("TST-0302", at)}
        geometry, _ = check.pair_geometry({pn: part.shape for pn, part in parts.items()}, placements)
        (entry,) = geometry.values()
        report[name][order] = {**entry, "status": check.interference(geometry, None, set(), set())["status"]}
print(json.dumps(report))
