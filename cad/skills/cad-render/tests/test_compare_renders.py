from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image

import importlib.util
import sys

COMPARE_PY = Path(__file__).resolve().parents[1] / "scripts" / "compare_renders.py"
spec = importlib.util.spec_from_file_location("cad_render_compare", COMPARE_PY)
assert spec and spec.loader
compare_renders = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = compare_renders
spec.loader.exec_module(compare_renders)
compare = compare_renders.compare


class CompareRenders(unittest.TestCase):
    def write_run(self, directory: Path, *, pixels: list[tuple[int, int, int]], decisions: dict | None = None) -> None:
        directory.mkdir(parents=True)
        image = Image.new("RGB", (len(pixels), 1))
        image.putdata(pixels)
        image.save(directory / "iso.png")
        decision = decisions or {"status": "pass", "failures": [], "warnings": [],
                                 "strategy": "original", "attempts": [("original", [], [])]}
        (directory / "manifest.json").write_text(json.dumps({
            "views": {"iso": {"png": "iso.png", "quality": {
                "status": decision["status"], "failures": decision["failures"], "warnings": decision["warnings"]},
                "retry": {"strategy": decision["strategy"], "attempts": [
                    {"strategy": strategy, "failures": failures, "warnings": warnings}
                    for strategy, failures, warnings in decision["attempts"]]}}}}))

    def test_identical_images_pass(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.write_run(root / "a", pixels=[(10, 20, 30), (40, 50, 60)])
            self.write_run(root / "b", pixels=[(10, 20, 30), (40, 50, 60)])
            result = compare(root / "a", root / "b")
            self.assertTrue(result["pass"])
            self.assertEqual(result["views"]["iso"]["max_channel_delta"], 0)
            self.assertEqual(result["views"]["iso"]["p999_pixel_max_channel_delta"], 0)

    def test_any_pixel_difference_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.write_run(root / "a", pixels=[(10, 20, 30)] * 1000)
            self.write_run(root / "b", pixels=[(13, 20, 30)] * 10 + [(10, 20, 30)] * 990)
            result = compare(root / "a", root / "b")
            self.assertFalse(result["pass"])
            self.assertEqual(result["views"]["iso"]["max_channel_delta"], 3)
            self.assertEqual(result["views"]["iso"]["differing_pixels"], 10)

    def test_decision_mismatch_fails_even_when_pixels_match(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.write_run(root / "a", pixels=[(10, 20, 30)])
            self.write_run(root / "b", pixels=[(10, 20, 30)], decisions={
                "status": "warn", "failures": [], "warnings": ["NO_SHADOW"],
                "strategy": "reframe", "attempts": [("original", ["BLANK"], []),
                                                           ("reframe", [], ["NO_SHADOW"])],
            })
            result = compare(root / "a", root / "b")
            self.assertFalse(result["pass"])
            self.assertEqual(result["decision_mismatch_views"], ["iso"])


if __name__ == "__main__":
    unittest.main()
