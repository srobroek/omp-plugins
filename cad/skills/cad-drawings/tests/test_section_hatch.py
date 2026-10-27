#!/usr/bin/env python3
"""Section fills: spacing in proportion to each cut face, solid when thin, and the section_hatch gate.

The pure cases build cut faces by hand; the FreeCAD cases cut real solids through techdraw_job.py: a
tube (2 mm wall) across its axis, one annular face with its own inner loop; a 4 mm plate and a 20 mm
block through the axis of their Ø10 through hole, two faces either side of the hole.
Run: uv run --with pyyaml --with defusedxml --with jsonschema python -m unittest discover -s cad/skills/cad-drawings/tests
"""

from __future__ import annotations

import math
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"
FIXTURE_JOB = HERE / "fixtures" / "section_fixtures_job.py"
sys.path.insert(0, str(SCRIPTS))
import drawing  # noqa: E402
import drawing_document  # noqa: E402
import freecad_runtime  # noqa: E402
import section_hatch  # noqa: E402
import sheet  # noqa: E402
from part_views import ViewPlan  # noqa: E402
from section_hatch import CutRegion, FaceFill, SectionFill  # noqa: E402

FREECADCMD = freecad_runtime.find_freecadcmd()
FREECAD_PRESENT = FREECADCMD is not None and FREECADCMD.is_file()
OLD_SPACING = 3.0   # the pre-fix fill: one 3 mm pitch at 45° on every face
PRODUCT = {"regime": "iso", "drawing": {"projection": "first_angle", "default_sheet": {"orientation": "landscape"}}}


def polygon(*points: tuple[float, float]) -> tuple[tuple[float, float, float], ...]:
    return tuple((x, y, 0.0) for x, y in points)


def rectangle(x0: float, y0: float, width: float, height: float, turn_deg: float = 0.0):
    c, s = math.cos(math.radians(turn_deg)), math.sin(math.radians(turn_deg))
    return polygon(*((x0 + c * x - s * y, y0 + s * x + c * y) for x, y in ((0, 0), (width, 0), (width, height), (0, height))))


def circle(radius: float, points: int = 720, centre: tuple[float, float] = (0.0, 0.0)):
    return polygon(*((centre[0] + radius * math.cos(2 * math.pi * k / points),
                      centre[1] + radius * math.sin(2 * math.pi * k / points)) for k in range(points)))


def flat(point) -> tuple[float, float]:
    return (point[0] + 100.0, point[1] + 100.0)


def region(*loops, part: str = "") -> CutRegion:
    """A cut face whose model area is its polygon area: the first loop less the others."""
    sheet_loops = [[flat(p) for p in loop] for loop in loops]
    return CutRegion(section_hatch.region_area(sheet_loops), loops, part)


def section(*regions: CutRegion) -> SectionFill:
    return section_hatch.fill_section("cut", regions, flat, 1.0)


def lined(fill: SectionFill, spacing: float = OLD_SPACING) -> SectionFill:
    """The same faces lined the pre-fix way: 45° lining at one fixed pitch, whatever the face."""
    fills = tuple(FaceFill(f.face, "hatch", f.loops, f.width, spacing, 45.0, 0.0,
                           tuple(section_hatch.hatch_lines(f.loops, spacing, 45.0))) for f in fill.fills)
    return SectionFill(fill.view, fill.scale, fill.regions, fills)


def faces_flagged(fill: SectionFill) -> list[int]:
    return sorted({f["face"] for f in section_hatch.findings(fill)})


