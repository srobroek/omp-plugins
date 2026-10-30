#!/usr/bin/env python3
"""View planning and size statements without FreeCAD: sheets, sections through a reference's centre,
grids of holes stated once, width callouts over inclined ribs, their callout text, and sheet planning.

Run: uv run --with pyyaml --with defusedxml --with jsonschema python -m unittest discover -s cad/skills/cad-drawings/tests -p test_view_planning.py
"""

from __future__ import annotations

import itertools
import math
import sys
import unittest
from dataclasses import replace
from decimal import Decimal
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))
import drawing  # noqa: E402
import drawing_intent  # noqa: E402
import part_views  # noqa: E402
import sheet  # noqa: E402
from drawing_intent import Characteristic, Datum, DatumFrame, Instance, IntentError, Tolerance  # noqa: E402
from feature_geometry import Binding, Edge, Face, ResolvedFeature  # noqa: E402
from freecad_views import ViewGeometry  # noqa: E402
from layout_check import Box  # noqa: E402

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


def view(view_id: str, direction, x_direction, relation: str) -> part_views.ViewPlan:
    return part_views.ViewPlan(view_id, "part", "orthographic", direction, x_direction, relation)


# first angle: the view from below the principal sits above it, the view from the left on its right
PLANNED = [view("plan", Z, X, "front"), view("front", (0.0, -1.0, 0.0), X, "below"),
           view("side", (-1.0, 0.0, 0.0), (0.0, -1.0, 0.0), "left_side"),
           view("under", (0.0, 0.0, -1.0), (-1.0, 0.0, 0.0), "rear")]
FOOTPRINTS = {"plan": Box(-100, -40, 100, 40), "front": Box(-100, -30, 100, 30), "side": Box(-40, -40, 40, 40),
              "under": Box(-100, -40, 100, 40)}


class SheetPlanning(unittest.TestCase):
    """Projected views keep their places and the others are packed beside them; a rear view with no room is
    lettered with a reference arrow, and views then go to further sheets before a larger sheet is tried."""

    def boxes(self, centres: dict, region: Box) -> dict:
        boxes = {v: drawing._shifted(FOOTPRINTS[v], c) for v, c in centres.items()}
        for box in boxes.values():
            self.assertTrue(region.x0 <= box.x0 and box.x1 <= region.x1 and region.y0 <= box.y0 and box.y1 <= region.y1)
        for a, b in itertools.combinations(boxes.values(), 2):
            self.assertFalse(a.intersects(b))
        return boxes

    def test_a_rear_view_with_no_room_is_lettered_and_packed_under_the_projected_views(self) -> None:
        region = Box(0, 0, 400, 300)
        self.assertIsNone(drawing.arrange(PLANNED, FOOTPRINTS, "first_angle", region), "four views in one row")
        plans = drawing._relieve(PLANNED, 1, "first_angle", ["A", "B"])
        under = plans[3]
        self.assertEqual((under.relation, under.label, under.base), (None, "C", "front"), "arrow on a view that sees -z")
        self.assertEqual([p.relation for p in plans[:3]], ["front", "below", "left_side"])
        centres = drawing.arrange(plans, FOOTPRINTS, "first_angle", region)
        boxes = self.boxes(centres, region)
        self.assertGreater(boxes["under"].y0, boxes["plan"].y1)
        self.assertEqual(centres["plan"][0], centres["front"][0], "projected views keep their column")
        self.assertEqual(centres["plan"][1], centres["side"][1], "and their row")

    def test_views_that_find_no_room_go_to_the_next_sheet(self) -> None:
        region = Box(0, 0, 400, 200)
        plans = drawing._relieve(drawing._relieve(PLANNED, 1, "first_angle", ["A"]), 1, "first_angle", ["A"])
        self.assertEqual([(p.id, p.sheet) for p in plans], [("plan", 1), ("front", 1), ("side", 1), ("under", 2)])
        self.boxes(drawing.arrange(plans[:3], FOOTPRINTS, "first_angle", region), region)
        self.boxes(drawing.arrange(plans[3:], FOOTPRINTS, "first_angle", region, principal=False), region)
        self.assertIsNone(drawing._relieve(plans, 2, "first_angle", ["A"]), "one view alone on a sheet stays")

    def test_a_sheet_without_the_principal_packs_its_views(self) -> None:
        """Sections on sheet 2 have no projected place there: largest first, top left, then centred."""
        cuts = [replace(view(name, Z, X, relation), kind="section", label=name.upper()) for name, relation in
                (("d", "below"), ("e", "left_side"), ("f", "below"))]
        footprints = {"d": Box(-150, -100, 150, 100), "e": Box(-60, -40, 60, 40), "f": Box(-60, -40, 60, 40)}
        region = Box(0, 0, 500, 260)
        centres = drawing.arrange(cuts, footprints, "first_angle", region, principal=False)
        boxes = {v: drawing._shifted(footprints[v], c) for v, c in centres.items()}
        self.assertEqual(boxes["e"].y0, boxes["d"].y0, "beside the largest, not in a grid row of its own")
        self.assertAlmostEqual(min(b.y0 for b in boxes.values()) - region.y0, region.y1 - max(b.y1 for b in boxes.values()))


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


