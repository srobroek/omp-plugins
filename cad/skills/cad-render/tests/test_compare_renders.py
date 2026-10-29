from __future__ import annotations

import importlib.util
import json
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
from pathlib import Path
from typing import Any

COMPARE_PY = Path(__file__).resolve().parents[1] / "scripts" / "compare_renders.py"
LAYOUT_PY = Path(__file__).resolve().parents[2] / "cad-record" / "scripts" / "layout.py"


def load_layout() -> Any:
    name = "cad_record_layout"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, LAYOUT_PY)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name]


layout = load_layout()


def png_rgb(pixels: list[tuple[int, int, int]]) -> bytes:
    width = len(pixels)
    raw = b"\x00" + b"".join(bytes(pixel) for pixel in pixels)

    def chunk(kind: bytes, body: bytes) -> bytes:
        data = kind + body
        return struct.pack(">I", len(body)) + data + struct.pack(">I", zlib.crc32(data) & 0xffffffff)

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, 1, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def render_data(*, status="pass", failures=None, warnings=None, strategy="original", image="iso.png") -> dict[str, Any]:
    failures, warnings = failures or [], warnings or []
    attempts = [{"strategy": strategy, "failures": failures, "warnings": warnings}]
    return {"status": status, "views": {"iso": {
        "png": image, "quality": {"status": status, "failures": failures, "warnings": warnings},
        "retry": {"strategy": strategy, "attempts": attempts}}}}


def write_scratch(directory: Path, pixels: list[tuple[int, int, int]], **options: Any) -> Path:
    directory.mkdir(parents=True)
    png = png_rgb(pixels)
    metadata = render_data(**options)
    image = metadata["views"]["iso"]["png"]
    target = directory / image
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(png)
    (directory / "render.json").write_text(json.dumps(metadata), encoding="utf-8")
    return directory


def publish_bundle(hw: Path, pixels: list[tuple[int, int, int]], **options: Any) -> Path:
    version = hw / "versions" / "v1"
    (version / "record").mkdir(parents=True)
    (version / "manifest.json").write_text('{"fixture": true}\n', encoding="utf-8")
    staged = layout.staging(hw, "bundle.renders")
    (staged / "iso.png").write_bytes(png_rgb(pixels))
    metadata = render_data(**options)
    (staged / "render.json").write_text(json.dumps(metadata), encoding="utf-8")
    return layout.publish(hw, "bundle.renders", {"V": "v1", "S": "assembly"}, staged,
                          recipe={"views": ["iso"]}, producer="test", status=metadata["status"]).path


class CompareRenders(unittest.TestCase):
    @staticmethod
    def run_compare(left: Path, right: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["uv", "run", "--script", str(COMPARE_PY), str(left), str(right)],
                              capture_output=True, text=True, timeout=120)

    def test_identical_bundles_pass(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            left = publish_bundle(root / "left" / "hw", [(10, 20, 30), (40, 50, 60)])
            right = publish_bundle(root / "right" / "hw", [(10, 20, 30), (40, 50, 60)])
            result = self.run_compare(left, right)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(report["view_count"], 1)
            self.assertEqual(report["views"]["iso"]["max_channel_delta"], 0)

    def test_any_pixel_difference_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            left = publish_bundle(root / "left" / "hw", [(10, 20, 30)] * 1000)
            right = publish_bundle(root / "right" / "hw", [(13, 20, 30)] * 10 + [(10, 20, 30)] * 990)
            result = self.run_compare(left, right)
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(report["views"]["iso"]["max_channel_delta"], 3)
            self.assertEqual(report["views"]["iso"]["differing_pixels"], 10)

    def test_decision_mismatch_fails_even_when_pixels_match(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            left = publish_bundle(root / "left" / "hw", [(10, 20, 30)])
            right = publish_bundle(root / "right" / "hw", [(10, 20, 30)], status="warn",
                                   warnings=["NO_SHADOW"], strategy="reframe", failures=["BLANK"])
            result = self.run_compare(left, right)
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertEqual(json.loads(result.stdout)["decision_mismatch_views"], ["iso"])

    def test_bundle_compares_with_scratch_directory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle = publish_bundle(root / "hw", [(10, 20, 30), (40, 50, 60)])
            scratch = write_scratch(root / ".cad-work" / "render", [(10, 20, 30), (40, 50, 60)])
            result = self.run_compare(bundle, scratch)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue(json.loads(result.stdout)["pass"])

    def test_image_path_comes_from_render_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            left = write_scratch(root / "a", [(10, 20, 30)], image="images/iso.png")
            right = write_scratch(root / "b", [(10, 20, 30)], image="images/iso.png")
            result = self.run_compare(left, right)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_unsafe_image_path_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            left = write_scratch(root / "a", [(10, 20, 30)], image="../iso.png")
            right = write_scratch(root / "b", [(10, 20, 30)])
            result = self.run_compare(left, right)
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            self.assertIn("unsafe PNG path", json.loads(result.stdout)["error"])


if __name__ == "__main__":
    unittest.main()
