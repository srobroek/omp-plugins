#!/usr/bin/env python3
"""Regression tests for cad-render: frame-quality heuristics, material mapping, explode
offsets, the render cache, and the renderer page's pinned module list.

Run: python3 -m unittest discover -s cad/skills/cad-render/tests
Stdlib only; the live render (Playwright, three.js) is exercised by scripts/render.py itself.
"""

from __future__ import annotations

import importlib.util
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
RENDER_PY = SKILL / "scripts" / "render.py"
TEMPLATE_HW = SKILL.parent / "cad-record" / "assets" / "project-template" / "hw"


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


render = load("cad_render", RENDER_PY)

BACKDROP = (218, 219, 220)
PRODUCT = (60, 64, 70)


def frame(w: int = 120, h: int = 90, *, subject=None, other=None, shadow=None, shadow_drop: int = 30,
          backdrop=BACKDROP, beauty_blank: bool = False) -> "render.Frame":
    """A synthetic frame: rectangles (x0, y0, x1, y1), exclusive ends, painted in this order:
    shadow (backdrop darkened by shadow_drop), other part, subject."""
    rgba = bytearray(bytes((*backdrop, 255)) * (w * h))
    mask = bytearray(w * h)

    def paint(rect, colour, cls):
        x0, y0, x1, y1 = rect
        for y in range(y0, y1):
            for x in range(x0, x1):
                if not beauty_blank:
                    rgba[(y * w + x) * 4:(y * w + x) * 4 + 3] = bytes(colour)
                if cls:
                    mask[y * w + x] = cls

    if shadow:
        paint(shadow, tuple(c - shadow_drop for c in backdrop), 0)
    if other:
        paint(other, (150, 155, 160), 1)
    if subject:
        paint(subject, PRODUCT, 2)
    return render.Frame(w, h, bytes(rgba), bytes(mask))


GOOD = dict(subject=(30, 20, 70, 60), shadow=(40, 60, 95, 75))


class QualityHeuristics(unittest.TestCase):
    def test_a_framed_product_with_a_ground_shadow_passes(self) -> None:
        quality = render.assess(frame(**GOOD))
        self.assertTrue(quality.passed, quality.failures)
        self.assertEqual(quality.metrics["backdrop_rgb"], list(BACKDROP))
        self.assertEqual(quality.metrics["subject_margin_px"], {"top": 20, "bottom": 30, "left": 30, "right": 50})

    def test_a_uniform_frame_is_blank(self) -> None:
        self.assertEqual(render.assess(frame()).failures, ["BLANK"])

    def test_a_black_frame_is_blank(self) -> None:
        self.assertEqual(render.assess(frame(backdrop=(0, 0, 0))).failures, ["BLANK"])

    def test_a_mask_without_pixels_behind_it_is_blank(self) -> None:
        """The subject mask rendered but the beauty pass drew nothing: still blank."""
        self.assertEqual(render.assess(frame(**GOOD, beauty_blank=True)).failures, ["BLANK"])

    def test_a_subject_touching_the_edge_is_clipped(self) -> None:
        quality = render.assess(frame(subject=(30, 20, 120, 60), shadow=(40, 60, 95, 75)))
        self.assertEqual(quality.failures, ["CLIPPED"])
        self.assertEqual(quality.metrics["subject_edge_px"]["right"], 40)

    def test_a_subject_cut_at_the_top_is_clipped(self) -> None:
        self.assertIn("CLIPPED", render.assess(frame(subject=(30, 0, 70, 50), shadow=(40, 50, 95, 75))).failures)

    def test_other_parts_may_cross_the_edge_of_a_close_up(self) -> None:
        quality = render.assess(frame(**GOOD, other=(0, 30, 30, 45)))
        self.assertTrue(quality.passed, quality.failures)

    def test_no_shadow_fails(self) -> None:
        self.assertEqual(render.assess(frame(subject=GOOD["subject"])).failures, ["NO_SHADOW"])

    def test_the_spike_faint_contact_shadow_fails(self) -> None:
        """The render spike's radial catcher darkened the floor by at most 3 luminance levels."""
        self.assertEqual(render.assess(frame(**GOOD, shadow_drop=3)).failures, ["NO_SHADOW"])

    def test_a_shadow_too_light_to_read_fails(self) -> None:
        self.assertEqual(render.assess(frame(**GOOD, shadow_drop=14)).failures, ["NO_SHADOW"])

    def test_a_shadow_too_small_to_read_fails(self) -> None:
        quality = render.assess(frame(subject=GOOD["subject"], shadow=(40, 60, 46, 63)))
        self.assertEqual(quality.failures, ["NO_SHADOW"])

    def test_a_dark_anti_aliased_rim_is_not_a_shadow(self) -> None:
        """A 2 px dark fringe hugging the product is edge blending, not a ground shadow."""
        quality = render.assess(frame(subject=GOOD["subject"], shadow=(28, 18, 72, 62), shadow_drop=80))
        self.assertEqual(quality.failures, ["NO_SHADOW"])
        self.assertEqual(quality.metrics["shadow_ratio"], 0.0)

    def test_frame_rejects_mismatched_buffers(self) -> None:
        with self.assertRaises(ValueError):
            render.Frame(4, 4, bytes(10), bytes(16))