def cylinder(index: int, centre, radius: float = 1.0) -> Face:
    return Face(index, "cylinder", 1.0, (*centre, *centre), (), (), axis_point=tuple(centre), axis_dir=Z,
                radius=radius, inward=True, axial=(0.0, 5.0), span_deg=360.0)


class HoleCentreFromAPlane(unittest.TestCase):
    """A distance request from a plane_face to a bore's centres: grouped by distance, toleranced, replacing
    the frame locations it states, and drawn from that plane."""

    def setUp(self) -> None:
        # holes at x = 7 (two of them) and x = 87 from the plane x = 0
        self.faces = [Face(0, "plane", 100.0, (0, -10, 0, 0, 10, 0), (), (), point=(0, 0, 0), normal=X),
                      *(cylinder(i, centre) for i, centre in enumerate(((7, 0, 0), (7, 10, 0), (87, 0, 0)), 1))]
        self.features = {"side": ResolvedFeature("side", "plane_face", (0,)),
                         "holes": ResolvedFeature("holes", "bore", (1, 2, 3))}
        self.binding = Binding(self.features, {0: "side", 1: "holes", 2: "holes", 3: "holes"}, ())

    def measurer(self, *requests: dict, **drawing) -> drawing_intent.Measurer:
        part = {"process": "fdm", "drawing": {"type": "detail", "dimensions": list(requests), **drawing}}
        product = {"drawing": {"general_tolerance_policy": "fdm", "tolerance_policies": {
            "fdm": {"kind": "limits", "linear_mm": 0.5, "applies_to": ["fdm"]},
            "foot_location": {"kind": "limits", "linear_mm": 0.2, "applies_to": ["fdm"]}}}}
        return drawing_intent.Measurer("TST-0001", part, product, [], self.binding, self.faces)

    @staticmethod
    def request(name: str, instance: int | None = None, **extra) -> dict:
        found = {"id": name, "operation": "distance", "features": ["side", "holes"], **extra}
        return found if instance is None else {**found, "instance": instance}

    def test_centres_are_grouped_by_distance_and_the_instance_picks_the_group(self) -> None:
        measurer = self.measurer(self.request("near", 1, tolerance={"deviation_mm": [-0.2, 0.2]}),
                                 self.request("far", 2, tolerance={"deviation_mm": [-0.3, 0.3]}))
        measurer._requests(FRAME)
        self.assertEqual(measurer.result.findings, [])
        near, far = measurer.result.characteristics
        self.assertEqual([(c.feature, c.value, c.quantity, c.axis) for c in (near, far)],
                         [("holes", 7.0, 2, "x"), ("holes", 87.0, 1, "x")])
        self.assertEqual((near.tolerance.kind, near.tolerance.lower, near.tolerance.upper),
                         ("explicit", Decimal("-0.2"), Decimal("0.2")))
        self.assertEqual(sheet.tolerance_text(far.tolerance, far.value, "iso"), ("87", " ±0.3"))
        self.assertEqual((near.details["datum_feature"], len(near.details["centres"])), ("side", 2))

    def test_it_replaces_only_the_frame_locations_of_its_centres_along_its_axis(self) -> None:
        measurer = self.measurer(self.request("near", 1, tolerance={"deviation_mm": [-0.2, 0.2]}))
        measurer._axis_location(self.features["holes"], FRAME, drawing_intent.cylinder_instances(self.faces[1:]))
        self.assertEqual(sorted(c.id for c in measurer.result.characteristics),
                         ["holes.axis_location.0.x", "holes.axis_location.1.x", "holes.axis_location.1.y",
                          "holes.axis_location.2.x"])
        measurer._requests(FRAME)
        self.assertEqual(sorted(c.id for c in measurer.result.characteristics),
                         ["holes.axis_location.1.y", "holes.axis_location.2.x", "near"])

    def test_a_grid_located_from_a_plane_states_each_centre_once_without_its_pattern(self) -> None:
        grid = hex_grid(3.0, 7.0)
        self.faces = [self.faces[0], *(cylinder(k, inst.axis_point) for k, inst in enumerate(grid, 1))]
        self.features["holes"] = ResolvedFeature("holes", "bore", tuple(range(1, len(grid) + 1)))
        instances = drawing_intent.cylinder_instances(self.faces[1:])
        self.assertIsNotNone(drawing_intent._grid_pattern(instances, FRAME, ("x", "y")))
        unrequested = self.measurer()
        unrequested._axis_location(self.features["holes"], FRAME, instances)
        self.assertEqual([c.operation for c in unrequested.result.characteristics].count("pattern"), 1)
        measurer = self.measurer(self.request("first_column", 1, tolerance={"deviation_mm": [-0.1, 0.1]}))
        measurer._axis_location(self.features["holes"], FRAME, instances)
        measurer._requests(FRAME)
        chars = measurer.result.characteristics
        self.assertNotIn("pattern", [c.operation for c in chars])
        located = [p for c in chars if c.id == "first_column" for p in c.details["centres"]]
        located += [c.details["axis_point"] for c in chars if c.operation == "axis_location" and c.axis == "x"]
        self.assertEqual(sorted(located), sorted(inst.axis_point for inst in instances))   # every x stated once

    def test_a_feature_policy_is_an_individual_tolerance_and_the_sheet_policy_is_general(self) -> None:
        measurer = self.measurer(self.request("near", 1), self.request("far", 2),
                                 features={"holes": {"size": "general", "tolerance_policy": "foot_location"}})
        measurer._requests(FRAME)
        near, far = measurer.result.characteristics
        self.assertEqual((near.tolerance.kind, near.tolerance.upper, near.tolerance.source),
                         ("policy", Decimal("0.2"), "foot_location"))
        self.assertEqual(sheet.tolerance_text(near.tolerance, near.value, "iso"), ("7", " ±0.2"))
        general = self.measurer().general("side", "location", 7.0)
        self.assertEqual((general.kind, sheet.tolerance_text(general, 7.0, "iso")), ("general", ("7", "")))

    def test_an_unselected_or_misplaced_instance_is_refused(self) -> None:
        measurer = self.measurer(self.request("unselected"), self.request("beyond", 3),
                                 {"id": "stray", "operation": "thickness", "features": ["side"], "instance": 1})
        measurer._requests(FRAME)
        self.assertEqual(measurer.result.characteristics, [])
        self.assertEqual([(f["code"], f["dimension"]) for f in measurer.result.findings],
                         [("invalid_drawing_intent", "unselected"), ("invalid_drawing_intent", "beyond"),
                          ("invalid_drawing_intent", "stray")])

    def test_the_dimension_is_drawn_from_the_plane_with_its_tolerance(self) -> None:
        corners = [(0, -5, 0), (0, 5, 0), (0, 5, 10), (0, -5, 10)]   # the plane x = 0, seen edge-on in the front view
        outline = tuple(Edge(None, (corners[k], corners[(k + 1) % 4])) for k in range(4))
        plane_face = Face(0, "plane", 100.0, (0, -5, 0, 0, 5, 10), outline, (), point=(0, 0, 5), normal=X)
        hole_face = Face(1, "cylinder", 10.0, (6, 9, 0, 8, 11, 10), (), (),
                         axis_point=(7, 10, 5), axis_dir=Z, radius=1.0, inward=True, axial=(0, 10), span_deg=360)
        features = {"datum": ResolvedFeature("datum", "plane_face", (0,)), "hole": ResolvedFeature("hole", "bore", (1,))}
        binding = Binding(features, {0: "datum", 1: "hole"}, ())
        part = {"drawing": {"type": "detail", "coordinate_frame": {"origin": {"at": "A"}, "x": {"normal_to": "A"},
                                                                        "y": {"toward": "hole"}},
                             "datum_features": {"A": {"feature": "datum", "role": "plane"}},
                             "features": {"datum": {"size": "general"}, "hole": {"size": "general"}},
                             "dimensions": [{"id": "hole_location", "operation": "distance", "features": ["datum", "hole"],
                                             "tolerance": {"deviation_mm": [-0.2, 0.2]}}]}}
        frame = drawing_intent.resolve_frame(part["drawing"], binding.features, {0: plane_face, 1: hole_face})
        measurer = drawing_intent.Measurer("TST-0001", part, {}, [], binding, [plane_face, hole_face])
        measurer._requests(frame)
        self.assertEqual(measurer.result.findings, [])
        (char,) = measurer.result.characteristics
        plan = part_views.ViewPlan("front", "part", "orthographic", Y, X)
        geometry = ViewGeometry("front", "fixture", "part", (0.0, 0.0), 1.0, 0.0, Y, X,
                                ("M 0 0 L 0 -10 M 6 0 L 6 -10 M 8 0 L 8 -10",), (), (),
                                (0.0, -10.0, 8.0, 0.0))
        view_data = sheet.ViewData(plan, geometry, ((1.0, 0.0, 0.0, 0.0), (0.0, 0.0, -1.0, 5.0)))
        presentation = sheet.build_presentation([char], frame, binding.features, {0: plane_face, 1: hole_face},
                                                {"front": view_data}, "iso", [], {})
        (dimension,) = presentation.linears
        self.assertEqual((dimension.text, dimension.horizontal), ("7 ±0.2", True))
        self.assertEqual((dimension.origin[0], dimension.target[0]), (0.0, 7.0))


