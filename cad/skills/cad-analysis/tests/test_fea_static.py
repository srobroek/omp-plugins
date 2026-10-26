#!/usr/bin/env python3
"""Focused FEA selection, input, missing-FreeCAD, and solver integration checks."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/fea_static.py"
FREECADCMD = Path("/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd")
SPIKE = Path("/tmp/cad-spike-freecad")
sys.path.insert(0, str(SCRIPT.parent))
from fea_part_selection import select_solid_index
from fea_static import run_directory


class SolidSelectionContracts(unittest.TestCase):
    def test_single_solid_does_not_require_part(self) -> None:
        self.assertEqual(select_solid_index([["LMP-0002 Lower link"]], None), 0)

    def test_multi_solid_selects_part_by_product_or_label_prefix(self) -> None:
        self.assertEqual(select_solid_index([["LMP-0001 Base"], ["LMP-0002 Lower link"]], "LMP-0002"), 1)

    def test_unknown_part_lists_available_product_numbers(self) -> None:
        with self.assertRaisesRegex(ValueError, "LMP-0001, LMP-0002"):
            select_solid_index([["LMP-0001 Base"], ["LMP-0002 Lower link"]], "LMP-0003")

    def test_ambiguous_part_lists_available_product_numbers(self) -> None:
        with self.assertRaisesRegex(ValueError, "matches 2 STEP solids.*LMP-0002"):
            select_solid_index([["LMP-0002 Lower link"], ["LMP-0002 Lower link copy"]], "LMP-0002")


class StaticFEAContracts(unittest.TestCase):
    def test_run_directory_is_nested_under_case_runs(self) -> None:
        case = Path(tempfile.gettempdir()) / "analysis" / "case.yaml"
        self.assertEqual(run_directory(case, "abc123"), case.parent.resolve() / "runs" / "abc123")

    def test_missing_freecad_is_structured_exit_two(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "fea_static.py"
            shutil.copy2(SCRIPT, script)
            shutil.copy2(SCRIPT.with_name("fea_part_selection.py"), script.with_name("fea_part_selection.py"))
            source = script.read_text(encoding="utf-8").replace(
                'Path("/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd")',
                'Path("/definitely/missing/freecadcmd")',
            )
            script.write_text(source, encoding="utf-8")
            result = subprocess.run([sys.executable, str(script), "unused.yaml"], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(json.loads(result.stdout)["error"]["code"], "freecad_unavailable")

    def make_cantilever_step(self, root: Path) -> Path:
        step = root / "cantilever.step"
        job = root / "make_cantilever.py"
        job.write_text(
            f'''import FreeCAD as App, Part, Import
doc=App.newDocument("CantileverFixture")
beam=doc.addObject("Part::Feature", "Beam")
beam.Shape=Part.makeBox(100, 10, 5)
doc.recompute()
Import.export([beam], {str(step)!r})
App.closeDocument(doc.Name)
''', encoding="utf-8")
        generated = subprocess.run([str(FREECADCMD), str(job)], cwd=root, capture_output=True, text=True, timeout=120)
        self.assertIn(generated.returncode, (0, 139), generated.stdout + generated.stderr)
        self.assertTrue(step.is_file() and step.stat().st_size > 0, generated.stdout + generated.stderr)
        return step

    @unittest.skipUnless(FREECADCMD.is_file(), "FreeCAD 1.1.4 freecadcmd is not installed")
    @unittest.skipUnless((SPIKE / "fem.py").is_file(), "proven cantilever FreeCAD spike is missing")
    def test_cantilever_matches_beam_theory_within_five_percent(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cad-fea-cantilever-") as directory:
            root = Path(directory)
            step = self.make_cantilever_step(root)
            case = root / "case.yaml"
            case.write_text(
                f"""step: {step}
pose: {{J-001: 17, J-002: -42}}
material: {{name: Aluminium 6061, E: 69000, nu: 0.33, density: 2700, yield: 276}}
fixed_faces: {{plane: {{axis: x, value: 0, tolerance: 0.000001}}}}
loads:
  - selector: {{plane: {{axis: x, value: 100, tolerance: 0.000001}}}}
    force: [0, 0, -50]
mesh_size: 5
""", encoding="utf-8")
            result = subprocess.run([sys.executable, str(SCRIPT), str(case)], capture_output=True, text=True, timeout=600)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(report["status"], "pass", report)
            self.assertLess(abs(report["max_von_mises_mpa"] / 120.0 - 1), 0.05)
            self.assertLess(abs(report["max_displacement_mm"] / 2.31884 - 1), 0.05)
            self.assertGreater(report["node_count"], 0)
            self.assertGreater(report["element_count"], 0)
            self.assertTrue((root / "results.json").is_file())
            self.assertEqual(report["worst_case_pose"], {"step": str(step), "pose": {"J-001": 17, "J-002": -42}})
            self.assertIn("calculix", report["solver_versions"])
            self.assertIn("gmsh", report["solver_versions"])

    @unittest.skipUnless(FREECADCMD.is_file(), "FreeCAD 1.1.4 freecadcmd is not installed")
    def test_invalid_face_selector_is_structured_exit_two(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cad-fea-case-") as directory:
            root = Path(directory)
            step = self.make_cantilever_step(root)
            case = root / "case.yaml"
            case.write_text(
                f"""step: {step}
material: {{E: 69000, nu: 0.33, density: 2700, yield: 276}}
fixed_faces: {{indices: [0]}}
loads: [{{selector: {{indices: [1]}}, force: [0, 0, 50]}}]
mesh_size: 5
""", encoding="utf-8")
            result = subprocess.run([sys.executable, str(SCRIPT), str(case)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(json.loads(result.stdout)["error"]["code"], "invalid_case")


if __name__ == "__main__":
    unittest.main()
