
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
from fea_static import CaseError, apply_required_safety_factor, error, load_case, result_exit_code, run_directory


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

    def test_required_safety_factor_controls_completed_verdict(self) -> None:
        base = {"safety_factor_yield": 2.5}
        self.assertEqual(apply_required_safety_factor(base.copy(), 2)["status"], "pass")
        self.assertEqual(apply_required_safety_factor(base.copy(), 600)["status"], "fail")
        self.assertEqual(apply_required_safety_factor(base.copy(), None)["status"], "pass")

    def test_exit_codes_distinguish_failed_check_from_no_result(self) -> None:
        self.assertEqual(result_exit_code({"status": "pass"}), 0)
        self.assertEqual(result_exit_code({"status": "fail"}), 1)
        self.assertEqual(result_exit_code({"status": "error"}), 2)
        self.assertEqual(result_exit_code({}), 2)

    def test_empty_plane_selector_fails_case_validation_with_exit_two(self) -> None:
        from fea_static import CaseError, load_case
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "part.step").touch()
            case = root / "case.yaml"
            case.write_text(
                """step: part.step
material: {E: 69000, nu: 0.33, density: 2700, yield: 276}
fixed_faces: {plane: {}}
loads: [{selector: {indices: [1]}, force: [0, 0, 50]}]
mesh_size: 5
""", encoding="utf-8")
            with self.assertRaises(CaseError):
                load_case(case)

    def test_empty_plane_selection_is_a_no_result_input(self) -> None:
        from fea_static import CaseError, selected_face_indices

        class Bounds:
            XMin = XMax = 4.0

        class Face:
            BoundBox = Bounds()
        with self.assertRaisesRegex(CaseError, "matched no faces"):
            selected_face_indices(1, {"plane": {"axis": "x", "value": 0.0, "tolerance": 0.01}}, [Face()])
        self.assertEqual(result_exit_code(error("invalid plane selector")), 2)

    def test_multi_solid_accepts_one_based_selection_index(self) -> None:
        from fea_static import load_case, CaseError
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "part.step").touch()
            case = root / "case.yaml"
            case.write_text(
                """step: part.step
solid_index: 2
material: {E: 69000, nu: 0.33, density: 2700, yield: 276}
fixed_faces: {indices: [1]}
loads: [{selector: {indices: [2]}, force: [0, 0, 50]}]
mesh_size: 5
""", encoding="utf-8")
            self.assertEqual(load_case(case)["solid_index"], 2)
            case.write_text(case.read_text(encoding="utf-8").replace("solid_index: 2", "solid_index: 0"), encoding="utf-8")
            with self.assertRaises(CaseError):
                load_case(case)

    def test_multi_solid_selection_uses_one_based_solid_index(self) -> None:
        names = [["LMP-0001 Base"], ["LMP-0001 Base"]]
        self.assertEqual(select_solid_index(names, None, 2), 1)
        with self.assertRaisesRegex(ValueError, "out of range"):
            select_solid_index(names, None, 3)

    def test_freecad_lookup_prefers_environment_before_path(self) -> None:
        from unittest.mock import patch
        from freecad_lookup import find_freecad

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            from_env = root / "env-freecad"
            from_path = root / "path-freecad"
            for command in (from_env, from_path):
                command.touch()
                command.chmod(0o755)
            with patch.dict("os.environ", {"FREECADCMD": str(from_env)}), patch(
                "freecad_lookup.shutil.which", return_value=str(from_path)
            ):
                self.assertEqual(find_freecad(), from_env)

    def test_freecad_lookup_prefers_path_before_bundle(self) -> None:
        from unittest.mock import patch
        from freecad_lookup import MACOS_FREECADCMD, find_freecad

        with tempfile.TemporaryDirectory() as directory:
            from_path = Path(directory) / "path-freecad"
            from_path.touch()
            from_path.chmod(0o755)
            with patch.dict("os.environ", {}, clear=True), patch(
                "freecad_lookup.shutil.which", return_value=str(from_path)
            ), patch("freecad_lookup.MACOS_FREECADCMD", MACOS_FREECADCMD):
                self.assertEqual(find_freecad(), from_path)
    def test_freecad_lookup_falls_back_to_macos_bundle(self) -> None:
        from unittest.mock import patch
        import freecad_lookup

        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory) / "bundle-freecad"
            bundle.touch()
            bundle.chmod(0o755)
            with patch.dict("os.environ", {}, clear=True), patch(
                "freecad_lookup.shutil.which", return_value=None
            ), patch.object(freecad_lookup, "MACOS_FREECADCMD", bundle):
                self.assertEqual(freecad_lookup.find_freecad(), bundle)

    def test_missing_freecad_is_structured_exit_two(self) -> None:
        from unittest.mock import patch
        from fea_static import main
        with patch("fea_static.find_freecad", return_value=None):
            self.assertEqual(main(["unused.yaml"]), 2)

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

    @unittest.skipUnless(FREECADCMD.is_file(), "FreeCAD 1.1.4 freecadcmd is not installed")
    def test_identical_case_repeats_mesh_and_stress_results(self) -> None:
        import math
        with tempfile.TemporaryDirectory(prefix="cad-fea-repeat-") as directory:
            root = Path(directory)
            step = root / "beam.step"
            job = root / "make_beam.py"
            job.write_text(
                f'''import FreeCAD as App, Part, Import
doc=App.newDocument("Beam")
beam=doc.addObject("Part::Feature", "Beam")
beam.Shape=Part.makeBox(100, 10, 5)
doc.recompute()
Import.export([beam], {str(step)!r})
App.closeDocument(doc.Name)
''', encoding="utf-8")
            generated = subprocess.run([str(FREECADCMD), str(job)], cwd=root, capture_output=True, text=True, timeout=120)
            self.assertIn(generated.returncode, (0, 139), generated.stdout + generated.stderr)
            case = root / "case.yaml"
            case.write_text(
                f"""step: {step}
material: {{name: Aluminum, E: 69000, nu: 0.33, density: 2700, yield: 276}}
fixed_faces: {{plane: {{axis: x, value: 0, tolerance: 0.000001}}}}
loads: [{{selector: {{plane: {{axis: x, value: 100, tolerance: 0.000001}}}}, force: [0, 0, -50]}}]
mesh_size: 5
""", encoding="utf-8")
            reports = []
            for _ in range(2):
                run = subprocess.run([sys.executable, str(SCRIPT), str(case)], capture_output=True, text=True, timeout=600)
                self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
                reports.append(json.loads(run.stdout))
            self.assertEqual(reports[0]["node_count"], reports[1]["node_count"])
            self.assertEqual(reports[0]["element_count"], reports[1]["element_count"])
            self.assertEqual(reports[0]["mesh_input_hashes"]["geometry_sha256"], reports[1]["mesh_input_hashes"]["geometry_sha256"])
            self.assertEqual(reports[0]["mesh_input_hashes"]["geo_sha256"], reports[1]["mesh_input_hashes"]["geo_sha256"])
            self.assertLessEqual(abs(reports[0]["safety_factor_yield"] / reports[1]["safety_factor_yield"] - 1), 0.0025)
    def test_freecad_timeout_maps_to_no_result(self) -> None:
        from unittest.mock import patch
        from fea_static import run_job
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            step = root / "part.step"
            step.touch()
            case = {
                "_step": str(step), "material": {"E": 1, "nu": 0.3, "density": 1, "yield": 1},
                "fixed_faces": {"indices": [1]}, "loads": [], "mesh_size": 1,
            }
            with patch("fea_static.find_freecad", return_value=Path("/fake/freecadcmd")), patch(
                "fea_static.subprocess.run", side_effect=subprocess.TimeoutExpired("freecadcmd", 0.01)
            ):
                result, status = run_job(root / "case.yaml", case, timeout=0.01)
            self.assertEqual(status, 2)
            self.assertEqual(result["error"]["code"], "freecad_timeout")

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
