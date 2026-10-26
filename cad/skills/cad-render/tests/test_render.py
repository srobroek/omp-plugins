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
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
RENDER_PY = SKILL / "scripts" / "render.py"
MATERIALS_PY = SKILL / "scripts" / "materials.py"
TEMPLATE_HW = SKILL.parent / "cad-record" / "assets" / "project-template" / "hw"


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


render = load("cad_render", RENDER_PY)
materials = load("cad_render_materials", MATERIALS_PY)

BACKDROP = (218, 219, 220)
PRODUCT = (60, 64, 70)


def frame(w: int = 120, h: int = 90, *, subject=None, other=None, shadow=None, shadow_drop: int = 30,
          overhung=None, overhung_drop: int = 30, rim=None,
          backdrop=BACKDROP, beauty_blank: bool = False) -> "render.Frame":
    """A synthetic frame: rectangles (x0, y0, x1, y1), exclusive ends, painted in this order:
    shadow (backdrop darkened by shadow_drop), overhung floor (darkened by overhung_drop), other
    part, subject, then the grounded rim (a floor zone only, on whatever part is painted there)."""
    rgba = bytearray(bytes((*backdrop, 255)) * (w * h))
    mask = bytearray(w * h)
    floor = bytearray(w * h)

    def paint(rect, colour, cls=0, zone=0):
        x0, y0, x1, y1 = rect
        for y in range(y0, y1):
            for x in range(x0, x1):
                if colour and not beauty_blank:
                    rgba[(y * w + x) * 4:(y * w + x) * 4 + 3] = bytes(colour)
                if cls:
                    mask[y * w + x] = cls
                if zone:
                    floor[y * w + x] = zone

    if shadow:
        paint(shadow, tuple(c - shadow_drop for c in backdrop))
    if overhung:
        paint(overhung, tuple(c - overhung_drop for c in backdrop), zone=render.FLOOR_OVERHUNG)
    if other:
        paint(other, (150, 155, 160), 1)
    if subject:
        paint(subject, PRODUCT, 2)
    if rim:
        paint(rim, None, zone=render.FLOOR_RIM)
    return render.Frame(w, h, bytes(rgba), bytes(mask), bytes(floor))


GOOD = dict(subject=(30, 20, 70, 60), shadow=(40, 60, 95, 75))
# A grounded subject: its bottom rows stand on the floor, its contact shadow fills the rows below,
# and floor to its right lies under an overhang.
GROUNDED = dict(subject=(30, 20, 70, 60), rim=(30, 57, 70, 60), shadow=(30, 60, 70, 75), overhung=(80, 30, 110, 60))


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

    def test_a_contact_darker_than_the_overhang_shadow_passes(self) -> None:
        quality = render.assess(frame(**GROUNDED, shadow_drop=40, overhung_drop=12))
        self.assertTrue(quality.passed, quality.failures)
        self.assertEqual((quality.metrics["contact_depth"], quality.metrics["overhang_depth"]), (40.0, 12.0))

    def test_an_overhang_shadow_darker_than_the_contact_is_inverted(self) -> None:
        """Head 85e4829914: the shade 117 mm up cast the darkest shadow, the base barely grounded."""
        quality = render.assess(frame(**GROUNDED, shadow_drop=12, overhung_drop=40))
        self.assertEqual(quality.failures, ["INVERTED_SHADOW"])

    def test_without_floor_zones_the_inversion_check_is_skipped(self) -> None:
        quality = render.assess(frame(**GOOD))
        self.assertEqual((quality.metrics["contact_depth"], quality.metrics["overhang_depth"]), (None, None))

    def test_a_faint_shadow_passes_a_close_up_but_not_a_full_assembly_view(self) -> None:
        """A close-up may frame only a part high above the floor, whose true shadow is faint."""
        faint = frame(**GOOD, shadow_drop=14)
        self.assertTrue(render.assess(faint, closeup=True).passed)
        self.assertEqual(render.assess(faint).failures, ["NO_SHADOW"])
        self.assertEqual(render.assess(frame(**GOOD, shadow_drop=3), closeup=True).failures, ["NO_SHADOW"])

    def test_frame_rejects_mismatched_buffers(self) -> None:
        with self.assertRaises(ValueError):
            render.Frame(4, 4, bytes(64), bytes(16), bytes(10))


