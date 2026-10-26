#!/usr/bin/env python3
"""Focused TechDraw export, marker enforcement, and absent-FreeCAD tests."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/drawing.py"
FREECAD = Path("/Applications/FreeCAD.app/Contents/MacOS/FreeCAD")
STEP_FIXTURE = Path("/tmp/cad-spike-freecad/step_default.step")


class DrawingContracts(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="cad-drawing-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.part = self.root / "part.yaml"
        self.product = self.root / "product.yaml"
        self.step = self.root / "part.step"
        self.part.write_text("PN: TEST-001\nrev: A\ntitle: Test Part\nmaterial: PLA\n", encoding="utf-8")
        self.product.write_text("regime: iso\ngeneral_tolerance: ISO 2768-m\n", encoding="utf-8")
        if STEP_FIXTURE.is_file():
            shutil.copy2(STEP_FIXTURE, self.step)

    def command(self, output: Path, script: Path = SCRIPT) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(script), str(self.step), "--part", str(self.part), "--product", str(self.product), "--output-dir", str(output)],
            capture_output=True, text=True, timeout=300,
        )

    def fake_launcher_script(self, directory: str, launcher: Path) -> Path:
        script = Path(directory) / "drawing.py"
        shutil.copy2(SCRIPT, script)
        source = script.read_text(encoding="utf-8").replace(
            'FREECAD = Path(os.environ.get("FREECAD_LAUNCHER", "/Applications/FreeCAD.app/Contents/MacOS/FreeCAD"))',
            f'FREECAD = Path(os.environ.get("FREECAD_LAUNCHER", {str(launcher)!r}))',
        )
        script.write_text(source, encoding="utf-8")
        return script

    def test_missing_freecad_is_structured_exit_two(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            script = self.fake_launcher_script(directory, Path(directory) / "missing-FreeCAD")
            result = self.command(self.root / "out", script)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(json.loads(result.stdout)["error"]["code"], "freecad_unavailable")

    def test_missing_marker_fails_even_if_old_outputs_exist(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            launcher = Path(directory) / "FreeCAD"
            launcher.write_text("#!/bin/sh\nexit 139\n", encoding="utf-8")
            launcher.chmod(0o755)
            script = self.fake_launcher_script(directory, launcher)
            output = self.root / "out"
            output.mkdir()
            (output / "drawing.pdf").write_bytes(b"old PDF")
            (output / "drawing.svg").write_text("<svg/>", encoding="utf-8")
            result = self.command(output, script)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout)["error"]["code"], "missing_completion_marker")

    @unittest.skipUnless(FREECAD.is_file(), "FreeCAD 1.1.4 GUI launcher is not installed")
    def test_exports_fresh_nonempty_pdf_and_svg(self) -> None:
        self.assertTrue(self.step.is_file(), "STEP test fixture is unavailable")
        result = self.command(self.root / "output")
        report = json.loads(result.stdout)
        self.assertEqual(result.returncode, 0, report)
        self.assertEqual(report["status"], "pass")
        for name in ("pdf", "svg"):
            artifact = Path(report[name])
            self.assertGreater(artifact.stat().st_size, 0)
        self.assertTrue(Path(report["template"]).is_file())
        self.assertTrue(any(Path(self.root / "output").glob("drawing_*.complete.json")))
        self.assertTrue(report["templates_found"]["iso"])
        self.assertTrue(report["templates_found"]["asme"])


if __name__ == "__main__":
    unittest.main()
