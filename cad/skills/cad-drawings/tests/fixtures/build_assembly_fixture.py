# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["cadquery-ocp-novtk==8.0.1.1.0", "pyyaml>=6.0"]
# ///
"""Write the STEP files of a small assembly-drawing fixture through cad-motion's writers.

Usage: uv run --script build_assembly_fixture.py SPEC.json

SPEC holds ``definitions`` (PN -> {name, box: [dx, dy, dz]} or {name, cylinder: [radius, height]};
boxes have a corner and cylinders their base centre at the origin, axis +Z), ``occurrences``
([{id, PN, explicit, translation_mm, axis, angle_deg}]), ``parts_dir`` and ``assembly``: one
definition STEP per PN in ``parts_dir`` and the assembly STEP that places every occurrence once,
named ``<PN> <title> [@id]`` for explicit occurrences, as ``cad_model.py run`` writes them.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

POSE_PATH = Path(__file__).resolve().parents[3] / "cad-motion" / "scripts" / "pose.py"
_spec = importlib.util.spec_from_file_location("cad_motion_pose", POSE_PATH)
assert _spec and _spec.loader
pose = importlib.util.module_from_spec(_spec)
sys.modules["cad_motion_pose"] = pose
_spec.loader.exec_module(pose)


def shape(definition: dict) -> object:
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder

    if "box" in definition:
        return BRepPrimAPI_MakeBox(*map(float, definition["box"])).Shape()
    radius, height = map(float, definition["cylinder"])
    return BRepPrimAPI_MakeCylinder(radius, height).Shape()


def main(spec_path: Path) -> int:
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    definitions = {pn: pose.Part(pn, d["name"], shape(d)) for pn, d in spec["definitions"].items()}
    occurrences = [pose.assembly_data.Occurrence(
        o["id"], o["PN"], pose.assembly_data.Placement(tuple(o["translation_mm"]), tuple(o["axis"]), o["angle_deg"]),
        o["explicit"]) for o in spec["occurrences"]]
    parts_dir = Path(spec["parts_dir"])
    parts_dir.mkdir(parents=True, exist_ok=True)
    with pose.stdout_to_stderr():
        for pn, part in definitions.items():
            pose.write_part_step(parts_dir / f"{pn}.step", part)
        pose.write_assembly_step(Path(spec["assembly"]), spec["top"], definitions, occurrences,
                                 {o.id: pose.Rigid.from_placement(o.placement) for o in occurrences})
    return 0


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1])))