class SectionFills(unittest.TestCase):
    """fill_section and findings on cut faces built by hand, at 1 : 1."""

    def test_typical_width_and_spacing(self) -> None:
        for loops, width, spacing in (((rectangle(0, 0, 25, 4),), 100 / 29, 100 / 87),       # 4 mm plate face
                                      ((circle(10.0), circle(8.0)), 2.0, 0.7),                # tube wall
                                      ((rectangle(0, 0, 25, 20),), 1000 / 90, 3.0),          # 20 mm block face
                                      ((rectangle(0, 0, 40, 1),), 80 / 82, 0.7)):
            sheet_loops = [[flat(p) for p in loop] for loop in loops]
            with self.subTest(width=width):
                self.assertAlmostEqual(section_hatch.typical_width(sheet_loops), width, places=3)
                self.assertAlmostEqual(section_hatch.spacing_for(width), spacing, places=6)

    def test_wide_face_with_a_hole_is_lined_around_the_hole_and_passes(self) -> None:
        fill = section(region(circle(30.0), tuple(reversed(circle(10.0)))))
        (face,) = fill.fills
        self.assertEqual((face.mode, face.spacing, face.angle_deg), ("hatch", 3.0, 45.0))
        self.assertEqual(section_hatch.findings(fill), [])
        hole = [flat(p) for p in circle(10.0)]
        self.assertFalse(any(section_hatch._inside(((x1 + x2) / 2, (y1 + y2) / 2), hole) for x1, y1, x2, y2 in face.lines))

    def test_lining_over_a_faces_own_hole_fails(self) -> None:
        ring = region(circle(30.0), tuple(reversed(circle(10.0))))
        (face,) = section(ring).fills
        outer = face.loops[:1]
        over = FaceFill(0, "hatch", face.loops, face.width, 3.0, 45.0, 0.0, tuple(section_hatch.hatch_lines(outer, 3.0, 45.0)))
        problems = section_hatch.findings(SectionFill("cut", 1.0, (ring,), (over,)))
        self.assertEqual([(f["code"], f["face"]) for f in problems], [("section_hatch", 0)], problems)

    def test_overlapping_faces_are_each_filled_in_full(self) -> None:
        # one even-odd fill over both faces' loops leaves their overlap empty
        a, b = region(rectangle(0, 0, 30, 30)), region(rectangle(20, 5, 30, 30))
        filled = section(a, b)
        self.assertEqual(section_hatch.findings(filled), [])
        both = tuple(f.loops[0] for f in filled.fills)
        shared = tuple(section_hatch.hatch_lines(both, 3.0, 45.0))
        together = SectionFill("cut", 1.0, (a, b), tuple(
            FaceFill(f.face, "hatch", f.loops, f.width, 3.0, 45.0, 0.0, shared) for f in filled.fills))
        self.assertEqual(faces_flagged(together), [0, 1])

    def test_a_face_without_a_fill_fails(self) -> None:
        filled = section(region(rectangle(0, 0, 30, 30)), region(rectangle(40, 0, 30, 30)))
        partial = SectionFill("cut", 1.0, filled.regions, filled.fills[:1])
        self.assertEqual(faces_flagged(partial), [1])
        self.assertIn("missing fill", section_hatch.findings(partial)[0]["message"])

    def test_faces_under_three_minimum_spacings_are_solid_and_lining_them_fails(self) -> None:
        strip = section(region(rectangle(0, 0, 40, 2)))      # typical width 1.90 mm
        self.assertEqual([f.mode for f in strip.fills], ["solid"])
        self.assertEqual(section_hatch.findings(strip), [])
        self.assertIn('fill="#000" fill-rule="evenodd"', section_hatch.markup(strip.fills[0]))
        for spacing, message in ((0.7, "gives 2.7 lines across its 1.90 mm typical width, under 3"),
                                 (0.5, "under the 0.7 mm minimum")):
            with self.subTest(spacing=spacing):
                problems = section_hatch.findings(lined(strip, spacing))
                self.assertEqual(len(problems), 1, problems)
                self.assertIn(message, problems[0]["message"])

    def test_a_wide_face_filled_solid_fails(self) -> None:
        block = section(region(rectangle(0, 0, 25, 20)))
        black = SectionFill("cut", 1.0, block.regions, tuple(
            FaceFill(f.face, "solid", f.loops, f.width) for f in block.fills))
        problems = section_hatch.findings(black)
        self.assertEqual(len(problems), 1)
        self.assertIn("filled solid at a typical width of 11.11 mm", problems[0]["message"])

    def test_a_section_through_no_material_fails(self) -> None:
        self.assertEqual([f["code"] for f in section_hatch.findings(section())], ["section_hatch"])

    def test_lining_runs_at_45_degrees_to_the_main_outline(self) -> None:
        for loops, angle in (((rectangle(0, 0, 40, 10),), 45.0),
                             ((rectangle(0, 0, 40, 10, turn_deg=30.0),), 75.0),
                             ((rectangle(0, 0, 40, 10, turn_deg=-0.5),), 44.5),    # the same diagonal as at 0°
                             ((circle(30.0), tuple(reversed(circle(10.0)))), 45.0)):    # no main outline: sheet axes
            with self.subTest(angle=angle):
                (face,) = section(region(*loops)).fills
                self.assertAlmostEqual(face.angle_deg, angle, places=6)
                self.assertEqual(section_hatch.findings(section(region(*loops))), [])

    def test_touching_faces_of_different_parts_are_lined_differently(self) -> None:
        # a pin in a bore: the pin's face touches the housing's on both sides, a third part touches both
        housing = region(rectangle(0, 0, 20, 30), part="housing")
        pin = region(rectangle(20, 0, 20, 30), part="pin")
        housing_right = region(rectangle(40, 0, 20, 30), part="housing")
        cover = region(rectangle(0, 30, 60, 20), part="cover")
        fill = section(housing, pin, housing_right, cover)
        self.assertEqual(section_hatch.findings(fill), [])
        lining = [(f.angle_deg, f.phase) for f in fill.fills]
        self.assertEqual(lining[0], lining[2], "one part is lined the same in every face")
        self.assertEqual({lining[0][0], lining[1][0]}, {45.0, 135.0})
        self.assertEqual(lining[3], (45.0, fill.fills[3].spacing / 2), "a third touching part shifts its lines")
        apart = section(region(rectangle(0, 0, 20, 30), part="a"), region(rectangle(30, 0, 20, 30), part="b"))
        self.assertEqual([f.angle_deg for f in apart.fills], [45.0, 45.0], "parts that do not touch keep 45°")


