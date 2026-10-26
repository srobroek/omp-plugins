#!/usr/bin/env python3
"""cad-viewer command-layer tests: argument parsing, version and part-map loading, check findings,
and joint-limit rejection for `animate`. No browser, no OCP, no viewer process.

Run: python3 -m unittest discover -s cad/skills/cad-viewer/tests -v  (needs PyYAML)
"""

from __future__ import annotations

import argparse
import contextlib
import importlib.util
import io
import json
import math
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
SCRIPTS = SKILL / "scripts"
TEMPLATE_HW = SKILL.parent / "cad-record" / "assets" / "project-template" / "hw"
sys.path.insert(0, str(SCRIPTS))

from cadviewer import LimitError, ViewerError, motion, record  # noqa: E402


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


viewer = load("cad_viewer_cli", SCRIPTS / "viewer.py")
PNS = ("LMP-0001", "LMP-0002", "LMP-0003", "LMP-0004", "LMP-0005", "LMP-0006", "LMP-0007")


def parse(*argv: str) -> argparse.Namespace:
    with contextlib.redirect_stderr(io.StringIO()):
        return viewer.build_parser().parse_args(list(argv))


def make_version(hw: Path, label: str, products: dict[str, str] | None = None, latest: bool = True) -> None:
    """A cad-model version folder with the files the viewer reads (no STEP or GLB content)."""
    chain = motion.load_chain(hw)
    rows = {pn: rigid.rows() for pn, rigid in chain.transforms(chain.complete({})).items()}
    titles = {pn: record.read_yaml(hw / "parts" / pn / "part.yaml")["title"] for pn in PNS}
    products = products or {pn: f"{pn} {titles[pn]}" for pn in PNS}
    folder = hw / "versions" / label
    (folder / "parts").mkdir(parents=True)
    for name in ("assembly.step", "assembly.glb"):
        (folder / name).write_text("", encoding="utf-8")
    (folder / "part-map.json").write_text(json.dumps({"glb": "assembly.glb", "parts": {
        pn: {"product": name, "nodes": [name], "node_indices": [i], "meshes": [name]}
        for i, (pn, name) in enumerate(products.items(), start=1)}}), encoding="utf-8")
    (folder / "metrics.json").write_text(json.dumps({"label": label, "parts": {
        pn: {"volume_mm3": 1000.0 * i, "mass_g": 2.7 * i, "mass_target_g": None,
             "bbox_mm": {"min": [0, 0, 0], "max": [10 * i, 5, 5], "size": [10 * i, 5, 5]}}
        for i, pn in enumerate(PNS, start=1)}, "totals": {"volume_mm3": 28000.0, "mass_g": 75.6}}),
        encoding="utf-8")
    (folder / "manifest.json").write_text(json.dumps({"label": label, "product_id": "lamp-arm",
                                                      "pose": {"transforms": rows}}), encoding="utf-8")
    if latest:
        (hw / "versions" / "latest.json").write_text(json.dumps({
            "label": label, "assembly_step": f"versions/{label}/assembly.step",
            "parts": {pn: f"versions/{label}/parts/{pn}.step" for pn in PNS}, "glb": f"versions/{label}/assembly.glb",
            "metrics": f"versions/{label}/metrics.json", "part_map": f"versions/{label}/part-map.json",
            "manifest": f"versions/{label}/manifest.json"}), encoding="utf-8")


class Fixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="cad-viewer-test-"))
        self.hw = self.tmp / "hw"
        shutil.copytree(TEMPLATE_HW, self.hw)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)


