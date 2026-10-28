#!/usr/bin/env python3
"""View planning and size statements without FreeCAD: sheets, sections through a reference's centre,
grids of holes stated once, width callouts over inclined ribs, and their callout text.

Run: uv run --with pyyaml --with defusedxml --with jsonschema python -m unittest discover -s cad/skills/cad-drawings/tests -p test_view_planning.py
"""

from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))
import drawing_intent  # noqa: E402
import part_views  # noqa: E402
import sheet  # noqa: E402
from drawing_intent import Characteristic, Datum, DatumFrame, Instance, IntentError  # noqa: E402
from feature_geometry import Binding, Edge, Face, ResolvedFeature  # noqa: E402

X, Y, Z = (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)
FRAME = DatumFrame((0.0, 0.0, 0.0), X, Y, Z, False, {"A": Datum("A", "bed", "plane", (0.0, 0.0, 0.0), Z)})


def rectangle(index: int, x0: float, y0: float, x1: float, y1: float, z: float) -> Face:
    corners = [(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)]
    edges = tuple(Edge(None, (corners[k], corners[(k + 1) % 4])) for k in range(4))
    return Face(index, "plane", (x1 - x0) * (y1 - y0), (x0, y0, z, x1, y1, z), edges, (),
                point=((x0 + x1) / 2, (y0 + y1) / 2, z), normal=Z)


FACES = {0: rectangle(0, 0, 0, 60, 40, 0), 1: rectangle(1, 10, 5, 20, 15, 3)}
FEATURES = {"bed": ResolvedFeature("bed", "plane_face", (0,)), "pocket_floor": ResolvedFeature("pocket_floor", "plane_face", (1,))}
PLAN = {"id": "plan", "kind": "orthographic", "normal_to": "A"}


def hex_grid(pitch: float, reach: float, centre=(28.0, 0.0)) -> list[Instance]:
    """Holes on a 60° grid inside a circle, the model's way: rows pitch·√3/2 apart, odd rows offset half a pitch."""
    points = []
    for j in range(-10, 11):
        for i in range(-10, 11):
            u, v = (i + 0.5 * (j % 2)) * pitch, j * pitch * math.sqrt(3) / 2
            if math.hypot(u, v) <= reach:
                points.append((centre[0] + u, centre[1] + v))
    return [Instance((u, v, 0.0), Z, 1.0, (k,), 0.0, 4.0, None) for k, (u, v) in enumerate(points)]


class Sheets(unittest.TestCase):
    def test_views_go_to_their_sheets_and_a_detail_follows_its_base(self) -> None:
        plans = part_views.plan_views({"views": [PLAN, {"id": "under", "kind": "orthographic", "opposite": "plan", "sheet": 2},
                                                 {"id": "pocket", "kind": "detail", "feature": "pocket_floor"}]},
                                      FRAME, FEATURES, FACES)
        self.assertEqual([(p.id, p.sheet) for p in plans], [("plan", 1), ("under", 2), ("pocket", 1)])
        self.assertIsNotNone(plans[1].label, "an orthographic view away from sheet 1 is named")

    def test_the_principal_view_is_on_sheet_one_and_sheets_have_no_gaps(self) -> None:
        with self.assertRaisesRegex(IntentError, "principal view plan is on sheet 2"):
            part_views.plan_views({"views": [{**PLAN, "sheet": 2}]}, FRAME, FEATURES, FACES)
        with self.assertRaisesRegex(IntentError, r"fill sheets \[1, 3\]"):
            part_views.plan_views({"views": [PLAN, {"id": "under", "kind": "orthographic", "opposite": "plan", "sheet": 3}]},
                                  FRAME, FEATURES, FACES)


class SectionThroughACentre(unittest.TestCase):
    def test_normal_axis_cuts_through_the_reference_centre(self) -> None:
        plans = part_views.plan_views({"views": [PLAN, {"id": "cut", "kind": "section", "through": "pocket_floor",
                                                        "normal_axis": "x", "sheet": 2}]}, FRAME, FEATURES, FACES)
        cut = plans[1]
        self.assertEqual((cut.kind, cut.sheet, cut.section["origin"]), ("section", 2, (15.0, 10.0, 3.0)))
        self.assertAlmostEqual(abs(cut.section["normal"][0]), 1.0)

    def test_normal_axis_takes_one_reference(self) -> None:
        with self.assertRaisesRegex(IntentError, "cuts through one reference"):
            part_views.plan_views({"views": [PLAN, {"id": "cut", "kind": "section", "through": ["pocket_floor", "bed"],
                                                    "normal_axis": "x"}]}, FRAME, FEATURES, FACES)


