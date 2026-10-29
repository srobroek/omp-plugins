#!/usr/bin/env python3
"""Regression tests for cad-render heuristics, cache, renderer assets and policy.

Run: python3 -m unittest discover -s cad/skills/cad-render/tests
Pillow is only needed by the standalone image comparator's tests.
"""

from __future__ import annotations

import argparse
from unittest import mock
import asyncio
import hashlib
import base64
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
RENDER_EXAMPLE = SKILL.parent.parent / "examples" / "lamp-arm" / "hw"
TEMPLATE_HW = RENDER_EXAMPLE
COMPARE_PY = SKILL / "scripts" / "compare_renders.py"
PARITY_PY = SKILL / "scripts" / "parity_policy.py"
def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


render = load("cad_render", RENDER_PY)
materials = load("cad_render_materials", MATERIALS_PY)
parity = load("cad_render_parity_policy", PARITY_PY)

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

class VersionManifestSchema(unittest.TestCase):
    def test_schema_two_requires_record_and_manufacturing_maps(self) -> None:
        reader = render.version_reader
        for key in ("record", "manufacturing"):
            invalid = {"schema_version": 2, "record": {}, "manufacturing": {}}
            invalid[key] = None
            with self.subTest(key=key), self.assertRaisesRegex(reader.VersionError, key):
                reader.validate_version_manifest(invalid)
        reader.validate_version_manifest({"schema_version": 2, "record": {}, "manufacturing": {}})

    def test_schema_one_version_manifest_is_rejected(self) -> None:
        with self.assertRaisesRegex(render.version_reader.VersionError, "supported version manifest"):
            render.version_reader.validate_version_manifest({"schema_version": 1, "record": {}, "manufacturing": {}})


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
    def test_closeup_below_visible_fraction_threshold_is_occluded(self) -> None:
        quality = render.assess(frame(**GOOD), closeup=True, visible_fraction=0.249)
        self.assertIn("OCCLUDED", quality.failures)
        self.assertEqual(quality.metrics["visible_subject_fraction"], 0.249)

    def test_closeup_at_visible_fraction_threshold_is_not_occluded(self) -> None:
        quality = render.assess(frame(**GOOD), closeup=True, visible_fraction=0.25)
        self.assertNotIn("OCCLUDED", quality.failures)

    def test_a_subject_cut_at_the_top_is_clipped(self) -> None:
        self.assertIn("CLIPPED", render.assess(frame(subject=(30, 0, 70, 50), shadow=(40, 50, 95, 75))).failures)

    def test_other_parts_may_cross_the_edge_of_a_close_up(self) -> None:
        quality = render.assess(frame(**GOOD, other=(0, 30, 30, 45)))
        self.assertTrue(quality.passed, quality.failures)

    def test_no_shadow_is_a_cosmetic_warning(self) -> None:
        quality = render.assess(frame(subject=GOOD["subject"]))
        self.assertTrue(quality.passed)
        self.assertEqual(quality.failures, [])
        self.assertEqual(quality.warnings, ["NO_SHADOW"])

    def test_faint_shadow_is_a_cosmetic_warning(self) -> None:
        self.assertEqual(render.assess(frame(**GOOD, shadow_drop=3)).warnings, ["NO_SHADOW"])

    def test_too_light_shadow_is_a_cosmetic_warning(self) -> None:
        self.assertEqual(render.assess(frame(**GOOD, shadow_drop=14)).warnings, ["NO_SHADOW"])

    def test_too_small_shadow_is_a_cosmetic_warning(self) -> None:
        quality = render.assess(frame(subject=GOOD["subject"], shadow=(40, 60, 46, 63)))
        self.assertEqual(quality.warnings, ["NO_SHADOW"])

    def test_a_dark_anti_aliased_rim_is_not_a_shadow(self) -> None:
        """A 2 px dark fringe hugging the product is edge blending, not a ground shadow."""
        quality = render.assess(frame(subject=GOOD["subject"], shadow=(28, 18, 72, 62), shadow_drop=80))
        self.assertEqual(quality.warnings, ["NO_SHADOW"])
        self.assertEqual(quality.metrics["shadow_ratio"], 0.0)
    def test_a_contact_darker_than_the_overhang_shadow_passes(self) -> None:
        quality = render.assess(frame(**GROUNDED, shadow_drop=40, overhung_drop=12))
        self.assertTrue(quality.passed, quality.failures)
        self.assertEqual((quality.metrics["contact_depth"], quality.metrics["overhang_depth"]), (40.0, 12.0))

    def test_an_overhang_shadow_darker_than_contact_warns_but_passes(self) -> None:
        """Head 85e4829914: the shade 117 mm up cast the darkest shadow, the base barely grounded."""
        quality = render.assess(frame(**GROUNDED, shadow_drop=12, overhung_drop=40))
        self.assertTrue(quality.passed)
        self.assertEqual(quality.warnings, ["INVERTED_SHADOW"])

    def test_without_floor_zones_the_inversion_check_is_skipped(self) -> None:
        quality = render.assess(frame(**GOOD))
        self.assertEqual((quality.metrics["contact_depth"], quality.metrics["overhang_depth"]), (None, None))

    def test_a_close_up_can_use_contact_shading_on_its_support(self) -> None:
        supported = frame(subject=(45, 35, 70, 55), other=(25, 30, 90, 70))
        rgba = bytearray(supported.rgba)
        for y in range(36, 70, render.SAMPLE_STRIDE):
            for x in range(26, 90, render.SAMPLE_STRIDE):
                if supported.mask[y * supported.width + x] == 1 and not any(
                    supported.mask[(y + dy) * supported.width + x + dx] == 2
                    for dy in range(-render.PART_CLEARANCE_PX, render.PART_CLEARANCE_PX + 1)
                    for dx in range(-render.PART_CLEARANCE_PX, render.PART_CLEARANCE_PX + 1)
                ):
                    i = (y * supported.width + x) * 4
                    rgba[i:i + 3] = bytes((105, 109, 112))
        quality = render.assess(render.Frame(supported.width, supported.height, bytes(rgba), supported.mask,
                                             supported.floor), closeup=True)
        self.assertTrue(quality.passed, quality.failures)
        self.assertGreaterEqual(quality.metrics["support_shadow_ratio"], 0.025)

    def test_a_blank_close_up_fails_and_shadowless_close_up_warns(self) -> None:
        self.assertEqual(render.assess(frame(), closeup=True).failures, ["BLANK"])
        shadowless = render.assess(frame(subject=(30, 20, 70, 60)), closeup=True)
        self.assertTrue(shadowless.passed)
        self.assertEqual(shadowless.warnings, ["NO_SHADOW"])
    def test_frame_rejects_mismatched_buffers(self) -> None:
        with self.assertRaises(ValueError):
            render.Frame(4, 4, bytes(64), bytes(16), bytes(10))


