#!/usr/bin/env python3
"""Section fills: each cut face lined on its own or filled solid when thin, and the section_hatch gate.

The pure cases build cut faces by hand; the FreeCAD cases cut real solids through techdraw_job.py: a
tube across its axis (one annular face: an outer loop and its own inner loop), a 4 mm plate and a
20 mm block through the axis of their Ø10 through hole (two faces either side of the hole).
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
SPACING = 3.0
TEXT = 3.5      # A3 lettering: lining 3 mm apart
PRODUCT = {"regime": "iso", "drawing": {"projection": "first_angle", "default_sheet": {"orientation": "landscape"}}}


def square(x0: float, y0: float, size: float) -> tuple[tuple[float, float, float], ...]:
    return ((x0, y0, 0.0), (x0 + size, y0, 0.0), (x0 + size, y0 + size, 0.0), (x0, y0 + size, 0.0))


def circle(radius: float, points: int = 720) -> tuple[tuple[float, float, float], ...]:
    return tuple((radius * math.cos(2 * math.pi * k / points), radius * math.sin(2 * math.pi * k / points), 0.0)
                 for k in range(points))


def flat(point) -> tuple[float, float]:
    return (point[0] + 100.0, point[1] + 100.0)


def polygon_area(loop) -> float:
    return abs(section_hatch.signed_area([flat(p) for p in loop]))


def region(*loops) -> CutRegion:
    """A cut face whose model area is its polygon area: the first loop less the others."""
    return CutRegion(polygon_area(loops[0]) - sum(polygon_area(loop) for loop in loops[1:]), loops)


def section(*regions: CutRegion) -> SectionFill:
    return section_hatch.fill_section("cut", regions, flat, 1.0, SPACING)


def lined(view: str, regions, fills_loops) -> SectionFill:
    """The pre-fix fill: 45° lining at the sheet spacing over the given loops of every face, whatever its wall."""
    fills = tuple(FaceFill(k, "hatch", loops, tuple(section_hatch.hatch_lines(loops, SPACING)))
                  for k, loops in enumerate(fills_loops))
    return SectionFill(view, 1.0, SPACING, tuple(regions), fills)


class SectionFills(unittest.TestCase):
    """fill_section and findings on cut faces built by hand, at 1 : 1 with lining 3 mm apart."""

    def test_wide_face_with_a_hole_is_lined_around_the_hole_and_passes(self) -> None:
        ring = region(circle(30.0), tuple(reversed(circle(10.0))))
        fill = section(ring)
        self.assertEqual([f.mode for f in fill.fills], ["hatch"])
        self.assertEqual(section_hatch.findings(fill), [])
        hole = [flat(p) for p in circle(10.0)]
        midpoints = [((x1 + x2) / 2, (y1 + y2) / 2) for x1, y1, x2, y2 in fill.fills[0].lines]
        self.assertFalse(any(section_hatch._inside(m, hole) for m in midpoints), "no lining crosses the bore")

    def test_lining_over_a_faces_own_hole_fails(self) -> None:
        ring = region(circle(30.0), tuple(reversed(circle(10.0))))
        outer = (tuple(flat(p) for p in circle(30.0)),)
        problems = section_hatch.findings(lined("cut", [ring], [outer]))
        self.assertEqual([(f["code"], f["face"]) for f in problems], [("section_hatch", 0)], problems)

    def test_overlapping_faces_are_each_filled_in_full(self) -> None:
        # an interference fit cut in an assembly: the faces overlap, and one even-odd fill over both
        # sets of loops leaves the overlap empty
        a, b = region(square(0, 0, 30)), region(square(20, 5, 30))
        self.assertEqual(section_hatch.findings(section(a, b)), [])
        both = tuple(tuple(flat(p) for p in face.loops[0]) for face in (a, b))
        shared = tuple(section_hatch.hatch_lines(both, SPACING))
        together = SectionFill("cut", 1.0, SPACING, (a, b), tuple(
            FaceFill(k, "hatch", (both[k],), shared) for k in range(2)))
        self.assertEqual(sorted(f["face"] for f in section_hatch.findings(together)), [0, 1])

    def test_a_face_without_a_fill_fails(self) -> None:
        a, b = region(square(0, 0, 30)), region(square(40, 0, 30))
        filled = section(a, b)
        partial = SectionFill("cut", 1.0, SPACING, filled.regions, filled.fills[:1])
        self.assertEqual([f["face"] for f in section_hatch.findings(partial)], [1])
        self.assertIn("missing fill", section_hatch.findings(partial)[0]["message"])

    def test_thin_face_is_solid_and_lining_across_it_fails(self) -> None:
        strip = region(((0, 0, 0), (40, 0, 0), (40, 2, 0), (0, 2, 0)))
        fill = section(strip)
        self.assertEqual([f.mode for f in fill.fills], ["solid"])
        self.assertEqual(section_hatch.findings(fill), [])
        self.assertIn('fill="#000" fill-rule="evenodd"', section_hatch.markup(fill.fills[0]))
        problems = section_hatch.findings(lined("cut", [strip], [fill.fills[0].loops]))
        self.assertEqual(len(problems), 1)
        self.assertIn("does not read across a 2.00 mm wall, fill it solid", problems[0]["message"])

    def test_a_section_through_no_material_fails(self) -> None:
        self.assertEqual([f["code"] for f in section_hatch.findings(section())], ["section_hatch"])

    def test_minimum_wall(self) -> None:
        def wall(*loops) -> float:
            return section_hatch.min_wall([[flat(p) for p in loop] for loop in loops], SPACING / 2)

        self.assertAlmostEqual(wall(circle(10.0), circle(8.0)), 2.0, places=2)    # tube wall
        turn = [(10 * math.cos(math.radians(30)) * x - 10 * math.sin(math.radians(30)) * y,
                 10 * math.sin(math.radians(30)) * x + 10 * math.cos(math.radians(30)) * y, 0.0)
                for x, y in ((0, 0), (4, 0), (4, 1), (0, 1))]
        self.assertAlmostEqual(wall(turn), 10.0, places=6)                          # 40 x 10, rotated
        triangle = ((0, 0, 0), (20, 0, 0), (10, 10 * math.sqrt(3), 0))
        self.assertAlmostEqual(wall(triangle), 20 / math.sqrt(3), places=6)         # no facing walls: incircle
        web = (((0, 0, 0), (60, 0, 0), (60, 30, 0), (0, 30, 0)),
               tuple((48 + 10 * math.cos(2 * math.pi * k / 360), 15 + 10 * math.sin(2 * math.pi * k / 360), 0.0)
                     for k in range(360)))
        self.assertAlmostEqual(wall(*web), 2.0, places=2)                           # hole 2 mm from an edge


@unittest.skipUnless(FREECAD_PRESENT, "FreeCAD's freecadcmd is required (set FREECADCMD or install FreeCAD 1.1)")
class SectionFixtures(unittest.TestCase):
    """techdraw_job cuts real solids; each face keeps its own loops and gets the fill its wall allows."""

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
        for name, thickness in (("tube", None), ("plate", 4.0), ("block", 20.0)):
            plans = across if thickness is None else (
                ViewPlan("plan", "part", "orthographic", (0.0, 0.0, 1.0), (1.0, 0.0, 0.0)),
                ViewPlan("cut", "section", "section", (0.0, -1.0, 0.0), (1.0, 0.0, 0.0), base="plan",
                         section={"origin": (30.0, 20.0, thickness / 2), "normal": (0.0, -1.0, 0.0)}, label="A"))
            jobs = drawing.view_jobs(plans, {p.id: 1.0 for p in plans}, {plans[0].id: (120.0, 100.0), "cut": (280.0, 100.0)}, {})
            result = drawing.run_job(FREECADCMD, {"mode": "views", "step": built["steps"][name], "page_template": str(template),
                                                  "sheet_height_mm": spec.height_mm, "views": jobs}, root, 300)
            cls.views[name] = drawing.view_data(result, plans)["cut"]

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def layout(self, name: str) -> sheet.ViewLayout:
        return sheet.layout_view(self.views[name], sheet.Presentation(), TEXT, "iso")

    def test_each_cut_face_keeps_its_own_loops_and_area(self) -> None:
        expected = {"tube": [(2, math.pi * (10 ** 2 - 8 ** 2))], "plate": [(1, 100.0), (1, 100.0)],
                    "block": [(1, 500.0), (1, 500.0)]}
        for name, faces in expected.items():
            with self.subTest(fixture=name):
                regions = self.views[name].cut_regions
                self.assertEqual([len(r.loops) for r in regions], [loops for loops, _ in faces])
                for region, (_, area) in zip(regions, faces):
                    self.assertAlmostEqual(region.area_mm2, area, places=3)

    def test_thin_fixtures_are_filled_solid_and_pass(self) -> None:
        for name in ("tube", "plate"):
            with self.subTest(fixture=name):
                layout = self.layout(name)
                self.assertEqual({f.mode for f in layout.section.fills}, {"solid"})
                self.assertEqual(section_hatch.findings(layout.section), [])
                fills = [a for a in layout.annotations if a.kind == "hatch"]
                self.assertEqual(len(fills), len(self.views[name].cut_regions))
                self.assertTrue(all('fill="#000"' in a.markup for a in fills))

    def test_lining_the_thin_fixtures_fails(self) -> None:
        # the pre-fix sheet: 3 mm lining over every cut face, with one or two ticks across a 2 or 4 mm wall
        for name in ("tube", "plate"):
            with self.subTest(fixture=name):
                fill = self.layout(name).section
                problems = section_hatch.findings(lined("cut", fill.regions, [f.loops for f in fill.fills]))
                self.assertEqual([f["face"] for f in problems], list(range(len(fill.regions))), problems)
                self.assertTrue(all("fill it solid" in f["message"] for f in problems))

    def test_block_is_lined_and_passes(self) -> None:
        layout = self.layout("block")
        self.assertEqual([f.mode for f in layout.section.fills], ["hatch", "hatch"])
        self.assertTrue(all(f.lines for f in layout.section.fills))
        self.assertEqual(section_hatch.findings(layout.section), [])
        for fill in layout.section.fills:
            self.assertAlmostEqual(section_hatch.shown_area(fill, SPACING), 500.0, delta=5.0)


if __name__ == "__main__":
    unittest.main()