class GridPattern(unittest.TestCase):
    def test_a_hex_grille_in_a_circle_is_one_pattern_about_its_centre_hole(self) -> None:
        holes = hex_grid(3.0, 16.0)
        grid = drawing_intent._grid_pattern(holes, FRAME, ("x", "y"))
        self.assertIsNotNone(grid)
        self.assertAlmostEqual(grid["pitch"], 3.0)
        self.assertAlmostEqual(grid["second_pitch"], 3.0)
        self.assertAlmostEqual(grid["angle_deg"], 60.0)
        self.assertAlmostEqual(grid["first_angle_deg"], 0.0)
        self.assertEqual(holes[grid["reference"]].axis_point[:2], (28.0, 0.0))
        reach = max(math.hypot(h.axis_point[0] - 28.0, h.axis_point[1]) for h in holes)
        self.assertAlmostEqual(grid["within_diameter"], 2 * reach)

    def test_a_missing_node_or_an_off_grid_hole_keeps_every_location(self) -> None:
        holes = hex_grid(3.0, 16.0)
        inner = next(k for k, h in enumerate(holes) if h.axis_point[:2] == (31.0, 0.0))
        self.assertIsNone(drawing_intent._grid_pattern(holes[:inner] + holes[inner + 1:], FRAME, ("x", "y")))
        stray = Instance((28.0 + 1.0, 0.7, 0.0), Z, 1.0, (999,), 0.0, 4.0, None)
        self.assertIsNone(drawing_intent._grid_pattern([*holes, stray], FRAME, ("x", "y")))
        self.assertIsNone(drawing_intent._grid_pattern(holes[:3], FRAME, ("x", "y")), "three holes are located one by one")

    def test_the_grid_callout_states_count_pitch_directions_and_boundary(self) -> None:
        grid = drawing_intent._grid_pattern(hex_grid(3.0, 16.0), FRAME, ("x", "y"))
        char = Characteristic("grille.pattern", "grille", "pattern", grid["pitch"], (), quantity=109, details=grid)
        text = sheet._callout_text(char, "iso")
        self.assertIn("grid pitch 3 at 0° and 60° to x", text)
        self.assertIn(f"centres within ⌀{sheet.number(grid['within_diameter'])} of the located hole", text)
        self.assertIn("GRID PITCH 3 AT 0° AND 60° TO X", sheet._callout_text(char, "asme"))


def plane(index: int, point, normal) -> Face:
    return Face(index, "plane", 1.0, (*point, *point), (), (), point=tuple(point), normal=tuple(normal))


class WidthRequest(unittest.TestCase):
    def test_a_width_counts_every_opposed_pair_of_its_two_features_at_that_width(self) -> None:
        """Two crush ribs 0.6 wide at 210° and 330°, on two posts: one 4× callout, no frame axis needed."""
        faces, a, b = {}, [], []
        for post in ((0.0, 0.0), (0.0, 12.7)):
            for degrees in (210.0, 330.0):
                u = (math.cos(math.radians(degrees)), math.sin(math.radians(degrees)), 0.0)
                n = (-u[1], u[0], 0.0)
                centre = (post[0] + u[0], post[1] + u[1], 4.0)
                for side, group in ((0.3, a), (-0.3, b)):
                    index = len(faces)
                    faces[index] = plane(index, tuple(centre[k] + side * n[k] for k in range(3)),
                                         tuple(n[k] if side > 0 else -n[k] for k in range(3)))
                    group.append(index)
        features = {"flanks_a": ResolvedFeature("flanks_a", "surface", tuple(a)),
                    "flanks_b": ResolvedFeature("flanks_b", "surface", tuple(b))}
        part = {"drawing": {"type": "detail", "dimensions": [
            {"id": "rib_width", "operation": "width", "features": ["flanks_a", "flanks_b"]}]}}
        measurer = drawing_intent.Measurer("TST-0001", part, {}, [], Binding(features, {}, ()), list(faces.values()))
        measurer._requests(FRAME)
        (char,) = measurer.result.characteristics
        self.assertEqual((char.operation, char.quantity, char.axis), ("width", 4, None))
        self.assertAlmostEqual(char.value, 0.6)
        self.assertEqual(sheet._callout_text(char, "iso"), "4× width 0.6")


if __name__ == "__main__":
    unittest.main()