class RetryLadder(unittest.TestCase):
    @staticmethod
    def capture_frame(name: str, rendered, *, fraction: float = 1.0) -> dict:
        rgba = rendered.rgba
        return {"view": name, "width": rendered.width, "height": rendered.height,
                "png": "data:image/png;base64,AA==", "rgba": rgba,
                "mask": rendered.mask, "floor": rendered.floor, "visible_subject_fraction": fraction,
                "camera": {"position": [0, 0, 1], "target": [0, 0, 0], "up": [0, 1, 0],
                           "fov_deg": 28, "aspect": 1.33}}

    def test_enclosed_subject_retries_and_records_each_attempt(self) -> None:
        calls = []
        def capture(options: dict) -> dict:
            calls.append(options)
            fraction = 1.0 if options.get("ghost") else 0.1
            return self.capture_frame("closeup-LMP-0004", frame(**GOOD), fraction=fraction)
        _, quality, attempts = asyncio.run(render._retry_view("closeup-LMP-0004", lambda options, attempt: capture(options)))
        self.assertTrue(quality.passed)
        self.assertEqual(attempts[-1]["strategy"], "ghosted-context")
    def test_closeup_alternates_stay_fitted_and_clean_candidates_beat_visible_clipped_ones(self) -> None:
        calls = []
        clipped = frame(subject=(30, 20, 120, 60), shadow=(40, 60, 95, 75))
        clean = frame(**GOOD)

        def capture(options: dict, attempt: int) -> dict:
            calls.append(options)
            if not options:
                return self.capture_frame("closeup-LMP-0004", clean, fraction=0.1)
            if len(calls) == 2:
                return self.capture_frame("closeup-LMP-0004", clipped, fraction=0.99)
            return self.capture_frame("closeup-LMP-0004", clean, fraction=0.3)

        result, quality, attempts = asyncio.run(render._retry_view("closeup-LMP-0004", capture))
        self.assertTrue(quality.passed, quality.failures)
        self.assertEqual(result["retry"]["strategy"], "alternate-camera")
        self.assertTrue(all(options.get("frameScale", 1.0) <= 1.0 for options in calls[1:]))
        self.assertNotIn("ghosted-context", [row["strategy"] for row in attempts])

    def test_isolated_retry_resets_subject_visibility_ratio(self) -> None:
        attempts = []
        def capture(options: dict) -> dict:
            isolated = options.get("isolated", False)
            attempts.append(isolated)
            rendered = frame(**GOOD)
            return self.capture_frame("closeup-LMP-0004", rendered, fraction=1.0 if isolated else 0.1)
        _, quality, records = asyncio.run(render._retry_view("closeup-LMP-0004", lambda options, attempt: capture(options)))
        self.assertTrue(quality.passed)
        self.assertEqual(records[-1]["strategy"], "isolated-part")
        self.assertEqual(records[-1]["metrics"]["visible_subject_fraction"], 1.0)
    def test_isolated_mode_mask_hides_all_non_subject_parts(self) -> None:
        hidden = []
        def capture(options: dict) -> dict:
            hidden.append(options.get("isolated", False))
            rendered = frame(**GOOD)
            if options.get("isolated"):
                rendered = render.Frame(rendered.width, rendered.height, rendered.rgba,
                                        bytes(2 if value == 1 else value for value in rendered.mask), rendered.floor)
            return self.capture_frame("closeup-LMP-0004", rendered,
                                      fraction=1.0 if options.get("isolated") else 0.1)
        result, _, _ = asyncio.run(render._retry_view("closeup-LMP-0004", lambda options, attempt: capture(options)))
        mask = base64.b64decode(result["mask"])
        self.assertTrue(hidden[-1])
        self.assertNotIn(1, mask)

    def test_shadowless_closeup_passes_as_warning_without_retry(self) -> None:
        rendered = frame(subject=GOOD["subject"])
        _, quality, attempts = asyncio.run(render._retry_view(
            "closeup-LMP-0004", lambda options, attempt: self.capture_frame("closeup-LMP-0004", rendered)))
        self.assertTrue(quality.passed)
        self.assertEqual(quality.warnings, ["NO_SHADOW"])
        self.assertEqual([row["strategy"] for row in attempts], ["original"])

    def test_empty_render_fails_after_blank_retry(self) -> None:
        rendered = frame()
        _, quality, attempts = asyncio.run(render._retry_view("iso", lambda options, attempt: self.capture_frame("iso", rendered)))
        self.assertFalse(quality.passed)
        self.assertEqual(quality.failures, ["BLANK"])
        self.assertEqual([row["strategy"] for row in attempts], ["original", "blank-retry"])

    def test_fixed_view_reframes_clipped_subject(self) -> None:
        initial = frame(subject=(30, 20, 120, 60))
        reframed = frame(subject=(30, 20, 70, 60))
        _, quality, attempts = asyncio.run(render._retry_view(
            "front", lambda options, attempt: self.capture_frame("front", reframed if options else initial)))

