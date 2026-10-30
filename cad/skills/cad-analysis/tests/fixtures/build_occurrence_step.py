# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["cadquery-ocp-novtk==8.0.1.1.0", "pyyaml>=6.0"]
# ///
"""Write an assembly STEP AP242 that places one part definition twice, through cad-motion's writer.

Usage: uv run --script skill://cad-flow/scripts/run.py cad-analysis/tests/fixtures/build_occurrence_step.py OUT.step

TST-0301 "Beam" is a 100 x 10 x 5 mm box with one corner at its origin. `@beam-a` is placed at the
identity. `@beam-b` is turned 90 degrees about +Z and then moved (200, 50, 0), so it spans x 190..200,
y 50..150, z 0..5: its end faces lie on y = 50 and y = 150, where `@beam-a` has no face.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

POSE_PATH = Path(__file__).resolve().parents[3] / "cad-motion" / "scripts" / "pose.py"
_spec = importlib.util.spec_from_file_location("cad_motion_pose", POSE_PATH)
assert _spec and _spec.loader
pose = importlib.util.module_from_spec(_spec)
sys.modules["cad_motion_pose"] = pose
_spec.loader.exec_module(pose)

PN = "TST-0301"
PLACEMENTS = {
    "beam-a": pose.assembly_data.IDENTITY,
    "beam-b": pose.assembly_data.Placement((200.0, 50.0, 0.0), (0.0, 0.0, 1.0), 90.0),
}


def main(out: Path) -> int:
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox

    beam = pose.Part(PN, f"{PN} Beam", BRepPrimAPI_MakeBox(100.0, 10.0, 5.0).Shape())
    occurrences = [pose.assembly_data.Occurrence(oid, PN, placement, True) for oid, placement in PLACEMENTS.items()]
    out.parent.mkdir(parents=True, exist_ok=True)
    pose.write_assembly_step(out, "beam-pair", {PN: beam}, occurrences,
                             {o.id: pose.Rigid.from_placement(o.placement) for o in occurrences})
    return 0


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1])))
