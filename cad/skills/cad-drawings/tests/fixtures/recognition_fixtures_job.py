"""freecadcmd job for test_feature_recognition: build the recognition fixtures, recognise each one.

Fixtures (mm, FreeCAD Part, no cad-model build): ``plate`` 60x40x10 with a 20x15x4 pocket, two
through holes d5 and a blind hole d4 x 6; ``shell`` a 50x30x20 box shelled to 2 mm walls and floor
with a 10x6 cutout through its +X wall; ``slotted`` a 50x20x5 plate with a closed slot 6 wide, 20
long and 3 deep; ``chamfered_boss`` a 30x30x5 plate with a d6 boss 10 high whose top edge has a
0.5 mm chamfer; ``drafted_dish`` a 60 long tub whose long walls are 3 thick at the rim (z = 20) and
drafted 3 deg wider toward the floor, a spherical dish 0.8 deep and 16 across in its 3 mm floor, and
under the floor a dovetail 20 wide at its bed (z = -8) with 70 deg flanks. The result maps each
fixture to its faces and recognition.
"""

import json
import math
import os
import sys
import traceback

import FreeCAD as App
import Part

with open(os.environ["CAD_DRAWING_JOB"], encoding="utf-8") as handle:
    JOB = json.load(handle)
sys.path.insert(0, JOB["scripts"])
import feature_geometry  # noqa: E402
import feature_recognition  # noqa: E402

V = App.Vector


def box(x0, y0, z0, x1, y1, z1):
    return Part.makeBox(x1 - x0, y1 - y0, z1 - z0, V(x0, y0, z0))


def plate():
    shape = box(0, 0, 0, 60, 40, 10).cut(box(10, 10, 6, 30, 25, 11))
    for x, y in ((45, 10), (45, 30)):
        shape = shape.cut(Part.makeCylinder(2.5, 12, V(x, y, -1)))
    return shape.cut(Part.makeCylinder(2.0, 7, V(45, 20, 4)))


def shell():
    shape = box(0, 0, 0, 50, 30, 20).cut(box(2, 2, 2, 48, 28, 21))
    return shape.cut(box(47, 12, 8, 51, 18, 18))


def slotted():
    cutter = box(15, 7, 2, 29, 13, 6).fuse([Part.makeCylinder(3, 4, V(15, 10, 2)), Part.makeCylinder(3, 4, V(29, 10, 2))])
    return box(0, 0, 0, 50, 20, 5).cut(cutter.removeSplitter())


def chamfered_boss():
    shape = box(0, 0, 0, 30, 30, 5).fuse(Part.makeCylinder(3, 10, V(15, 15, 5))).removeSplitter()
    top = [e for e in shape.Edges if abs(e.BoundBox.ZMin - 15) < 1e-6 and abs(e.BoundBox.ZMax - 15) < 1e-6]
    return shape.makeChamfer(0.5, top)


def prism(points, x0, x1):
    """A prism of the YZ polygon ``points`` from x0 to x1."""
    wire = Part.makePolygon([V(x0, y, z) for y, z in (*points, points[0])])
    return Part.Face(wire).extrude(V(x1 - x0, 0, 0))


def drafted_dish():
    rim_half, height = 15.0, 20.0
    floor_half = rim_half + height * math.tan(math.radians(3.0))
    shape = prism([(-floor_half, 0), (floor_half, 0), (rim_half, height), (-rim_half, height)], 0, 60)
    shape = shape.cut(box(3, -12, 3, 57, 12, 21))
    bed_half, depth_dt = 10.0, 8.0
    top_half = bed_half - depth_dt / math.tan(math.radians(70.0))
    shape = shape.fuse(prism([(-bed_half, -depth_dt), (bed_half, -depth_dt), (top_half, 0), (-top_half, 0)], 10, 50))
    rim, depth = 8.0, 0.8
    radius = (rim ** 2 + depth ** 2) / (2 * depth)
    dish = Part.makeSphere(radius, V(30, 0, 3 - depth + radius)).common(box(3, -12, 2, 57, 12, 3.5))
    return shape.removeSplitter().cut(dish)


def main():
    try:
        result = {"status": "pass", "fixtures": {}}
        for name, build in (("plate", plate), ("shell", shell), ("slotted", slotted),
                            ("chamfered_boss", chamfered_boss), ("drafted_dish", drafted_dish)):
            shape = build().removeSplitter()
            faces = feature_geometry.extract_faces(shape)
            recognition = feature_recognition.recognize([feature_geometry.Face.from_dict(f) for f in faces],
                                                        feature_recognition.SolidProbe(shape))
            result["fixtures"][name] = {"faces": faces, "recognized": recognition.to_dict()}
    except Exception as exc:  # noqa: BLE001 - every failure is reported in the result
        result = {"status": "error", "error": str(exc), "traceback": traceback.format_exc()}
    with open(JOB["result"], "w", encoding="utf-8") as handle:
        json.dump(result, handle)


main()