class SocketCallout(unittest.TestCase):
    def test_a_hexagonal_socket_names_its_shape_and_across_flats_size(self) -> None:
        char = Characteristic("nut", "socket", "across_flats", 5.6, (1, 2),
                              tolerance=Tolerance("policy", Decimal("-0.1"), Decimal("0.1")), details={"sides": 6})
        self.assertEqual(sheet._callout_text(char, "iso"), "hexagonal socket across flats 5.6 ±0.1")
        self.assertEqual(sheet._callout_text(char, "asme"), "HEXAGONAL SOCKET 5.6 ±0.1 A/F")
        square = replace(char, details={"sides": 4}, tolerance=None)
        self.assertEqual(sheet._callout_text(square, "iso"), "square socket across flats 5.6")


def strip(index: int, ends: tuple, normal) -> Face:
    """A plane face 40 long along x through the two YZ points ``ends``."""
    (y0, z0), (y1, z1) = ends
    edges = (Edge(None, ((10.0, y0, z0), (50.0, y0, z0))), Edge(None, ((10.0, y1, z1), (50.0, y1, z1))))
    return Face(index, "plane", 1.0, (10.0, min(y0, y1), min(z0, z1), 50.0, max(y0, y1), max(z0, z1)), edges, (),
                point=(30.0, (y0 + y1) / 2, (z0 + z1) / 2), normal=tuple(normal))