class Materials(unittest.TestCase):
    table = materials.MaterialTable.load()

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
            self.assertLessEqual(set(rule.pbr), set(materials.PBR_KEYS), rule.id)

    def test_a_bad_table_is_a_materials_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "m.json"
            path.write_text(json.dumps({"rules": [{"id": "x", "label": "x", "material": "x",
                                                   "pbr": {"color": "#ffffff", "glow": 1}}],
                                        "default": {"id": "d", "label": "d", "pbr": {"color": "#000000"}}}))
            with self.assertRaises(materials.MaterialsError):
                materials.MaterialTable.load(path)


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


class CacheKey(unittest.TestCase):
    """build_scene's key against a cad-model version of the template record (no real GLB)."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.hw = Path(self.tmp.name) / "hw"
        shutil.copytree(TEMPLATE_HW, self.hw)
        pns = sorted(p.name for p in (self.hw / "parts").iterdir())
        folder = self.hw / "versions" / "v1"
        folder.mkdir(parents=True)
        (folder / "assembly.step").write_text("", encoding="utf-8")
        (folder / "assembly.glb").write_bytes(b"glTF v1")
        self.write(folder / "part-map.json", {"parts": {pn: {"node_indices": [i]} for i, pn in enumerate(pns)}})
        self.write(folder / "metrics.json", {"parts": {pn: {"bbox_mm": {"min": [0, 0, 0], "max": [10, 10, 10],
                                                                        "size": [10, 10, 10]}} for pn in pns}})
        self.write(folder / "manifest.json", {"ground": pns[0], "pose": {"transforms": {pn: IDENTITY for pn in pns}}})
        self.write(self.hw / "versions" / "latest.json", {
            "label": "v1", **{k: f"versions/v1/{name}" for k, name in render.version_layout.FILES.items()}})

    def tearDown(self) -> None:
        self.tmp.cleanup()

    @staticmethod
    def write(path: Path, data: dict) -> None:
        path.write_text(json.dumps(data), encoding="utf-8")

    def key(self) -> dict:
        version = render.resolve_version(self.hw, "latest")
        return render.build_scene(self.hw, version, ["iso", "exploded"], (800, 600), materials.MaterialTable.load())[2]["key"]

    def test_every_input_the_scene_reads_changes_the_key(self) -> None:
        def edit_json(name: str, change) -> None:
            path = self.hw / "versions" / "v1" / name
            data = json.loads(path.read_text(encoding="utf-8"))
            change(data)
            self.write(path, data)

        part_yaml = self.hw / "parts" / "LMP-0002" / "part.yaml"
        edits = {
            "glb": lambda: (self.hw / "versions" / "v1" / "assembly.glb").write_bytes(b"glTF v2"),
            "part map": lambda: edit_json("part-map.json", lambda d: d["parts"]["LMP-0002"].update(node_indices=[9])),
            "manifest pose": lambda: edit_json("manifest.json", lambda d: d["pose"]["transforms"]["LMP-0002"][0].__setitem__(3, 5.0)),
            "metrics bbox": lambda: edit_json("metrics.json", lambda d: d["parts"]["LMP-0003"]["bbox_mm"].update(size=[10, 10, 99])),
            "assembly.yaml": lambda: (self.hw / "assembly.yaml").write_text(
                (self.hw / "assembly.yaml").read_text(encoding="utf-8") + "\n# edited\n", encoding="utf-8"),
            "part material": lambda: part_yaml.write_text(
                re.sub(r"(?m)^material:.*$", "material: PETG", part_yaml.read_text(encoding="utf-8")), encoding="utf-8"),
        }
        before = self.key()
        for name, edit in edits.items():
            with self.subTest(input=name):
                edit()
                after = self.key()
                self.assertNotEqual(after, before)
                before = after

    def test_a_file_the_render_does_not_read_keeps_the_key(self) -> None:
        before = self.key()
        (self.hw / "bom.csv").write_text("edited\n", encoding="utf-8")
        self.assertEqual(self.key(), before)

    def test_a_malformed_latest_json_is_an_infra_error(self) -> None:
        self.write(self.hw / "versions" / "latest.json", {"glb": "versions/v1/assembly.glb"})
        with self.assertRaisesRegex(render.InfraError, "label"):
            render.resolve_version(self.hw, "latest")
        self.assertEqual(render.resolve_version(self.hw, "v1").label, "v1")  # the documented layout still resolves


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