class ParallelRetry(unittest.TestCase):
    def test_a_view_retries_while_another_view_is_capturing(self) -> None:
        async def exercise() -> None:
            in_flight = peak_in_flight = 0
            calls: list[tuple[str, dict]] = []

            async def capture(name: str, options: dict) -> dict:
                nonlocal in_flight, peak_in_flight
                in_flight += 1
                peak_in_flight = max(peak_in_flight, in_flight)
                calls.append((name, options))
                await asyncio.sleep(0.001)
                in_flight -= 1
                rendered = frame() if name == "front" and len([call for call in calls if call[0] == name]) == 1 else frame(**GOOD)
                return RetryLadder.capture_frame(name, rendered)

            front, iso = await asyncio.gather(
                render._retry_view("front", lambda options, attempt: capture("front", options)),
                render._retry_view("iso", lambda options, attempt: capture("iso", options)),
            )
            self.assertEqual([row["strategy"] for row in front[2]], ["original", "blank-retry"])
            self.assertTrue(front[1].passed)
            self.assertTrue(iso[1].passed)
            self.assertGreater(peak_in_flight, 1)

        asyncio.run(exercise())

class AttemptSeed(unittest.TestCase):
    def test_retry_attempts_receive_stable_incrementing_seeds(self) -> None:
        seeds: list[int] = []
        rendered = frame()

        def capture(options: dict, attempt: int) -> dict:
            seeds.append(attempt)
            return RetryLadder.capture_frame("iso", rendered if attempt == 0 else frame(**GOOD))

        _, quality, attempts = asyncio.run(render._retry_view("iso", capture))
        self.assertEqual(seeds, [0, 1])
        self.assertTrue(quality.passed)
        self.assertEqual([row["strategy"] for row in attempts], ["original", "blank-retry"])



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
        return render.explode_offsets(self.joints, "A", {}, {}, self.bboxes, toward)

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
        out = render.explode_offsets(self.joints, "A", {"B": quarter}, {"B": quarter}, self.bboxes, (1.0, 0.0, 0.0))
        self.assertAlmostEqual(out["P"][0] - out["B"][0], render.FIXED_GAP * 20)

    def test_a_rest_placement_moves_the_centre_but_not_the_joint_frame(self) -> None:
        """A part-local child placed 100 mm along +X: its centre follows T = D P, its joint axis D alone."""
        shifted = [[1.0, 0.0, 0.0, 100.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]]
        local = {**self.bboxes, "C": {"min": [0, -5, 5], "max": [100, 5, 15], "size": [100, 10, 10]}}
        out = render.explode_offsets(self.joints, "A", {}, {"C": shifted}, local, (0.0, -1.0, 0.5))
        self.assertEqual(out, self.offsets())  # same posed geometry as the in-place C

    def test_glb_frame_conversion(self) -> None:
        self.assertEqual(render.to_glb((1.0, 2.0, 3.0), 0.001), [0.001, 0.003, -0.002])