@unittest.skipUnless(FREECAD_PRESENT, "FreeCAD's freecadcmd is required (set FREECADCMD or install FreeCAD 1.1)")
class SectionFixtures(unittest.TestCase):
    """techdraw_job cuts real solids; each face keeps its own loops and gets the fill its size allows."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        built, message = freecad_runtime.run_job(FREECADCMD, FIXTURE_JOB, {"directory": str(root)}, root, 300)
        if built is None:
            raise RuntimeError(f"section fixtures failed: {message}")
        spec = drawing_document.sheet_specs(PRODUCT, ["A3"])[0]
        template = root / "page.svg"
        template.write_text(spec.page_template_svg(), encoding="utf-8")
        across = (ViewPlan("front", "part", "orthographic", (0.0, -1.0, 0.0), (1.0, 0.0, 0.0)),
                  ViewPlan("cut", "section", "section", (0.0, 0.0, 1.0), (1.0, 0.0, 0.0), base="front",
                           section={"origin": (0.0, 0.0, 15.0), "normal": (0.0, 0.0, 1.0)}, label="A"))
        cls.views = {}
        for name, thickness, scale in (("tube", None, 0.5), ("plate", 4.0, 1.0), ("block", 20.0, 1.0)):
            plans = across if thickness is None else (
                ViewPlan("plan", "part", "orthographic", (0.0, 0.0, 1.0), (1.0, 0.0, 0.0)),
                ViewPlan("cut", "section", "section", (0.0, -1.0, 0.0), (1.0, 0.0, 0.0), base="plan",
                         section={"origin": (30.0, 20.0, thickness / 2), "normal": (0.0, -1.0, 0.0)}, label="A"))
            jobs = drawing.view_jobs(plans, {p.id: scale for p in plans}, {plans[0].id: (120.0, 100.0), "cut": (280.0, 100.0)}, {})
            result = drawing.run_job(FREECADCMD, {"mode": "views", "step": built["steps"][name], "page_template": str(template),
                                                  "sheet_height_mm": spec.height_mm, "views": jobs}, root, 300)
            cls.views[name] = drawing.view_data(result, plans)["cut"]

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def layout(self, name: str) -> sheet.ViewLayout:
        return sheet.layout_view(self.views[name], sheet.Presentation(), 3.5, "iso")

    def test_each_cut_face_keeps_its_own_loops_and_area(self) -> None:
        expected = {"tube": [(2, math.pi * (10 ** 2 - 8 ** 2))], "plate": [(1, 100.0), (1, 100.0)],
                    "block": [(1, 500.0), (1, 500.0)]}
        for name, faces in expected.items():
            with self.subTest(fixture=name):
                regions = self.views[name].cut_regions
                self.assertEqual([len(r.loops) for r in regions], [loops for loops, _ in faces])
                for cut, (_, area) in zip(regions, faces):
                    self.assertAlmostEqual(cut.area_mm2, area, places=3)

    def test_fills_follow_the_typical_width(self) -> None:
        # tube 2 mm wall at 1 : 2: 1 mm on paper, solid; plate faces 25 x 4: w 3.45, s 1.15; block 25 x 20: s 3
        for name, mode, width, spacing in (("tube", "solid", 1.0, 0.0), ("plate", "hatch", 100 / 29, 100 / 87),
                                           ("block", "hatch", 1000 / 90, 3.0)):
            with self.subTest(fixture=name):
                layout = self.layout(name)
                fills = layout.section.fills
                self.assertEqual({f.mode for f in fills}, {mode})
                for fill in fills:
                    self.assertAlmostEqual(fill.width, width, delta=0.01)
                    self.assertAlmostEqual(fill.spacing, spacing, delta=0.01)
                self.assertEqual(section_hatch.findings(layout.section), [])
                marks = [a for a in layout.annotations if a.kind == "hatch"]
                self.assertEqual(len(marks), len(fills))
                self.assertTrue(all(('fill="#000"' in a.markup) == (mode == "solid") for a in marks))

    def test_the_pre_fix_fill_fails_the_thin_fixtures(self) -> None:
        # 3 mm lining on every face: a tick or two across the tube wall and the plate
        for name in ("tube", "plate"):
            with self.subTest(fixture=name):
                fill = self.layout(name).section
                self.assertEqual(faces_flagged(lined(fill)), list(range(len(fill.regions))))
        self.assertEqual(section_hatch.findings(lined(self.layout("block").section)), [])


if __name__ == "__main__":
    unittest.main()