class Materials(unittest.TestCase):
    table = render.MaterialTable.load()

    def rule(self, material: str, finish: str = "") -> str:
        return self.table.resolve(material, finish).id

    def test_template_parts_map_to_their_finish(self) -> None:
        self.assertEqual(self.rule("PETG", "Deburr; no sharp edges"), "petg")
        self.assertEqual(self.rule("Aluminum 6061-T6", "Bead-blast and clear anodize"), "aluminium-anodised-clear")
        self.assertEqual(self.rule("Stainless steel A2", "Passivated"), "stainless-steel")

    def test_finish_selects_among_one_material(self) -> None:
        self.assertEqual(self.rule("Aluminium 6082", "Black anodised"), "aluminium-anodised-black")
        self.assertEqual(self.rule("Aluminum 6061-T6", "As machined"), "aluminium-machined")
        self.assertEqual(self.rule("Steel 8.8", "Zinc plated"), "steel-zinc")
        self.assertEqual(self.rule("Steel S235", "Powder coat RAL 7016"), "painted")

    def test_names_from_the_brief(self) -> None:
        self.assertEqual(self.rule("PLA", "Matte"), "pla-matte")
        self.assertEqual(self.rule("EPDM rubber"), "rubber")
        self.assertEqual(self.rule("TPU 95A"), "rubber")
        self.assertEqual(self.rule("Steel C45"), "steel")

    def test_an_unknown_material_gets_the_neutral_default(self) -> None:
        self.assertEqual(self.rule("Unobtainium"), "unmapped")

    def test_every_rule_uses_known_pbr_keys(self) -> None:
        for rule in [*self.table.rules, self.table.default]:
            self.assertLessEqual(set(rule.pbr), set(render.PBR_KEYS), rule.id)

    def test_a_bad_table_is_an_infra_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "m.json"
            path.write_text(json.dumps({"rules": [{"id": "x", "label": "x", "material": "x",
                                                   "pbr": {"color": "#ffffff", "glow": 1}}],
                                        "default": {"id": "d", "label": "d", "pbr": {"color": "#000000"}}}))
            with self.assertRaises(render.InfraError):
                render.MaterialTable.load(path)


IDENTITY = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]]


class Explode(unittest.TestCase):
    joints = [
        {"id": "J-1", "type": "revolute", "parent": "A", "child": "B", "axis": [0, 0, 1], "origin": [0, 0, 10]},
        {"id": "J-2", "type": "revolute", "parent": "B", "child": "C", "axis": [0, 1, 0], "origin": [100, 0, 10]},
        {"id": "J-3", "type": "fixed", "parent": "B", "child": "P", "axis": [0, 1, 0], "origin": [100, 0, 10]},
    ]
    bboxes = {
        "A": {"min": [-20, -20, 0], "max": [20, 20, 10], "size": [40, 40, 10]},
        "B": {"min": [0, -5, 5], "max": [100, 5, 15], "size": [100, 10, 10]},
        "C": {"min": [100, -5, 5], "max": [200, 5, 15], "size": [100, 10, 10]},
        "P": {"min": [97, -10, 7], "max": [103, 10, 13], "size": [6, 20, 6]},
    }

    def offsets(self, toward=(0.0, -1.0, 0.5)):
        return render.explode_offsets(self.joints, "A", {}, self.bboxes, toward)

    def test_root_stays_and_moving_children_slide_out_of_their_joint(self) -> None:
        out = self.offsets()
        self.assertEqual(out["A"], (0.0, 0.0, 0.0))
        gap = render.MOVABLE_GAP * (100 ** 2 + 10 ** 2 + 10 ** 2) ** 0.5
        self.assertAlmostEqual(out["B"][0], gap)  # B's centre lies along +X from J-1's origin
        self.assertAlmostEqual(out["C"][0], 2 * gap)  # C carries B's offset plus its own

    def test_a_fixed_pin_pulls_along_its_axis_towards_the_camera(self) -> None:
        out = self.offsets()
        pull = render.FIXED_GAP * 20
        self.assertAlmostEqual(out["P"][1], -pull)
        self.assertAlmostEqual(out["P"][0], out["B"][0])
        self.assertAlmostEqual(self.offsets(toward=(0.0, 1.0, 0.5))["P"][1], pull)

    def test_the_parent_pose_rotates_a_child_axis(self) -> None:
        quarter = [[0.0, -1.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]]  # 90 deg about Z
        out = render.explode_offsets(self.joints, "A", {"B": quarter}, self.bboxes, (1.0, 0.0, 0.0))
        self.assertAlmostEqual(out["P"][0] - out["B"][0], render.FIXED_GAP * 20)

    def test_glb_frame_conversion(self) -> None:
        self.assertEqual(render.to_glb((1.0, 2.0, 3.0), 0.001), [0.001, 0.003, -0.002])


