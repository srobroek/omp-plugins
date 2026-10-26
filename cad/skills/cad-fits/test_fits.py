#!/usr/bin/env python3
"""ISO 286 fit tests against published worked examples.

Sources for the expected values (fetched 2026-10-26):
  [W]  Wikipedia, "Engineering fit", worked examples at 50 mm (citing RoyMech):
       https://en.wikipedia.org/w/index.php?title=Engineering_fit&action=raw
  [MM] MetricMech, ISO 286 fits chart, 25 mm rows:
       https://metricmech.com/reference/iso-286-fits-chart
  [FR] Fractory, "Limits and fits", 25 mm H7/g6 and H7/k6 extrema:
       https://fractory.com/limits-and-fits/
  [RT] Rules of Thumb, limits and fits, 50 mm H7/g6 worked example:
       https://rulesofthumb.info/mechanical/limits-fits
  [EK] EKINSUN, limits and fits, 25 mm and 50 mm H7/p6:
       https://www.ekinsun.com/capabilities/limits-and-fits/
  [I2] ISO 286-2:2010 Table 23 (js), as printed in the SIST preview:
       https://preview.sist.si/sist-preview/54915/7d6147c29fed4e31af36b60561e88752/ISO-286-2-2010.pdf
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
from decimal import Decimal
from pathlib import Path
import sys
import unittest

SCRIPT = Path(__file__).with_name("scripts") / "fits.py"
SPEC = importlib.util.spec_from_file_location("cad_fits", SCRIPT)
assert SPEC and SPEC.loader
fits = importlib.util.module_from_spec(SPEC)
sys.modules["cad_fits"] = fits
SPEC.loader.exec_module(fits)

# (size mm, fit, hole min/max mm, shaft min/max mm, max/min clearance um, type, sources)
PUBLISHED = [
    ("25", "H7/g6", (25.000, 25.021), (24.980, 24.993), (41, 7), "clearance", "MM, FR"),
    ("25", "H7/k6", (25.000, 25.021), (25.002, 25.015), (19, -15), "transition", "MM, FR"),
    ("25", "H7/p6", (25.000, 25.021), (25.022, 25.035), (-1, -35), "interference", "MM, EK"),
    ("50", "H7/g6", (50.000, 50.025), (49.975, 49.991), (50, 9), "clearance", "RT, EK"),
    ("50", "H7/k6", (50.000, 50.025), (50.002, 50.018), (23, -18), "transition", "W"),
    ("50", "H7/p6", (50.000, 50.025), (50.026, 50.042), (-1, -42), "interference", "W, EK"),
    ("50", "H8/f7", (50.000, 50.039), (49.950, 49.975), (89, 25), "clearance", "W"),
]


class PublishedExampleTests(unittest.TestCase):
    def test_fits_match_published_worked_examples(self) -> None:
        for size, fit, hole, shaft, clearance, kind, sources in PUBLISHED:
            with self.subTest(size=size, fit=fit, sources=sources):
                result = fits.evaluate(Decimal(size), fit)
                self.assertEqual((result["hole"]["min_mm"], result["hole"]["max_mm"]), hole)
                self.assertEqual((result["shaft"]["min_mm"], result["shaft"]["max_mm"]), shaft)
                self.assertEqual((result["fit"]["max_clearance_um"], result["fit"]["min_clearance_um"]), clearance)
                self.assertEqual(result["fit"]["type"], kind)

    def test_js_keeps_half_micrometre_for_odd_it(self) -> None:
        # [I2] js7 over 18 to 30 mm: IT7 = 21 um, printed as +/-10.5 um.
        shaft = fits.evaluate(Decimal("25"), "js7")["shaft"]
        self.assertEqual((shaft["upper_deviation_um"], shaft["lower_deviation_um"]), (10.5, -10.5))


class TableRuleTests(unittest.TestCase):
    """Rules of ISO 286-1:2010 that the worked examples do not reach."""

    def deviations(self, size: str, cls: str) -> tuple[float, float]:
        entry = fits.evaluate(Decimal(size), cls)
        side = entry.get("shaft") or entry["hole"]
        return side["upper_deviation_um"], side["lower_deviation_um"]

    def test_upper_range_bound_is_inclusive(self) -> None:
        self.assertEqual(self.deviations("30", "H7"), (21, 0))  # 30 belongs to over 18 up to 30
        self.assertEqual(self.deviations("30.001", "H7"), (25, 0))

    def test_k_fundamental_deviation_depends_on_grade(self) -> None:
        self.assertEqual(self.deviations("25", "k7"), (23, 2))  # IT4-IT7: ei = +2
        self.assertEqual(self.deviations("25", "k8"), (33, 0))  # above IT7: ei = 0

    def test_s_uses_the_subdivided_range(self) -> None:
        self.assertEqual(self.deviations("60", "s6"), (72, 53))  # over 50 to 65
        self.assertEqual(self.deviations("70", "s6"), (78, 59))  # over 65 to 80

    def test_out_of_coverage_inputs_are_rejected(self) -> None:
        for size, cls in [("0", "H7"), ("120.5", "H7"), ("25", "H12"), ("25", "e7"), ("25", "G7"), ("25", "g6/H7")]:
            with self.subTest(size=size, cls=cls), self.assertRaises(fits.FitError):
                fits.evaluate(Decimal(size), cls)

    def test_expect_flag_maps_to_exit_codes(self) -> None:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(fits.main(["25", "H7/p6", "--expect", "interference"]), 0)
            self.assertEqual(fits.main(["25", "H7/k6", "--expect", "clearance"]), 1)
            self.assertEqual(fits.main(["130", "H7/k6"]), 2)
