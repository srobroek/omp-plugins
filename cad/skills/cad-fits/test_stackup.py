#!/usr/bin/env python3
"""Stack-up tests against an independent hand calculation."""

from __future__ import annotations

import importlib.util
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("scripts") / "stackup.py"
SPEC = importlib.util.spec_from_file_location("cad_stackup", SCRIPT)
assert SPEC and SPEC.loader
stackup = importlib.util.module_from_spec(SPEC)
sys.modules["cad_stackup"] = stackup
SPEC.loader.exec_module(stackup)

# Bearing end float: housing width A closes against two bearings B, D and a spacer C.
#   A = 50.00 +0.10/-0.00 (+)   B = D = 20.00 +/-0.05 (-)   C = 9.90 +0.00/-0.06 (-)
# Hand calculation:
#   nominal gap      = 50.00 - 20.00 - 9.90 - 20.00                      = 0.10
#   worst-case max   = 50.10 - 19.95 - 9.84 - 19.95                      = 0.36
#   worst-case min   = 50.00 - 20.05 - 9.90 - 20.05                      = 0.00
#   mid-limit means  = 50.05 - 20.00 - 9.87 - 20.00                      = 0.18
#   RSS half-range   = sqrt(0.05^2 + 0.05^2 + 0.03^2 + 0.05^2) = sqrt(0.0084) = 0.0916515
#   RSS min / max    = 0.18 -/+ 0.0916515                                = 0.0883485 / 0.2716515
STACK = {
    "id": "STK-001",
    "title": "Bearing end float",
    "units": "mm",
    "requirement": {"min": 0.02, "max": 0.40, "method": "worst_case"},
    "contributors": [
        {"id": "A", "nominal": 50.00, "tol_plus": 0.10, "tol_minus": 0.00, "direction": 1},
        {"id": "B", "nominal": 20.00, "tol": 0.05, "direction": -1},
        {"id": "C", "nominal": 9.90, "tol_plus": 0.00, "tol_minus": 0.06, "direction": -1},
        {"id": "D", "nominal": 20.00, "tol": 0.05, "direction": -1},
    ],
}

STACK_YAML = """\
id: STK-001
title: Bearing end float
units: mm
requirement: {min: 0.02, max: 0.40, method: worst_case}
contributors:
  - {id: A, nominal: 50.00, tol_plus: 0.10, tol_minus: 0.00, direction: 1}
  - {id: B, nominal: 20.00, tol: 0.05, direction: -1}
  - {id: C, nominal: 9.90, tol_plus: 0.00, tol_minus: 0.06, direction: -1}
  - {id: D, nominal: 20.00, tol: 0.05, direction: -1}
"""


class StackupHandCalculationTests(unittest.TestCase):
    def test_worst_case_and_rss_match_hand_calculation(self) -> None:
        result = stackup.compute(STACK)
        self.assertAlmostEqual(result["nominal"], 0.10, places=6)
        self.assertAlmostEqual(result["mean"], 0.18, places=6)
        self.assertAlmostEqual(result["worst_case"]["min"], 0.00, places=6)
        self.assertAlmostEqual(result["worst_case"]["max"], 0.36, places=6)
        rss = math.sqrt(0.0084)
        self.assertAlmostEqual(result["rss"]["half_range"], rss, places=6)
        self.assertAlmostEqual(result["rss"]["min"], 0.18 - rss, places=6)
        self.assertAlmostEqual(result["rss"]["max"], 0.18 + rss, places=6)

    def test_requirement_verdict_follows_governing_method(self) -> None:
        result = stackup.compute(STACK)
        self.assertEqual(result["requirement"]["pass_by_method"], {"worst_case": False, "rss": True})
        self.assertFalse(result["requirement"]["pass"])
        rss_governed = dict(STACK, requirement={"min": 0.02, "max": 0.40, "method": "rss"})
        self.assertTrue(stackup.compute(rss_governed)["requirement"]["pass"])

    def test_contribution_shares_sum_to_100(self) -> None:
        rows = stackup.compute(STACK)["contributors"]
        self.assertAlmostEqual(sum(r["wc_contribution_pct"] for r in rows), 100.0, places=4)
        self.assertAlmostEqual(sum(r["rss_contribution_pct"] for r in rows), 100.0, places=4)

    def test_invalid_contributors_are_rejected(self) -> None:
        bad_cases = [
            {"contributors": []},
            {"contributors": [{"nominal": 1.0, "tol": 0.1, "direction": 2}]},
            {"contributors": [{"nominal": 1.0, "tol": -0.1, "direction": 1}]},
            {"contributors": [{"nominal": 1.0, "tol_plus": 0.1, "direction": 1}]},
            {"contributors": [{"nominal": 1.0, "tol": 0.1, "tol_plus": 0.1, "tol_minus": 0.1, "direction": 1}]},
            {"contributors": [{"nominal": "1", "tol": 0.1, "direction": 1}]},
            {"contributors": [{"nominal": 1.0, "tol": 0.1, "direction": 1}], "requirement": {"method": "rss"}},
        ]
        for case in bad_cases:
            with self.subTest(case=case), self.assertRaises(stackup.StackError):
                stackup.compute(case)


@unittest.skipUnless(shutil.which("uv"), "uv is required to run the PEP 723 script end to end")
class StackupCliTests(unittest.TestCase):
    def run_cli(self, text: str) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "stack.yaml"
            path.write_text(text, encoding="utf-8")
            return subprocess.run(
                ["uv", "run", "--quiet", "--script", str(SCRIPT), str(path)],
                capture_output=True,
                text=True,
                check=False,
                timeout=300,
            )

    def test_failing_requirement_exits_1_with_json(self) -> None:
        proc = self.run_cli(STACK_YAML)
        self.assertEqual(proc.returncode, 1, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertAlmostEqual(result["worst_case"]["max"], 0.36, places=6)

    def test_passing_requirement_exits_0(self) -> None:
        proc = self.run_cli(STACK_YAML.replace("method: worst_case", "method: rss"))
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_malformed_yaml_exits_2(self) -> None:
        proc = self.run_cli("contributors: [unclosed\n")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("invalid YAML", proc.stderr)


if __name__ == "__main__":
    unittest.main()
