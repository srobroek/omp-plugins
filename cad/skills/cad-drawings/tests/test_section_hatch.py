#!/usr/bin/env python3
"""Section fills: one lining per part in a view, spaced in proportion to the part, solid when thin; the gate.

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
from section_hatch import CutRegion, FaceFill, Lining, SectionFill  # noqa: E402

FREECADCMD = freecad_runtime.find_freecadcmd()
FREECAD_PRESENT = FREECADCMD is not None and FREECADCMD.is_file()
OLD_LINING = Lining(3.0, 45.0, 1.5)   # the pre-fix fill: one 3 mm sheet-wide grid at 45° on every face
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
    return CutRegion(section_hatch.region_area([[flat(p) for p in loop] for loop in loops]), loops, part)


def section(*regions: CutRegion) -> SectionFill:
    return section_hatch.fill_section("cut", regions, flat, 1.0)


def relined(fill: SectionFill, lining: Lining = OLD_LINING) -> SectionFill:
    """The same faces all lined with one given lining, whatever the part."""
    fills = tuple(FaceFill(f.face, f.loops, lining, tuple(section_hatch.hatch_lines(f.loops, lining))) for f in fill.fills)
    return SectionFill(fill.view, fill.scale, fill.regions, fills)


def messages(fill: SectionFill) -> list[str]:
    return [f["message"] for f in section_hatch.findings(fill)]


class SectionFills(unittest.TestCase):
    """fill_section and findings on cut faces built by hand, at 1 : 1."""

    def test_typical_width_and_spacing(self) -> None:
        for faces, width, spacing in (([(rectangle(0, 0, 25, 4),)], 100 / 29, 100 / 87),       # 4 mm plate face
                                      ([(rectangle(0, 0, 25, 4),), (rectangle(35, 0, 25, 4),)], 100 / 29, 100 / 87),
                                      ([(circle(10.0), circle(8.0))], 2.0, 0.7),                # tube wall
                                      ([(rectangle(0, 0, 25, 20),)], 1000 / 90, 3.0),          # 20 mm block face
                                      ([(rectangle(0, 0, 30, 20),), (rectangle(0, 30, 40, 1.5),)], 1320 / 183, 1320 / 549)):
            sheet_faces = [[[flat(p) for p in loop] for loop in face] for face in faces]
            with self.subTest(width=width):
                self.assertAlmostEqual(section_hatch.typical_width(sheet_faces), width, places=3)
                self.assertAlmostEqual(section_hatch.spacing_for(width), spacing, places=6)

    def test_a_part_with_a_thick_and_a_thin_face_is_lined_alike(self) -> None:
        # LMP-0004-like: a 30 x 20 body and a 1.5 mm shell of the same part, w = 2·660/183 = 7.21 mm
        fill = section(region(rectangle(0, 0, 30, 20)), region(rectangle(0, 30, 40, 1.5)))
        body, shell = fill.fills
        self.assertEqual((body.mode, shell.mode), ("hatch", "hatch"))
        self.assertEqual(body.lining, shell.lining)
        self.assertAlmostEqual(body.lining.spacing, 1320 / 549, places=6)
        self.assertTrue(shell.lines, "the thin face carries the part's lining")
        self.assertEqual(section_hatch.findings(fill), [])

    def test_a_part_lined_two_ways_fails(self) -> None:
        fill = section(region(rectangle(0, 0, 30, 20)), region(rectangle(0, 30, 40, 1.5)))
        body, shell = fill.fills
        solid_shell = FaceFill(shell.face, shell.loops, None)
        problems = messages(SectionFill("cut", 1.0, fill.regions, (body, solid_shell)))
        self.assertEqual(problems, ["section cut is filled 2 ways across its cut faces; one part takes one lining "
                                    "or one solid fill in a view"])

    def test_a_thin_part_is_solid_in_every_face(self) -> None:
        fill = section(region(rectangle(0, 0, 40, 1.5)), region(rectangle(0, 10, 40, 1.5)))
        self.assertEqual([f.mode for f in fill.fills], ["solid", "solid"])
        self.assertEqual(section_hatch.findings(fill), [])
        self.assertIn('fill="#000" fill-rule="evenodd"', section_hatch.markup(fill.fills[0]))

    def test_wide_face_with_a_hole_is_lined_around_the_hole_and_passes(self) -> None:
        fill = section(region(circle(30.0), tuple(reversed(circle(10.0)))))
        (face,) = fill.fills
        self.assertEqual((face.mode, face.lining.spacing, face.lining.angle_deg), ("hatch", 3.0, 45.0))
        self.assertEqual(section_hatch.findings(fill), [])
        hole = [flat(p) for p in circle(10.0)]
        self.assertFalse(any(section_hatch._inside(((x1 + x2) / 2, (y1 + y2) / 2), hole) for x1, y1, x2, y2 in face.lines))

    def test_lining_over_a_faces_own_hole_fails(self) -> None:
        ring = region(circle(30.0), tuple(reversed(circle(10.0))))
        (face,) = section(ring).fills
        over = FaceFill(0, face.loops, face.lining, tuple(section_hatch.hatch_lines(face.loops[:1], face.lining)))
        problems = section_hatch.findings(SectionFill("cut", 1.0, (ring,), (over,)))
        self.assertEqual([(f["code"], f["face"]) for f in problems], [("section_hatch", 0)], problems)

    def test_overlapping_faces_are_each_filled_in_full(self) -> None:
        # an interference fit in an assembly: one even-odd fill over both faces' loops leaves the overlap empty
        a, b = region(rectangle(0, 0, 30, 30), part="a"), region(rectangle(20, 5, 30, 30), part="b")
        filled = section(a, b)
        self.assertEqual(section_hatch.findings(filled), [])
        both = tuple(f.loops[0] for f in filled.fills)
        shared = tuple(section_hatch.hatch_lines(both, OLD_LINING))
        together = SectionFill("cut", 1.0, (a, b), tuple(FaceFill(f.face, f.loops, OLD_LINING, shared) for f in filled.fills))
        self.assertEqual(sorted(f["face"] for f in section_hatch.findings(together)), [0, 1])

    def test_a_face_without_a_fill_fails(self) -> None:
        filled = section(region(rectangle(0, 0, 30, 30)), region(rectangle(40, 0, 30, 30)))
        partial = SectionFill("cut", 1.0, filled.regions, filled.fills[:1])
        self.assertEqual([f["face"] for f in section_hatch.findings(partial)], [1])
        self.assertIn("missing fill", messages(partial)[0])

    def test_part_level_density_and_solid_rules(self) -> None:
        strip = section(region(rectangle(0, 0, 40, 2)))      # typical width 1.90 mm: solid
        self.assertEqual([f.mode for f in strip.fills], ["solid"])
        self.assertEqual(section_hatch.findings(strip), [])
        for lining, message in ((Lining(0.7, 45.0), "gives 2.7 lines across its 1.90 mm typical width, under 3"),
                                (Lining(0.5, 45.0), "under the 0.7 mm minimum")):
            with self.subTest(spacing=lining.spacing):
                problems = messages(relined(strip, lining))
                self.assertEqual(len(problems), 1, problems)
                self.assertIn(message, problems[0])
        block = section(region(rectangle(0, 0, 25, 20)))
        black = SectionFill("cut", 1.0, block.regions, tuple(FaceFill(f.face, f.loops, None) for f in block.fills))
        self.assertEqual(len(messages(black)), 1)
        self.assertIn("filled solid at a typical width of 11.11 mm", messages(black)[0])

    def test_a_section_through_no_material_fails(self) -> None:
        self.assertEqual([f["code"] for f in section_hatch.findings(section())], ["section_hatch"])

    def test_lining_runs_at_45_degrees_to_the_main_outline(self) -> None:
        for loops, angle in (((rectangle(0, 0, 40, 10),), 45.0),
                             ((rectangle(0, 0, 40, 10, turn_deg=30.0),), 75.0),
                             ((rectangle(0, 0, 40, 10, turn_deg=-0.5),), 44.5),    # the same diagonal as at 0°
                             ((circle(30.0), tuple(reversed(circle(10.0)))), 45.0)):    # no main outline: sheet axes
            with self.subTest(angle=angle):
                (face,) = section(region(*loops)).fills
                self.assertAlmostEqual(face.lining.angle_deg, angle, places=6)
                self.assertEqual(section_hatch.findings(section(region(*loops))), [])

    def test_touching_faces_of_different_parts_are_lined_differently(self) -> None:
        # a pin in a bore: the pin's face touches the housing's on both sides, a third part touches both
        housing = region(rectangle(0, 0, 20, 30), part="housing")
        pin = region(rectangle(20, 0, 20, 30), part="pin")
        housing_right = region(rectangle(40, 0, 20, 30), part="housing")
        cover = region(rectangle(0, 30, 60, 20), part="cover")
        fill = section(housing, pin, housing_right, cover)
        self.assertEqual(section_hatch.findings(fill), [])
        lining = [f.lining for f in fill.fills]
        self.assertEqual(lining[0], lining[2], "one part is lined the same in every face")
        self.assertEqual({lining[0].angle_deg, lining[1].angle_deg}, {45.0, 135.0})
        self.assertEqual((lining[3].angle_deg, lining[3].spacing), (lining[0].angle_deg, lining[0].spacing))
        self.assertEqual((lining[0].offset, lining[3].offset), (0.0, lining[3].spacing / 2),
                         "a third touching part's lines fall between the first part's")
        apart = section(region(rectangle(0, 0, 20, 30), part="a"), region(rectangle(30, 0, 20, 30), part="b"))
        self.assertEqual([f.lining.angle_deg for f in apart.fills], [45.0, 45.0], "parts that do not touch keep 45°")


@unittest.skipUnless(FREECAD_PRESENT, "FreeCAD's freecadcmd is required (set FREECADCMD or install FreeCAD 1.1)")
class SectionFixtures(unittest.TestCase):
    """techdraw_job cuts real solids; each face keeps its own loops and gets its part's fill."""

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

    def test_fills_follow_the_parts_typical_width(self) -> None:
        # tube 2 mm wall at 1 : 2: w 1 mm on paper, solid; plate faces 25 x 4: w 3.45, s 1.15; block 25 x 20: s 3
        for name, width, spacing in (("tube", 1.0, None), ("plate", 100 / 29, 100 / 87), ("block", 1000 / 90, 3.0)):
            with self.subTest(fixture=name):
                layout = self.layout(name)
                fills = layout.section.fills
                self.assertAlmostEqual(section_hatch.typical_width([f.loops for f in fills]), width, delta=0.01)
                self.assertEqual(len({f.lining for f in fills}), 1, "every face of the part is filled alike")
                if spacing is None:
                    self.assertIsNone(fills[0].lining)
                else:
                    self.assertAlmostEqual(fills[0].lining.spacing, spacing, delta=0.01)
                self.assertEqual(section_hatch.findings(layout.section), [])
                marks = [a for a in layout.annotations if a.kind == "hatch"]
                self.assertEqual(len(marks), len(fills))
                self.assertTrue(all(('fill="#000"' in a.markup) == (spacing is None) for a in marks))

    def test_the_pre_fix_fill_fails_the_thin_fixtures(self) -> None:
        # 3 mm lining on every face: a tick or two across the tube wall and the plate
        for name, lines in (("tube", "0.3 lines"), ("plate", "1.1 lines")):
            with self.subTest(fixture=name):
                problems = messages(relined(self.layout(name).section))
                self.assertTrue(any(lines in p for p in problems), problems)
        self.assertEqual(section_hatch.findings(relined(self.layout("block").section)), [])


if __name__ == "__main__":
    unittest.main()
