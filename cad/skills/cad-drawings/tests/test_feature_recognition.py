#!/usr/bin/env python3
"""Feature recognition on real B-rep fixtures, and the gate findings that name an undimensioned feature.

The fixtures are built and recognised in freecadcmd (tests/fixtures/recognition_fixtures_job.py);
the cases are skipped only when no FreeCAD is installed. The gate cases run feature_coverage on that
recognition with a binding and measured characteristics made here.
Run: uv run --with pyyaml --with defusedxml --with jsonschema python -m unittest discover -s cad/skills/cad-drawings/tests
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import feature_coverage  # noqa: E402
import freecad_runtime  # noqa: E402
from drawing_intent import Characteristic, DatumFrame, Measured  # noqa: E402
from feature_geometry import Binding, Face, ResolvedFeature  # noqa: E402
from feature_recognition import Recognition  # noqa: E402

FREECADCMD = freecad_runtime.find_freecadcmd()
FREECAD_PRESENT = FREECADCMD is not None and FREECADCMD.is_file()
JOB = HERE / "fixtures" / "recognition_fixtures_job.py"
FRAME = DatumFrame((0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0), False, {})


def sizes(recognition: Recognition, category: str) -> list[dict[str, float]]:
    return [{s.name: round(s.value, 3) for s in item.sizes} | {"instances": item.details.get("instances", 1)}
            for item in recognition.features if item.category == category]


def binding(recognition: Recognition, faces: dict[int, Face], kind_of) -> Binding:
    """Every face bound: one feature per recognised feature, named after it, of the kind ``kind_of`` gives."""
    owner, features = {}, {}
    for item in recognition.features:
        free = [i for i in item.faces if i not in owner]
        if free:
            features[item.id] = ResolvedFeature(item.id, kind_of(item), tuple(free))
            owner.update({i: item.id for i in free})
    return Binding(features, owner, ())


@unittest.skipUnless(FREECAD_PRESENT, "recognition fixtures need FreeCAD's freecadcmd")
class Recognition_(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        with tempfile.TemporaryDirectory(prefix="cad-recognition-") as work:
            data, message = freecad_runtime.run_job(FREECADCMD, JOB, {"scripts": str(SCRIPTS)}, Path(work), 600)
        if data is None:
            raise AssertionError(message)
        cls.fixtures = {name: (Recognition.from_dict(f["recognized"]), {r["index"]: Face.from_dict(r) for r in f["faces"]})
                        for name, f in data["fixtures"].items()}

    def test_plate_pocket_and_holes(self) -> None:
        recognition, _ = self.fixtures["plate"]
        self.assertNotIn("wall", {item.category for item in recognition.features if 6.0 in
                                  [round(s.value, 3) for s in item.sizes]})   # a 6 mm floor under a 20 mm pocket is not thin
        pocket = sizes(recognition, "pocket")
        self.assertEqual(len(pocket), 1, recognition.features)
        self.assertEqual((pocket[0]["depth"]), 4.0)
        widths = sorted(s.value for item in recognition.features if item.category == "pocket"
                        for s in item.sizes if s.name == "width")
        self.assertEqual([round(w, 3) for w in widths], [15.0, 20.0])
        holes = sorted(sizes(recognition, "hole"), key=lambda s: s["diameter"])
        self.assertEqual(holes, [{"diameter": 4.0, "depth": 6.0, "instances": 1}, {"diameter": 5.0, "instances": 2}])
        self.assertEqual(recognition.unrecognized, ())

    def test_shelled_box_walls_and_cutout(self) -> None:
        recognition, _ = self.fixtures["shell"]
        cavity = sizes(recognition, "pocket")
        self.assertEqual([(c["depth"]) for c in cavity], [18.0])
        cutout = [s for item in recognition.features if item.category == "cutout" for s in item.sizes]
        self.assertEqual(sorted(round(s.value, 3) for s in cutout if s.name == "width"), [6.0, 10.0])
        walls = [w["thickness"] for w in sizes(recognition, "wall")]
        self.assertGreaterEqual(len(walls), 4, recognition.features)     # four side walls and the floor
        self.assertEqual(set(walls), {2.0})

    def test_slotted_part(self) -> None:
        recognition, _ = self.fixtures["slotted"]
        self.assertEqual(sizes(recognition, "slot"), [{"width": 6.0, "radius": 3.0, "length": 20.0, "depth": 3.0,
                                                       "instances": 1}])

    def test_overall_only_intent_fails_naming_each_feature(self) -> None:
        """Envelope planes located, everything else one controlled-model surface: the sheet passed before."""
        recognition, faces = self.fixtures["shell"]
        bound = binding(recognition, faces, lambda item: "plane_face" if item.category == "outline" else "surface")
        report = feature_coverage.check(recognition, bound, Measured(frame=FRAME), faces)
        named = {f["feature"] for f in report.findings}
        self.assertTrue({"pocket_1", "cutout_1"} <= named, report.findings)
        self.assertTrue(any(f["feature"].startswith("wall") for f in report.findings))
        cutout = next(f for f in report.findings if f["feature"] == "cutout_1")
        self.assertIn("controlled-model surface", cutout["message"])
        self.assertIn("width 10", cutout["message"])
        # one finding per feature, however many faces it has
        self.assertEqual(len(report.findings), len(named))

    def test_wall_thickness_needs_its_own_dimension(self) -> None:
        recognition, faces = self.fixtures["shell"]
        # the +X wall: both faces off the datum planes, so a location of either is no thickness
        wall = next(item for item in recognition.features if item.category == "wall"
                    and item.direction == (1.0, 0.0, 0.0) and min(faces[i].point[0] for i in item.faces) > 1.0)
        size = wall.sizes[0]
        a, b = size.between[0][0], size.between[1][0]
        bound = binding(recognition, faces, lambda item: "plane_face")
        located = Measured(frame=FRAME)
        for index in (a, b):   # both faces located from the datum frame: the thickness is only a difference
            located.characteristics.append(Characteristic(f"loc{index}", bound.owner[index], "location",
                                                          faces[index].point[0], (index,), axis="x"))
        report = feature_coverage.check(recognition, bound, located, faces)
        self.assertTrue(any(f["feature"] == wall.id and "thickness 2" in f["message"] for f in report.findings))
        located.characteristics.append(Characteristic("wall_t", bound.owner[a], "thickness", 2.0, (b,),
                                                      details={"features": [bound.owner[a], bound.owner[b]]}))
        report = feature_coverage.check(recognition, bound, located, faces)
        self.assertFalse(any(f["feature"] == wall.id for f in report.findings), report.findings)


if __name__ == "__main__":
    unittest.main()
