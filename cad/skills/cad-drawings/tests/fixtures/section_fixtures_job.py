"""FreeCAD-side fixture job for test_section_hatch.py; freecadcmd runs this file headless.

Writes three solids as STEP files into the job's ``directory``: ``tube`` (outside Ø20, bore Ø16, 30
long on the +Z axis from the origin: a 2 mm wall), ``plate`` (60 x 40 x 4 with a Ø10 through hole on
the axis x 30, y 20) and ``block`` (the same plate 20 thick).
"""

import json
import os
import traceback

import FreeCAD as App
import Part

with open(os.environ["CAD_DRAWING_JOB"], encoding="utf-8") as handle:
    JOB = json.load(handle)


def plate(thickness):
    return Part.makeBox(60, 40, thickness).cut(Part.makeCylinder(5, thickness, App.Vector(30, 20, 0)))


def main():
    try:
        steps = {}
        solids = {"tube": Part.makeCylinder(10, 30).cut(Part.makeCylinder(8, 30)), "plate": plate(4), "block": plate(20)}
        for name, shape in solids.items():
            steps[name] = os.path.join(JOB["directory"], f"{name}.step")
            shape.exportStep(steps[name])
        result = {"status": "pass", "steps": steps}
    except Exception as exc:  # noqa: BLE001 - every failure is reported in the result
        result = {"status": "error", "error": str(exc), "traceback": traceback.format_exc()}
    with open(JOB["result"], "w", encoding="utf-8") as handle:
        json.dump(result, handle)


main()