class ArgumentParsing(unittest.TestCase):
    def test_show_defaults_to_latest(self) -> None:
        args = parse("show", "hw")
        self.assertEqual((args.command, args.version, args.check), ("show", "latest", None))

    def test_compare_needs_hw(self) -> None:
        with self.assertRaises(SystemExit):
            parse("compare", "v1", "v2")
        args = parse("compare", "v1", "v2", "--hw", "hw")
        self.assertEqual((args.a, args.b), ("v1", "v2"))

    def test_capture_views(self) -> None:
        for view in ("iso", "front", "side", "top", "exploded", "section", "current", "isolate:LMP-0002"):
            self.assertEqual(parse("capture", "--view", view, "--out", "x.png").view, view)
        for bad in ("isolate:", "perspective", ""):
            with self.assertRaises(SystemExit, msg=bad):
                parse("capture", "--view", bad, "--out", "x.png")
        with self.assertRaises(SystemExit):
            parse("capture", "--view", "iso")

    def test_animate_arguments(self) -> None:
        args = parse("animate", "--joint", "J-002", "--from", "-120", "--to", "0", "--at", "0.5")
        self.assertEqual((args.joint, args.start, args.end, args.at, args.steps), ("J-002", -120.0, 0.0, 0.5, 13))
        for bad in ("1.5", "-0.1"):
            with self.assertRaises(SystemExit):
                parse("animate", "--joint", "J-002", "--from", "0", "--to", "1", "--at", bad)
        with self.assertRaises(SystemExit):
            parse("animate", "--joint", "J-002", "--from", "0")

    def test_request_bodies(self) -> None:
        method, route, body = viewer.request_body(parse("show", "hw", "--version", "v2", "--check", "c.json"))
        self.assertEqual((method, route, body["version"]), ("POST", "/api/show", "v2"))
        self.assertTrue(Path(body["hw"]).is_absolute() and Path(body["check"]).is_absolute())
        _, route, body = viewer.request_body(parse("capture", "--view", "section", "--joint", "J-002", "--out", "s.png"))
        self.assertEqual((route, body["view"], body["joint"], body["refit"]), ("/api/capture", "section", "J-002", None))
        _, route, body = viewer.request_body(parse("parts", "iso", "arm_sub"))
        self.assertEqual((route, body), ("/api/parts", {"action": "iso", "target": "arm_sub"}))
        with self.assertRaises(ViewerError):
            viewer.request_body(parse("parts", "hide"))
        with self.assertRaises(ViewerError):
            viewer.request_body(parse("animate", "--joint", "J-002", "--from", "0", "--to", "-1", "--steps", "1"))

    def test_commands_without_a_host_exit_2(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()) as out:
            previous = viewer.session.os.environ.get("CAD_VIEWER_SESSION")
            viewer.session.os.environ["CAD_VIEWER_SESSION"] = str(Path(tmp) / "none.json")
            try:
                code = viewer.main(["show", "hw"])
            finally:
                if previous is None:
                    del viewer.session.os.environ["CAD_VIEWER_SESSION"]
                else:
                    viewer.session.os.environ["CAD_VIEWER_SESSION"] = previous
        self.assertEqual(code, 2)
        self.assertIn("no running viewer", json.loads(out.getvalue())["error"])


class PartMapLoading(Fixture):
    def test_part_map_products_keyed_by_pn(self) -> None:
        make_version(self.hw, "v1")
        products = record.load_part_map(self.hw / "versions" / "v1" / "part-map.json")
        self.assertEqual(products["LMP-0002"], "LMP-0002 Lower link")
        self.assertEqual(sorted(products), list(PNS))

    def test_product_not_starting_with_pn_is_rejected(self) -> None:
        make_version(self.hw, "v1", products={"LMP-0002": "LMP-0003 Upper link"})
        with self.assertRaisesRegex(ViewerError, "does not start with LMP-0002"):
            record.load_part_map(self.hw / "versions" / "v1" / "part-map.json")

    def test_empty_or_malformed_part_map_is_rejected(self) -> None:
        path = self.tmp / "part-map.json"
        for data in ({}, {"parts": {}}, {"parts": {"LMP-0001": {"nodes": []}}}, []):
            path.write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaises(ViewerError, msg=data):
                record.load_part_map(path)

    def test_version_tree_paths_groups_and_colours(self) -> None:
        make_version(self.hw, "v1")
        version = record.load_version(self.hw, "latest")
        self.assertEqual((version.label, version.product_id), ("v1", "lamp-arm"))
        self.assertEqual([g.id for g in version.groups], ["base_sub", "arm_sub"])
        lower = version.part("LMP-0002")
        self.assertEqual(lower.path, "/lamp-arm/arm_sub/LMP-0002 Lower link")
        self.assertEqual(lower.colour, record.MATERIAL_COLOURS[0][1])  # aluminium
        self.assertEqual(version.part("LMP-0001").colour, record.PROCESS_COLOURS["fdm"])
        self.assertEqual(version.targets("base_sub"), ("LMP-0001",))
        with self.assertRaises(ViewerError):
            version.targets("LMP-9999")

    def test_older_label_resolves_through_the_documented_layout(self) -> None:
        make_version(self.hw, "v1", latest=False)
        make_version(self.hw, "v2")
        self.assertEqual(record.load_version(self.hw, "v1").label, "v1")
        with self.assertRaisesRegex(ViewerError, "missing"):
            record.load_version(self.hw, "v7")
        with self.assertRaisesRegex(ViewerError, "latest or vN"):
            record.load_version(self.hw, "../v1")

    def test_no_build_yet(self) -> None:
        with self.assertRaisesRegex(ViewerError, "cad-model run"):
            record.load_version(self.hw, "latest")


