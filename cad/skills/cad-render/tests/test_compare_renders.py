from __future__ import annotations

import json
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
from pathlib import Path

COMPARE_PY = Path(__file__).resolve().parents[1] / "scripts" / "compare_renders.py"


def png_rgb(pixels: list[tuple[int, int, int]]) -> bytes:
    width = len(pixels)
    raw = b"\x00" + b"".join(bytes(pixel) for pixel in pixels)
    def chunk(kind: bytes, body: bytes) -> bytes:
        data = kind + body
        return struct.pack(">I", len(body)) + data + struct.pack(">I", zlib.crc32(data) & 0xffffffff)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, 1, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


class CompareRenders(unittest.TestCase):
    @staticmethod
    def write_run(directory: Path, pixels: list[tuple[int, int, int]], *, status="pass", failures=None, warnings=None, strategy="original") -> None:
        directory.mkdir(parents=True)
        (directory / "iso.png").write_bytes(png_rgb(pixels))
        decision = {"status": status, "failures": failures or [], "warnings": warnings or [],
                    "strategy": strategy, "attempts": [{"strategy": strategy, "failures": failures or [],
                                                          "warnings": warnings or []}]}
        (directory / "render.json").write_text(json.dumps({
            "views": {"iso": {"png": "iso.png", "quality": {
                "status": decision["status"], "failures": decision["failures"], "warnings": decision["warnings"]},
                "retry": {"strategy": decision["strategy"], "attempts": decision["attempts"]}}}}))

    @staticmethod
    def run_compare(left: Path, right: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["uv", "run", "--script", str(COMPARE_PY), str(left), str(right)],
                              capture_output=True, text=True, timeout=120)

    def test_identical_images_pass(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.write_run(root / "a", [(10, 20, 30), (40, 50, 60)])
            self.write_run(root / "b", [(10, 20, 30), (40, 50, 60)])
            result = self.run_compare(root / "a", root / "b")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(report["view_count"], 1)
            self.assertEqual(report["views"]["iso"]["max_channel_delta"], 0)

    def test_any_pixel_difference_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.write_run(root / "a", [(10, 20, 30)] * 1000)
            self.write_run(root / "b", [(13, 20, 30)] * 10 + [(10, 20, 30)] * 990)
            result = self.run_compare(root / "a", root / "b")
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(report["views"]["iso"]["max_channel_delta"], 3)
            self.assertEqual(report["views"]["iso"]["differing_pixels"], 10)

    def test_decision_mismatch_fails_even_when_pixels_match(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.write_run(root / "a", [(10, 20, 30)])
            self.write_run(root / "b", [(10, 20, 30)], status="warn", warnings=["NO_SHADOW"],
                           strategy="reframe", failures=["BLANK"])
            result = self.run_compare(root / "a", root / "b")
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertEqual(json.loads(result.stdout)["decision_mismatch_views"], ["iso"])
    def test_image_path_comes_from_render_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            left, right = root / "a", root / "b"
            self.write_run(left, [(10, 20, 30)])
            self.write_run(right, [(10, 20, 30)])
            for directory in (left, right):
                metadata = json.loads((directory / "render.json").read_text())
                metadata["views"]["iso"]["png"] = "images/iso.png"
                (directory / "images").mkdir()
                (directory / "images" / "iso.png").write_bytes((directory / "iso.png").read_bytes())
                (directory / "render.json").write_text(json.dumps(metadata))
            result = self.run_compare(left, right)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