class Cache(unittest.TestCase):
    key = {"source_sha256": "a", "materials_sha256": "b", "renderer_sha256": "c", "image": "1600x1200"}

    def write(self, out: Path, status: str = "pass") -> None:
        out.mkdir(parents=True)
        png = b"\x89PNG fake"
        (out / "iso.png").write_bytes(png)
        (out / "manifest.json").write_text(json.dumps({
            "status": status, "cache_key": self.key,
            "views": {"iso": {"png": "iso.png", "sha256": render.sha256(png)}}}))

    def test_hit_only_on_a_passing_manifest_with_the_same_key_and_intact_pngs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "v1"
            self.assertIsNone(render.cache_hit(out, self.key, ["iso"]))
            self.write(out)
            self.assertIsNotNone(render.cache_hit(out, self.key, ["iso"]))
            self.assertIsNone(render.cache_hit(out, {**self.key, "materials_sha256": "changed"}, ["iso"]))
            self.assertIsNone(render.cache_hit(out, self.key, ["iso", "front"]))
            (out / "iso.png").write_bytes(b"edited")
            self.assertIsNone(render.cache_hit(out, self.key, ["iso"]))

    def test_a_failed_render_is_never_a_cache_hit(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "v1"
            self.write(out, status="fail")
            self.assertIsNone(render.cache_hit(out, self.key, ["iso"]))


class Views(unittest.TestCase):
    def test_close_ups_name_an_existing_part(self) -> None:
        self.assertEqual(render.parse_views(["iso", "closeup-LMP-0004", "iso"], ["LMP-0004"]), ["iso", "closeup-LMP-0004"])
        with self.assertRaises(render.InfraError):
            render.parse_views(["closeup-LMP-0009"], ["LMP-0004"])
        with self.assertRaises(render.InfraError):
            render.parse_views(["top"], ["LMP-0004"])


class RendererPage(unittest.TestCase):
    def test_every_module_render_js_imports_is_pinned(self) -> None:
        html = (render.RENDERER_DIR / "index.html").read_text(encoding="utf-8")
        importmap = json.loads(re.search(r'<script type="importmap">(.*?)</script>', html, re.S).group(1))
        integrity = importmap["integrity"]
        base = f"/vendor/three@{render.THREE_VERSION}/"
        self.assertEqual(importmap["imports"]["three"], base + "build/three.module.js")
        js = (render.RENDERER_DIR / "render.js").read_text(encoding="utf-8")
        for spec in re.findall(r'from "([^"]+)"', js):
            url = base + "build/three.module.js" if spec == "three" else base + "examples/jsm/" + spec.removeprefix("three/addons/")
            self.assertIn(url, integrity, spec)
        for url, sri in integrity.items():
            self.assertTrue(url.startswith(base), url)
            self.assertRegex(sri, r"^sha384-[A-Za-z0-9+/]{64}$")


class Cli(unittest.TestCase):
    def run_cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run([sys.executable, str(RENDER_PY), *args], capture_output=True, text=True, timeout=60)

    def test_a_project_without_versions_is_an_infra_error(self) -> None:
        result = self.run_cli(str(TEMPLATE_HW))
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)["status"], "error")

    def test_a_bad_size_is_a_usage_error(self) -> None:
        self.assertEqual(self.run_cli(str(TEMPLATE_HW), "--size", "huge").returncode, 2)


if __name__ == "__main__":
    unittest.main()