class CheckFindings(Fixture):
    CHECK = {
        "status": "fail", "label": "v1", "pose": "nominal", "blocking_failures": ["interference"], "warnings": [],
        "checks": {
            "connection": {"status": "pass", "blocking": True, "parts": {
                "LMP-0001": {"status": "floating", "nearest": "LMP-0005", "distance_mm": 0.108,
                             "joint_connected": True, "ok": True},
                "LMP-0004": {"status": "disconnected", "nearest": "LMP-0007", "distance_mm": 3.2,
                             "joint_connected": False, "ok": False},
                "LMP-0002": {"status": "touching", "nearest": "LMP-0006", "distance_mm": 0.0, "ok": True}}},
            "interference": {"status": "fail", "blocking": True, "pairs": [
                {"pair": ["LMP-0002", "LMP-0003"], "interference_mm3": 4.5, "ok": False}], "joint_pairs": []},
            "slivers_tolerances": {"status": "warn", "blocking": False, "parts": {
                "LMP-0003": {"sliver_faces": 2, "max_tolerance_mm": 0.02, "ok": False}}},
        }}

    def test_connection_and_pair_findings_per_part(self) -> None:
        found = record.part_findings(self.CHECK)
        self.assertEqual(found["LMP-0001"], [{"check": "connection", "severity": "warn",
                                              "message": "touches no other part; 0.108 mm from LMP-0005 (joint-connected)"}])
        self.assertEqual(found["LMP-0004"][0]["severity"], "fail")
        self.assertIn("interferes with LMP-0003: 4.500 mm3", [f["message"] for f in found["LMP-0002"]])
        self.assertEqual(found["LMP-0003"][-1]["severity"], "warn")
        self.assertNotIn("connection", [f["check"] for f in found.get("LMP-0002", [])])

    def test_panel_rejects_a_check_for_another_version(self) -> None:
        make_version(self.hw, "v2")
        version = record.load_version(self.hw)
        with self.assertRaisesRegex(ViewerError, "is for v1, not v2"):
            record.panel_model(version, self.CHECK)
        panel = record.panel_model(version, {**self.CHECK, "label": "v2"})
        self.assertEqual(panel["totals"]["bbox_mm"]["size"], [70, 5, 5])
        self.assertEqual(panel["check"]["blocking_failures"], ["interference"])


class AnimateLimits(Fixture):
    def setUp(self) -> None:
        super().setUp()
        self.chain = motion.load_chain(self.hw)
        self.shown = self.chain.transforms(self.chain.complete({}))

    def test_values_outside_the_joint_limits_are_rejected(self) -> None:
        for start, end in ((-130.0, 0.0), (-120.0, 5.0)):
            with self.assertRaises(LimitError) as caught:
                motion.plan_animation(self.chain, self.shown, "J-002", start, end)
            finding = caught.exception.findings[0]
            self.assertEqual((finding["check"], finding["joint"], finding["min"], finding["max"]),
                             ("joint_limit", "J-002", -120.0, 0.0))

    def test_fixed_unknown_and_degenerate_requests(self) -> None:
        with self.assertRaisesRegex(ViewerError, "fixed joint"):
            motion.plan_animation(self.chain, self.shown, "J-004", 0.0, 0.0)
        with self.assertRaises(ViewerError):
            motion.plan_animation(self.chain, self.shown, "J-099", 0.0, 1.0)
        with self.assertRaisesRegex(ViewerError, "steps"):
            motion.plan_animation(self.chain, self.shown, "J-002", -90.0, 0.0, steps=1)
        with self.assertRaises(ViewerError):
            motion.plan_animation(self.chain, self.shown, "J-002", math.nan, 0.0)

    def test_tracks_move_only_the_parts_beyond_the_joint(self) -> None:
        plan = motion.plan_animation(self.chain, self.shown, "J-002", -120.0, 0.0, steps=5)
        self.assertEqual(sorted(t.pn for t in plan.tracks), ["LMP-0003", "LMP-0004", "LMP-0007"])
        self.assertEqual(plan.values, (-120.0, -90.0, -60.0, -30.0, 0.0))
        upper = next(t for t in plan.tracks if t.pn == "LMP-0003")
        x, y, z, w = upper.quaternions[3]  # -30 deg is the nominal pose: no motion from the shown pose
        self.assertAlmostEqual(w, 1.0, places=9)
        self.assertAlmostEqual(math.degrees(2 * math.acos(min(1.0, abs(upper.quaternions[0][3])))), 90.0, places=6)
        self.assertEqual(plan.value_at(0.5), -60.0)

    def test_section_plane_runs_through_the_elbow_axis(self) -> None:
        plane = motion.section_plane(self.chain, self.shown, "J-002")
        self.assertEqual([round(v, 9) for v in plane["point"]], [160.0, 0.0, 40.0])
        self.assertEqual([round(abs(v), 9) for v in plane["normal"]], [1.0, 0.0, 0.0])
        self.assertAlmostEqual(sum(a * b for a, b in zip(plane["normal"], plane["axis"])), 0.0)


if __name__ == "__main__":
    unittest.main()