class SizesAtAPlane(unittest.TestCase):
    """Widths between planes that are not parallel, and a spherical recess, measured as ISO 129-1 states them."""

    def test_a_dovetail_width_is_measured_between_its_flanks_at_the_bed(self) -> None:
        top = 10.0 - 8.0 / math.tan(math.radians(70.0))
        s, c = math.sin(math.radians(70.0)), math.cos(math.radians(70.0))
        faces = {0: strip(0, ((10.0, -8.0), (top, 0.0)), (0.0, s, c)), 1: strip(1, ((-10.0, -8.0), (-top, 0.0)), (0.0, -s, c)),
                 2: strip(2, ((-10.0, -8.0), (10.0, -8.0)), (0.0, 0.0, -1.0))}
        features = {"flanks": ResolvedFeature("flanks", "surface", (0, 1)), "bed": ResolvedFeature("bed", "plane_face", (2,))}
        part = {"drawing": {"type": "detail", "dimensions": [
            {"id": "dovetail_width", "operation": "width", "features": ["flanks"], "at": "bed"},
            {"id": "dovetail_width_top", "operation": "width", "features": ["flanks"], "at": "flanks"}]}}
        measurer = drawing_intent.Measurer("TST-0003", part, {}, [], Binding(features, {}, ()), list(faces.values()))
        measurer._requests(FRAME)
        (char,) = measurer.result.characteristics
        self.assertEqual((char.operation, char.quantity, char.axis, char.details["at"]), ("width", 1, "y", "bed"))
        self.assertAlmostEqual(char.value, 20.0)
        self.assertEqual(char.details["pairs"], [[0, 1]])
        self.assertEqual(sorted(round(char.details["trace"][k][1], 6) for k in ("first", "second")), [-10.0, 10.0])
        self.assertTrue(sheet.is_linear(char), "drawn as a linear dimension between the sharp corners")
        (refused,) = measurer.result.findings   # the flanks are no reference plane of their own width
        self.assertEqual(refused["dimension"], "dovetail_width_top")

    def test_a_drafted_wall_is_as_thick_as_it_is_at_the_rim(self) -> None:
        inner = strip(0, ((12.0, 3.0), (12.0, 20.0)), (0.0, -1.0, 0.0))
        lean = math.radians(3.0)
        outer = strip(1, ((15.0 + 20.0 * math.tan(lean), 0.0), (15.0, 20.0)), (0.0, math.cos(lean), math.sin(lean)))
        rim = strip(2, ((12.0, 20.0), (15.0, 20.0)), Z)
        features = {name: ResolvedFeature(name, kind, (i,)) for i, (name, kind) in
                    enumerate((("inner", "plane_face"), ("outer", "surface"), ("rim", "plane_face")))}
        part = {"drawing": {"type": "detail", "dimensions": [
            {"id": "wall", "operation": "thickness", "features": ["inner", "outer"], "at": "rim"},
            {"id": "draft", "operation": "angle", "features": ["outer", "inner"]}]}}
        measurer = drawing_intent.Measurer("TST-0004", part, {}, [], Binding(features, {}, ()), [inner, outer, rim])
        measurer._requests(FRAME)
        wall, draft = measurer.result.characteristics
        self.assertAlmostEqual(wall.value, 3.0)
        self.assertAlmostEqual(draft.value, 3.0)

    def test_a_spherical_recess_states_sr_and_its_depth_below_the_plane_it_opens_through(self) -> None:
        radius = (8.0 ** 2 + 0.8 ** 2) / 1.6
        dish = Face(0, "sphere", 1.0, (0.0,) * 6, (), (), axis_point=(30.0, 0.0, 2.2 + radius), radius=radius, inward=True)
        floor = plane(1, (30.0, 20.0, 3.0), Z)
        features = {"dish": ResolvedFeature("dish", "surface", (0,)), "floor": ResolvedFeature("floor", "plane_face", (1,))}
        part = {"drawing": {"type": "detail", "dimensions": [
            {"id": "dish_sr", "operation": "radius", "features": ["dish"]},
            {"id": "dish_depth", "operation": "depth", "features": ["dish", "floor"]}]}}
        measurer = drawing_intent.Measurer("TST-0005", part, {}, [], Binding(features, {}, ()), [dish, floor])
        measurer._requests(FRAME)
        sr, depth = measurer.result.characteristics
        self.assertEqual(sheet._callout_text(sr, "iso"), "SR40.4")
        self.assertAlmostEqual(depth.value, 0.8)
        self.assertEqual(sheet._callout_text(depth, "iso"), "depth 0.8")

    def test_a_dimension_at_a_left_edge_plane_extends_left_past_its_line(self) -> None:
        """A wall thickness at a rim on the view's left edge: extension lines run left, outside the view."""
        dim = sheet.Linear("dim-wall", "cut", (40.0, 10.0), (40.0, 16.0), False, "3", side=-1)
        markup = sheet._dimension_markup(dim, 30.0, 3.5, "asme").markup
        self.assertIn('x1="39.000" y1="10.000" x2="28.500" y2="10.000"', markup)
        self.assertIn('text-anchor="end"', markup, "ASME text reads leftward, away from the view")


if __name__ == "__main__":
    unittest.main()
