# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["cadquery-ocp-novtk==8.0.1.1.0", "pyyaml>=6.0"]
# ///
"""Print every component of an assembly STEP as JSON: PN, occurrence id, name, the 3x4 location rows,
and the bounding box of its definition placed at its component location, read through pose.py's
canonical reader.

Usage: uv run --script probe_step.py ASSEMBLY.step
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

POSE_PATH = Path(__file__).resolve().parents[2] / "scripts" / "pose.py"
_spec = importlib.util.spec_from_file_location("cad_motion_pose", POSE_PATH)
assert _spec and _spec.loader
pose = importlib.util.module_from_spec(_spec)
sys.modules["cad_motion_pose"] = pose
_spec.loader.exec_module(pose)


def bbox(shape) -> list[list[float]]:
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib

    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape, box, False, False)
    low, high = box.CornerMin(), box.CornerMax()
    return [[round(v, 6) + 0.0 for v in (low.X(), low.Y(), low.Z())], [round(v, 6) + 0.0 for v in (high.X(), high.Y(), high.Z())]]


step = pose.read_assembly_step(Path(sys.argv[1]))
print(json.dumps({
    "definitions": sorted(step.definitions),
    "components": [{"pn": c.pn, "occurrence": c.occurrence, "name": c.name, "location": c.location.rows(9),
                    "bbox": bbox(pose.placed(step.definitions[c.pn].shape, c.location))} for c in step.components],
}))