class Cache(unittest.TestCase):
    key = {"source_sha256": "a", "materials_sha256": "b", "renderer_sha256": "c", "image": "1600x1200",
           "parity": parity.cache_key()}

    def write(self, hw: Path, status: str = "pass") -> Path:
        params = {"V": "v1", "S": "assembly"}
        version = hw / "versions" / "v1"
        (version / "record").mkdir(parents=True)
        (version / "manifest.json").write_text("version manifest\n", encoding="utf-8")
        out = render.layout.staging(hw, "bundle.renders")
        png = b"\x89PNG fake"
        (out / "iso.png").write_bytes(png)
        render_json = {"status": status, "cache_key": self.key,
                       "views": {"iso": {"png": "iso.png", "sha256": render.sha256(png),
                                          "quality": {"status": status, "failures": [], "warnings": []},
                                          "retry": {"strategy": "original", "attempts": []}}}}
        (out / "render.json").write_text(json.dumps(render_json), encoding="utf-8")
        return render.layout.publish(hw, "bundle.renders", params, out,
                                     recipe={"views": ["iso"], "cache_key": self.key},
                                     producer="test", status=status).path

    def test_hit_only_on_a_passing_manifest_with_the_same_key_and_intact_pngs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            hw = Path(tmp) / "hw"
            out = hw / "renders" / "v1" / "assembly"
            self.assertIsNone(render.cache_hit(out, self.key, ["iso"]))
            out = self.write(hw)
            self.assertIsNotNone(render.cache_hit(out, self.key, ["iso"]))
            self.assertIsNone(render.cache_hit(out, {**self.key, "materials_sha256": "changed"}, ["iso"]))
            self.assertIsNone(render.cache_hit(out, self.key, ["iso", "front"]))
            (out / "iso.png").write_bytes(b"edited")
            self.assertIsNone(render.cache_hit(out, self.key, ["iso"]))

    def test_a_failed_render_is_never_a_cache_hit(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            hw = Path(tmp) / "hw"
            out = self.write(hw, status="fail")
            self.assertIsNone(render.cache_hit(out, self.key, ["iso"]))

    def test_warning_manifest_is_cacheable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            hw = Path(tmp) / "hw"
            out = self.write(hw, status="warn")
            self.assertIsNotNone(render.cache_hit(out, self.key, ["iso"]))

class CacheKey(unittest.TestCase):
    """build_scene's key against a cad-model version of the template record (no real GLB)."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.hw = Path(self.tmp.name) / "hw"
        shutil.copytree(TEMPLATE_HW, self.hw)
        pns = sorted(p.name for p in (self.hw / "parts").iterdir())
        folder = self.hw / "versions" / "v1"
        folder.mkdir(parents=True)
        (folder / "assembly.step").write_text("", encoding="utf-8")
        (folder / "assembly.glb").write_bytes(b"glTF v1")
        part_occurrences = {pn: {"PN": pn, "node_indices": [i]} for i, pn in enumerate(pns)}
        self.write(folder / "part-map.json", {"schema_version": 2,
                                              "parts": {pn: {"node_indices": [i]} for i, pn in enumerate(pns)},
                                              "occurrences": part_occurrences})
        self.write(folder / "metrics.json", {"parts": {pn: {"bbox_mm": {"min": [0, 0, 0], "max": [10, 10, 10],
                                                                        "size": [10, 10, 10]}} for pn in pns}})
        record = folder / "record"
        (record / "parts").mkdir(parents=True)
        shutil.copyfile(self.hw / "assembly.yaml", record / "assembly.yaml")
        for pn in pns:
            (record / "parts" / pn).mkdir(parents=True, exist_ok=True)
            shutil.copyfile(self.hw / "parts" / pn / "part.yaml", record / "parts" / pn / "part.yaml")
        self.seal(folder, pns)
        self.write(self.hw / "versions" / "latest.json", {"label": "v1"})

    @staticmethod
    def seal(folder: Path, pns: list[str]) -> None:
        files = {p.relative_to(folder).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                 for p in folder.rglob("*") if p.is_file() and p.name != "manifest.json"}
        record = {name: digest for name, digest in files.items() if name.startswith("record/")}
        records = {pn: {"PN": pn, "ref": pn, "rest": IDENTITY, "group": None} for pn in pns}
        CacheKey.write(folder / "manifest.json", {"schema_version": 2, "label": "v1", "files": files,
                                                   "record": record, "manufacturing": {},
                                                   "ground": pns[0], "occurrences": records, "joints": [],
                                                   "pose": {"transforms": {pn: IDENTITY for pn in pns},
                                                           "motions": {pn: IDENTITY for pn in pns}},
                                                   "assembly_yaml_sha256": files["record/assembly.yaml"]})
    @staticmethod
    def refresh(folder: Path) -> None:
        manifest_path = folder / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        files = {p.relative_to(folder).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                 for p in folder.rglob("*") if p.is_file() and p != manifest_path}
        manifest["files"] = files
        manifest["record"] = {name: digest for name, digest in files.items() if name.startswith("record/")}
        manifest["assembly_yaml_sha256"] = files["record/assembly.yaml"]
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    @staticmethod
    def write(path: Path, data: dict) -> None:
        path.write_text(json.dumps(data), encoding="utf-8")

    def key(self) -> dict:
        version = render.resolve_version(self.hw, "latest")
        return render.build_scene(self.hw, version, ["iso", "exploded"], (800, 600), materials.MaterialTable.load())[2]["key"]

    def test_every_input_the_scene_reads_changes_the_key(self) -> None:
        folder = self.hw / "versions" / "v1"
        def edit_json(name: str, change) -> None:
            path = folder / name
            data = json.loads(path.read_text(encoding="utf-8"))
            change(data)
            self.write(path, data)
            self.refresh(folder)

        part_yaml = folder / "record" / "parts" / "LMP-0002" / "part.yaml"
        def edit_part_material() -> None:
            part_yaml.write_text(re.sub(r"(?m)^material:.*$", "material: PETG",
                                        part_yaml.read_text(encoding="utf-8")), encoding="utf-8")
            self.refresh(folder)

        def edit_assembly() -> None:
            path = folder / "record" / "assembly.yaml"
            path.write_text(path.read_text(encoding="utf-8") + "\n# edited\n", encoding="utf-8")
            self.refresh(folder)

        edits = {
            "part-map occurrences": lambda: edit_json("part-map.json", lambda d: d["occurrences"]["LMP-0001"].update(node_indices=[9])),
            "part map": lambda: edit_json("part-map.json", lambda d: d["parts"]["LMP-0002"].update(node_indices=[9])),
            "manifest pose": lambda: edit_json("manifest.json", lambda d: d["pose"]["transforms"]["LMP-0002"][0].__setitem__(3, 5.0)),
            "metrics bbox": lambda: edit_json("metrics.json", lambda d: d["parts"]["LMP-0003"]["bbox_mm"].update(size=[10, 10, 99])),
            "assembly.yaml": edit_assembly,
            "part material": edit_part_material,
        }
        before = self.key()
        for name, edit in edits.items():
            with self.subTest(input=name):
                edit()
                after = self.key()
                self.assertNotEqual(after, before)
                before = after

    def test_parity_policy_is_part_of_the_render_cache_key(self) -> None:
        key = self.key()
        self.assertIn("parity", key)
        self.assertEqual(key["parity"]["version"], parity.POLICY_VERSION)

    def test_a_file_the_render_does_not_read_keeps_the_key(self) -> None:
        before = self.key()
        (self.hw / "bom.csv").write_text("edited\n", encoding="utf-8")
        self.assertEqual(self.key(), before)

    def test_a_malformed_latest_json_is_an_infra_error(self) -> None:
        latest = self.hw / "versions" / "latest.json"
        original = latest.read_text(encoding="utf-8")
        latest.write_text('{"glb": "versions/v1/assembly.glb"}', encoding="utf-8")
        with self.assertRaisesRegex(render.InfraError, "label"):
            render.resolve_version(self.hw, "latest")
        latest.write_text(original, encoding="utf-8")
        self.assertEqual(render.resolve_version(self.hw, "v1").label, "v1")


class Views(unittest.TestCase):
    def test_closeup_and_part_views_require_existing_parts(self) -> None:
        singletons = {"LMP-0004": "LMP-0004", "LMP-0005": "LMP-0005"}
        self.assertEqual(render.parse_views(["iso", "closeup-LMP-0004", "part-LMP-0005", "iso"], singletons),
                         ["iso", "closeup-LMP-0004", "part-LMP-0005"])
        self.assertEqual(render.view_kind("part-LMP-0005"), "part")
        for token in ("closeup-LMP-0009", "part-LMP-0009", "top", "closeup-@ring-1"):
            with self.subTest(token=token), self.assertRaises(render.InfraError):
                render.parse_views([token], {"LMP-0004": "LMP-0004"})

    def test_a_repeated_part_needs_an_occurrence_reference(self) -> None:
        rings = {"LMP-0004": "LMP-0004", "ring-1": "LMP-0011", "ring-2": "LMP-0011"}
        with self.assertRaisesRegex(render.InfraError, "closeup-@ring-1, closeup-@ring-2"):
            render.parse_views(["closeup-LMP-0011"], rings)
        self.assertEqual(render.view_subject("closeup-@ring-2", rings), "ring-2")
        self.assertEqual(render.view_subject("part-LMP-0004", rings), "LMP-0004")


class OccurrenceScene(unittest.TestCase):
    """build_scene on a schema_version 2 version with one PN placed twice (no real GLB)."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.hw = Path(self.tmp.name) / "hw"
        shutil.copytree(TEMPLATE_HW, self.hw)
        folder = self.hw / "versions" / "v1"
        folder.mkdir(parents=True)
        (folder / "assembly.step").write_text("", encoding="utf-8")
        (folder / "assembly.glb").write_bytes(b"glTF")
        moved = [[1.0, 0.0, 0.0, 50.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]]
        occurrences = {"LMP-0001": ("LMP-0001", "LMP-0001", IDENTITY), "ring-a": ("LMP-0011", "@ring-a", IDENTITY),
                       "ring-b": ("LMP-0011", "@ring-b", moved)}
        box = {"bbox_mm": {"min": [0, 0, 0], "max": [10, 10, 1], "size": [10, 10, 1]}}
        write = CacheKey.write
        write(folder / "part-map.json", {"schema_version": 2, "parts": {
            "LMP-0001": {"occurrences": ["LMP-0001"], "node_indices": [1]},
            "LMP-0011": {"occurrences": ["ring-a", "ring-b"], "node_indices": [2, 3]}},
            "occurrences": {oid: {"PN": pn, "node_indices": [i + 1]} for i, (oid, (pn, _, _)) in enumerate(occurrences.items())}})
        write(folder / "metrics.json", {"schema_version": 2, "parts": {"LMP-0001": box, "LMP-0011": box}})
        write(folder / "manifest.json", {
            "schema_version": 2, "ground": "LMP-0001",
            "occurrences": {oid: {"PN": pn, "ref": ref, "group": "g", "rest": rows} for oid, (pn, ref, rows) in occurrences.items()},
            "pose": {"transforms": {oid: rows for oid, (_, _, rows) in occurrences.items()},
                     "motions": {oid: IDENTITY for oid in occurrences}},
            "joints": [{"id": f"J-00{n}", "type": "fixed", "parent": "LMP-0001", "child": oid, "axis": [0, 0, 1],
                        "origin": [0, 0, 0]} for n, oid in enumerate(("ring-a", "ring-b"), start=1)]})
        for pn in ("LMP-0001", "LMP-0011"):
            (folder / "record" / "parts" / pn).mkdir(parents=True)
            shutil.copyfile(self.hw / "parts" / pn / "part.yaml", folder / "record" / "parts" / pn / "part.yaml")
        (folder / "record" / "assembly.yaml").write_text("joints: []\n", encoding="utf-8")
        files = {p.relative_to(folder).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                 for p in folder.rglob("*") if p.is_file() and p.name != "manifest.json"}
        data = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
        data["files"] = files
        data["record"] = {name: digest for name, digest in files.items() if name.startswith("record/")}
        data["manufacturing"] = {}
        data["assembly_yaml_sha256"] = files["record/assembly.yaml"]
        write(folder / "manifest.json", data)
        write(self.hw / "versions" / "latest.json", {"label": "v1"})

    def test_each_occurrence_is_its_own_scene_part_with_its_pn_material(self) -> None:
        version = render.resolve_version(self.hw, "latest")
        scene, by_pn, _ = render.build_scene(self.hw, version, ["exploded", "closeup-@ring-b"], (800, 600),
                                             materials.MaterialTable.load())
        parts = {p["id"]: p for p in scene["parts"]}
        self.assertEqual(sorted(parts), ["LMP-0001", "ring-a", "ring-b"])
        self.assertEqual((parts["ring-a"]["node_indices"], parts["ring-b"]["node_indices"]), ([2], [3]))
        self.assertEqual(parts["ring-a"]["material"], parts["ring-b"]["material"])
        self.assertEqual(sorted(by_pn), ["LMP-0001", "LMP-0011"])
        self.assertEqual(sorted(scene["explode"]), ["LMP-0001", "ring-a", "ring-b"])
        self.assertEqual(next(v for v in scene["views"] if v["name"] == "closeup-@ring-b")["subject"], ["ring-b"])

    def test_a_newer_schema_is_refused(self) -> None:
        path = self.hw / "versions" / "v1" / "manifest.json"
        CacheKey.write(path, {**json.loads(path.read_text(encoding="utf-8")), "schema_version": 3})
        with self.assertRaisesRegex(render.InfraError, "schema_version 3"):
            render.resolve_version(self.hw, "latest")
    def test_existing_scratch_output_is_never_overwritten(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            hw = Path(tmp) / "hw"
            scratch = Path(tmp) / ".cad-work" / "render"
            scratch.mkdir(parents=True)
            args = argparse.Namespace(hw=hw, version="v1", views=["iso"], size="800x600", jobs=1,
                                      subject="assembly", out_dir=scratch, replace=False, cache_dir=None)
            with mock.patch.object(render, "resolve_version") as resolve:
                with self.assertRaisesRegex(render.InfraError, "refusing to overwrite"):
                    render.run(args)
                resolve.assert_not_called()


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

    def test_jobs_outside_supported_range_are_rejected(self) -> None:
        result = self.run_cli(str(TEMPLATE_HW), "--jobs", "9")
        self.assertEqual(result.returncode, 2)
        self.assertIn("--jobs must be between 1 and 8", json.loads(result.stdout)["error"])


if __name__ == "__main__":
    unittest.main()
