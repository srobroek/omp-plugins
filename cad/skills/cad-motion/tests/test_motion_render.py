#!/usr/bin/env python3
"""cad-motion motion plans and motion renders: plan validation and coverage, the animated GLB, the
FreeCAD cross-check's spec and comparison, the MP4 timing check, and the render path end to end.

Run: python3 -m unittest discover -s cad/skills/cad-motion/tests -p test_motion_render.py -v
The plan, coverage, GLB and cross-check tests need no kernel. The MP4 test needs `uv` (imageio-ffmpeg
from motion.py's header); the end-to-end render also needs Playwright Chromium; the FreeCAD
cross-check needs `uv` and freecadcmd. Each skips without its tool.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zlib
from pathlib import Path
from typing import Any

import yaml

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"
SKILLS = HERE.parents[1]
LAMP_HW = HERE.parents[2] / "examples" / "lamp-arm" / "hw"
sys.path.insert(0, str(HERE / "fixtures"))
sys.path.insert(0, str(SKILLS / "cad-model" / "scripts"))
import motion_version  # noqa: E402 - the kernel-free sealed version
import v6_record  # noqa: E402 - the kernel-free V6-like record
from cadmodel import scriptenv  # noqa: E402


def load(name: str, path: Path) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


# freecad_assembly.py loads pose.py itself; motion.py then reuses that module, so one MotionError serves both.
freecad_assembly = load("cad_motion_freecad", SCRIPTS / "freecad_assembly.py")
motion = load("cad_motion_motion", SCRIPTS / "motion.py")
pose, plan, motion_glb = motion.pose, motion.plan, motion.motion_glb


def chain_of(hw: Path, manifest: dict[str, Any] | None = None) -> Any:
    assembly = pose.load_assembly(hw)
    joints = [*assembly.joints, *pose.attach_joints((manifest or {}).get("attach") or [], assembly)]
    return pose.build_chain(joints, assembly.occurrences, couplings=assembly.couplings)

def v6_hw(root: Path) -> Path:
    hw = root / "v6" / "hw"
    (hw / "parts").mkdir(parents=True)
    (hw / "assembly.yaml").write_text(yaml.safe_dump(v6_record.record()), encoding="utf-8")
    for pn, (title, frame) in v6_record.PARTS.items():
        (hw / "parts" / pn).mkdir()
        (hw / "parts" / pn / "part.yaml").write_text(f"PN: {pn}\ntitle: {title}\nmodel_frame: {frame}\n", encoding="utf-8")
    return hw


def run(*argv: str) -> tuple[int, Any]:
    """motion.py main in this process: (exit code, its stdout as JSON, or as text when not JSON)."""
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
        code = motion.main([str(a) for a in argv])
    try:
        return code, json.loads(out.getvalue())
    except json.JSONDecodeError:
        return code, out.getvalue()


def chromium_installed() -> bool:
    roots = [os.environ.get("PLAYWRIGHT_BROWSERS_PATH"), Path.home() / "Library" / "Caches" / "ms-playwright",
             Path.home() / ".cache" / "ms-playwright"]
    return any(root and Path(root).is_dir() and any(Path(root).glob("chromium*")) for root in roots)


class Fixture(unittest.TestCase):
    """A temp project with the sealed motion_version arm."""

    j3_limit = 30.0

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.hw = self.tmp / "project" / "hw"
        self.version = motion_version.write(self.hw, pose, self.j3_limit)

    def case(self, name: str, document: dict[str, Any]) -> None:
        folder = self.hw / "motion" / "cases" / name
        folder.mkdir(parents=True)
        (folder / "plan.yaml").write_text(yaml.safe_dump(document, sort_keys=False), encoding="utf-8")


# --------------------------------------------------------------------------- plans


class PlanValidation(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.v6 = chain_of(v6_hw(self.tmp))
        self.lamp = chain_of(LAMP_HW)

    def problems(self, chain: Any, document: dict[str, Any]) -> list[str]:
        return plan.validate(chain, {"schema": 1, **document}, document.get("case", "probe"))

    def test_the_v6_default_plan_is_one_crank_cycle_of_145_frames(self) -> None:
        effective = plan.prepare(self.v6, plan.default_plan(self.v6), "default")
        frames = plan.expand(self.v6, effective)
        report = plan.coverage(self.v6, effective, frames)
        self.assertEqual([s["id"] for s in effective["segments"]], ["j-001-to-max"])
        self.assertEqual(len(frames), 145)
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["unmoved_derived"], [])
        derived = {row["joint"]: row for row in report["derived"]}
        self.assertEqual(derived["J-031"]["visited"], [0.0, 360.0])
        self.assertEqual(derived["J-013"]["root"], "J-001")
class PlanLongTravel(PlanValidation):
    def test_generated_default_plan_scales_step_to_fit_frame_cap(self) -> None:
        data = {"subassemblies": [{"id": "linear", "parts": ["TST-0010", "TST-0011"]}],
                "joints": [{"id": "J-100", "type": "prismatic", "parent": "TST-0010", "child": "TST-0011",
                            "axis": [1, 0, 0], "origin": [0, 0, 0], "min": 0, "max": 1700, "nominal": 0}]}
        inventory = pose.assembly_data.normalize(data, {})
        joint = pose.make_joint(data["joints"][0])
        chain = pose.build_chain([joint], inventory.occurrences)
        effective = plan.prepare(chain, plan.default_plan(chain), "default")
        frames = plan.expand(chain, effective)
        report = plan.coverage(chain, effective, frames)
        self.assertEqual(effective["max_step"]["mm"], plan.DEFAULT_STEP["mm"])
        self.assertLessEqual(len(frames), plan.MAX_FRAMES)
        self.assertEqual((frames[0].settings["J-100"], frames[-1].settings["J-100"]), (0.0, 0.0))
        self.assertEqual(report["status"], "pass")

    def test_manifest_attachments_are_in_the_motion_context_and_crosscheck_command(self) -> None:
        fixture = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, fixture, ignore_errors=True)
        hw = fixture / "project" / "hw"
        folder = motion_version.write(hw, pose)
        ctx = motion.Context(hw, "v1")
        self.assertEqual(ctx.attach, ["TST-0005=TST-0001"])
        self.assertIn("TST-0005", ctx.chain.ids)
        self.assertIn("attach:TST-0005", {joint.id for joint in ctx.chain.joints})
        command = []
        with mock.patch.object(motion.scriptenv, "script_command", side_effect=lambda *args: command.extend(args) or command), \
                mock.patch.object(motion, "_run_json", return_value=(2, {"error": "expected stop"})) as run_json:
            with self.assertRaisesRegex(pose.MotionError, "gave no result"):
                motion.crosscheck_freecad(ctx, fixture / "frames.json", fixture)
        self.assertIn("--attach", command)
        self.assertIn("TST-0005=TST-0001", command)
        self.assertEqual(run_json.call_args.args[0], command)
        self.assertEqual(json.loads((folder / "manifest.json").read_text(encoding="utf-8"))["attach"], ctx.attach)

    def test_the_lamp_default_plan_covers_three_drivers_and_a_combined_pose(self) -> None:
        effective = plan.prepare(self.lamp, plan.default_plan(self.lamp), "default")
        frames = plan.expand(self.lamp, effective)
        report = plan.coverage(self.lamp, effective, frames)
        self.assertEqual((len(effective["segments"]), len(frames), report["status"]), (12, 179, "pass"))
        self.assertEqual({row["joint"]: row["visited"] for row in report["independent"]},
                         {"J-001": [-10.0, 80.0], "J-002": [-120.0, 0.0], "J-003": [-45.0, 45.0]})
        self.assertTrue(report["combined_pose_present"])

    def test_a_coupled_target_is_refused_and_names_its_driver(self) -> None:
        problems = self.problems(self.v6, {"segments": [{"id": "piston", "to": {"J-013": -5}}]})
        self.assertEqual(problems, ["segments[0] (piston): J-013 follows J-001 (slider_crank cylinder-3 displacement); "
                                    "move its driver instead"])

    def test_unknown_fixed_and_out_of_range_targets_are_refused(self) -> None:
        problems = self.problems(self.lamp, {"segments": [{"id": "a", "to": {"J-099": 1}}, {"id": "b", "to": {"J-010": 0}},
                                                          {"id": "c", "to": {"J-002": 30}}]})
        self.assertIn("J-099 is not a joint of this record", problems[0])
        self.assertIn("J-010 is a fixed joint", problems[1])
        self.assertIn("J-002 = 30 deg is outside [-120, 0]", problems[2])

    def test_malformed_plans_list_every_problem(self) -> None:
        problems = self.problems(self.lamp, {
            "fps": 0, "colour": "red", "coverage": "partial",
            "segments": [{"id": "Up", "to": {"J-001": 10}, "easing": "bounce", "camera": "top"},
                         {"id": "hold", "hold_frames": 0, "to": {"J-001": 0}}, {"id": "hold", "to": {"J-001": 5}}]})
        text = "\n".join(problems)
        for expected in ("unknown plan key 'colour'", "fps must be an integer", "partial needs a coverage_reason",
                         "id must be a unique slug", "easing must be one of", "camera must be one of",
                         "hold_frames must be a positive integer", "a hold takes no `to`", "got 'hold'"):
            self.assertIn(expected, text)

    def test_ease_in_out_keeps_every_step_within_max_step(self) -> None:
        document = {"schema": 1, "max_step": {"deg": 4},
                    "segments": [{"id": "swing", "to": {"J-001": 80}, "easing": "ease_in_out"}]}
        frames = plan.expand(self.lamp, plan.prepare(self.lamp, document, "swing"))
        steps = [abs(b.settings["J-001"] - a.settings["J-001"]) for a, b in zip(frames, frames[1:])]
        self.assertLessEqual(max(steps), 4.0 + 1e-9)
        self.assertGreater(len(frames), 80 / 4 + 1)  # pi/2 more frames than a linear move
        self.assertEqual(frames[-1].settings["J-001"], 80.0)

    def test_a_hold_keeps_the_framing_of_the_segment_before_it(self) -> None:
        document = {"schema": 1, "segments": [{"id": "out", "to": {"J-001": 20}, "camera": "side"},
                                              {"id": "wait", "hold_frames": 5},
                                              {"id": "look", "hold_frames": 2, "camera": "front"}]}
        effective = plan.prepare(self.lamp, document, "hold")
        spans = plan.spans(effective, plan.expand(self.lamp, effective))
        self.assertEqual([(s.id, s.start, s.last, s.camera, s.group) for s in spans],
                         [("out", 0, 4, "side", 0), ("wait", 4, 9, "side", 0), ("look", 9, 11, "front", 2)])


class Coverage(Fixture):
    def test_the_default_plan_passes_and_reports_the_derived_joint(self) -> None:
        code, out = run("plan", "--hw", self.hw, "--version", "v1")
        self.assertEqual((code, out["status"], out["case"]), (0, "pass", "default"), out)
        self.assertEqual(out["summary"], "PASS: J-001 [-90,90] J-002 [-60,60]")
        self.assertEqual(out["coverage"]["derived"][0]["law"], "J-003 follows J-002 (linear ratio -0.5 offset 0)")
        self.assertEqual(out["coverage"]["derived"][0]["visited"], [-30.0, 30.0])

    def test_a_plan_that_skips_a_range_fails(self) -> None:
        self.case("swing", {"schema": 1, "segments": [{"id": "low", "to": {"J-001": -90}}, {"id": "high", "to": {"J-001": 90}}]})
        code, out = run("plan", "--hw", self.hw, "--version", "v1", "--case", "swing")
        self.assertEqual((code, out["status"]), (1, "fail"))
        self.assertEqual(out["coverage"]["gaps"], ["J-002 (revolute) visits [0, 0] deg of [-60, 60]; missing [-60, 0], [0, 60]"])

    def test_a_declared_partial_plan_is_flagged(self) -> None:
        self.case("elbow", {"schema": 1, "coverage": "partial", "coverage_reason": "close-up of the elbow",
                            "segments": [{"id": "fold", "to": {"J-002": -60}}, {"id": "open", "to": {"J-002": 60}}]})
        code, out = run("plan", "--hw", self.hw, "--version", "v1", "--case", "elbow")
        self.assertEqual((code, out["status"]), (0, "flagged"))
        self.assertEqual(out["coverage"]["coverage_reason"], "close-up of the elbow")
        self.assertEqual(len(out["coverage"]["gaps"]), 1)

    def test_coupled_unknown_and_out_of_range_plans_exit_2(self) -> None:
        self.case("bad", {"schema": 1, "segments": [{"id": "tip", "to": {"J-003": 5}}, {"id": "x", "to": {"J-099": 1}},
                                                    {"id": "far", "to": {"J-002": 61}}]})
        code, out = run("plan", "--hw", self.hw, "--version", "v1", "--case", "bad")
        self.assertEqual(code, 2)
        self.assertEqual(len(out["problems"]), 3)
        self.assertIn("J-003 follows J-002", out["problems"][0])

    def test_the_default_case_cannot_be_authored(self) -> None:
        self.case("default", {"schema": 1, "segments": [{"id": "a", "to": {"J-001": 1}}]})
        code, out = run("plan", "--hw", self.hw, "--version", "v1")
        self.assertEqual(code, 2)
        self.assertIn("reserved for the generated plan", out["problems"][0])

    def test_print_default_round_trips_into_a_valid_authored_plan(self) -> None:
        code, text = run("plan", "--hw", self.hw, "--version", "v1", "--print-default")
        self.assertEqual(code, 0)
        document = yaml.safe_load(text)
        document["case"] = "tour"
        self.case("tour", document)
        code, out = run("plan", "--hw", self.hw, "--version", "v1", "--case", "tour")
        self.assertEqual((code, out["status"]), (0, "pass"))

    def test_frames_out_is_scratch_only_and_never_overwritten(self) -> None:
        scratch = self.hw.parent / ".cad-work" / "u" / "frames.json"
        code, out = run("plan", "--hw", self.hw, "--version", "v1", "--frames-out", scratch)
        self.assertEqual(code, 0)
        frames = json.loads(scratch.read_text(encoding="utf-8"))
        self.assertEqual((frames["version"], len(frames["frames"])), ("v1", out["coverage"]["frames"]))
        self.assertEqual(run("plan", "--hw", self.hw, "--version", "v1", "--frames-out", scratch)[0], 2)
        self.assertEqual(run("plan", "--hw", self.hw, "--version", "v1", "--frames-out", self.tmp / "out.json")[0], 2)


class LimitExcursion(Fixture):
    j3_limit = 20.0  # J-002 reaches +-60, so J-003 reaches +-30

    def test_a_derived_joint_outside_its_limits_mid_plan_fails(self) -> None:
        code, out = run("plan", "--hw", self.hw, "--version", "v1")
        self.assertEqual((code, out["status"]), (1, "fail"))
        finding = out["coverage"]["limit_findings"][0]
        self.assertEqual((finding["joint"], finding["check"]), ("J-003", "joint_limit"))
        self.assertGreater(finding["frame"], 0)
        code, out = run("render", "--hw", self.hw, "--version", "v1", "--outputs", "glb")
        self.assertEqual(code, 1)
        self.assertFalse((self.hw / "motion").exists(), "a failing plan writes nothing outside .cad-work")


# --------------------------------------------------------------------------- GLB


def _accessor(gltf: dict[str, Any], binary: bytes, index: int) -> list[tuple[float, ...]]:
    accessor = gltf["accessors"][index]
    view = gltf["bufferViews"][accessor["bufferView"]]
    width = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}[accessor["type"]]
    values = struct.unpack_from(f"<{accessor['count'] * width}f", binary, view["byteOffset"] + accessor.get("byteOffset", 0))
    return [tuple(values[i:i + width]) for i in range(0, len(values), width)]


def _slerp(a: tuple[float, ...], b: tuple[float, ...], s: float) -> tuple[float, ...]:
    dot = sum(x * y for x, y in zip(a, b))
    theta = math.acos(min(1.0, abs(dot)))
    if theta < 1e-12:
        return a
    sign = 1.0 if dot >= 0 else -1.0
    k0, k1 = math.sin((1 - s) * theta) / math.sin(theta), sign * math.sin(s * theta) / math.sin(theta)
    return tuple(k0 * x + k1 * y for x, y in zip(a, b))


class AnimatedGlb(Fixture):
    def setUp(self) -> None:
        super().setUp()
        code, self.out = run("render", "--hw", self.hw, "--version", "v1", "--outputs", "glb")
        self.assertEqual(code, 0, self.out)
        self.bundle = Path(self.out["bundle"])
        self.gltf, self.binary = motion_glb.read_glb((self.bundle / "motion.glb").read_bytes())
        self.chain = chain_of(self.version / "record")
        effective = json.loads((self.bundle / "plan.json").read_text(encoding="utf-8"))
        self.frames = plan.expand(self.chain, effective)
        self.fps = effective["fps"]
        self.nodes = {oid: entry["node_indices"][0] for oid, entry in
                      json.loads((self.version / "part-map.json").read_text(encoding="utf-8"))["occurrences"].items()}

    def settings_at(self, t: float) -> dict[str, float]:
        k = min(int(t * self.fps), len(self.frames) - 2)
        s = t * self.fps - k
        a, b = self.frames[k].settings, self.frames[k + 1].settings
        return {key: a[key] + (b[key] - a[key]) * s for key in a}

    def test_the_bundle_holds_the_glb_beside_its_plan_and_coverage(self) -> None:
        self.assertEqual(sorted(p.name for p in self.bundle.iterdir()),
                         ["coverage.json", "manifest.json", "motion.glb", "plan.json", "result.json"])
        self.assertEqual(pose.LAYOUT.verify(self.bundle), [])
        manifest = json.loads((self.bundle / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual((manifest["status"], manifest["producer"]), ("pass", "cad-motion motion.py"))

    def test_the_clip_is_linear_keyed_on_the_part_map_nodes(self) -> None:
        (animation,) = self.gltf["animations"]
        self.assertEqual(animation["name"], "default")
        self.assertTrue(all(s["interpolation"] == "LINEAR" for s in animation["samplers"]))
        inputs = {s["input"] for s in animation["samplers"]}
        self.assertEqual(len(inputs), 1)
        times = self.gltf["accessors"][inputs.pop()]
        self.assertEqual((times["type"], times["componentType"]), ("SCALAR", 5126))
        self.assertIn("min", times)
        self.assertTrue(all(self.gltf["accessors"][s["output"]]["count"] == times["count"] for s in animation["samplers"]))
        self.assertEqual(sorted((c["target"]["node"], c["target"]["path"]) for c in animation["channels"]),
                         sorted((self.nodes[oid], path) for oid in ("TST-0002", "TST-0003", "TST-0004")
                                for path in ("rotation", "translation")))
        for view in self.gltf["bufferViews"]:
            self.assertEqual(view["byteOffset"] % 4, 0)
        self.assertEqual(self.gltf["buffers"][0]["byteLength"], len(self.binary))
        self.assertTrue(all("matrix" not in self.gltf["nodes"][c["target"]["node"]] for c in animation["channels"]))

    def test_keys_place_every_node_where_the_chain_puts_it(self) -> None:
        (animation,) = self.gltf["animations"]
        times = [t for (t,) in _accessor(self.gltf, self.binary, animation["samplers"][0]["input"])]
        tracks = {(c["target"]["node"], c["target"]["path"]): _accessor(self.gltf, self.binary,
                                                                        animation["samplers"][c["sampler"]]["output"])
                  for c in animation["channels"]}
        for index in (0, len(self.frames) // 2, len(self.frames) - 1):
            key = min(range(len(times)), key=lambda i: abs(times[i] - index / self.fps))
            placed = self.chain.transforms(self.frames[index].values)
            for oid in ("TST-0002", "TST-0004"):
                rot, trans = motion_version.glb_rigid(placed[oid])
                got_t = tracks[(self.nodes[oid], "translation")][key]
                got_q = tracks[(self.nodes[oid], "rotation")][key]
                want_q = pose.Rigid(rot, trans).quaternion()
                self.assertLess(max(abs(a - b) for a, b in zip(got_t, trans)), 1e-7)
                norm = math.sqrt(sum(v * v for v in got_q))
                turn = 2 * math.degrees(math.acos(min(1.0, abs(sum(a * b for a, b in zip(got_q, want_q))) / norm)))
                self.assertLess(turn, 1e-4)  # float32 keys

    def test_interpolated_poses_stay_within_the_fidelity_bound(self) -> None:
        report = self.out["glb"]
        self.assertGreater(report["inserted_keys"], 0, "the 200 mm tip needs keys between 5 deg frames")
        self.assertLessEqual(report["max_midpoint_error"]["mm"], 0.1)
        (animation,) = self.gltf["animations"]
        times = [t for (t,) in _accessor(self.gltf, self.binary, animation["samplers"][0]["input"])]
        node = self.nodes["TST-0004"]
        sampler = {c["target"]["path"]: animation["samplers"][c["sampler"]]["output"]
                   for c in animation["channels"] if c["target"]["node"] == node}
        translations, rotations = (_accessor(self.gltf, self.binary, sampler[p]) for p in ("translation", "rotation"))
        lo, hi = motion_version.BOXES["TST-0004"]
        corners = [(x / 1000, z / 1000, -y / 1000) for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]
        worst = 0.0
        for k in range(len(times) - 1):
            t = (times[k] + times[k + 1]) / 2
            q = _slerp(rotations[k], rotations[k + 1], 0.5)
            p = tuple((a + b) / 2 for a, b in zip(translations[k], translations[k + 1]))
            rot, trans = motion_version.glb_rigid(self.chain.transforms(self.chain.complete(self.settings_at(t)))["TST-0004"])
            guess = motion_glb.quat_to_rot(q)
            for c in corners:
                a = [sum(guess[i][j] * c[j] for j in range(3)) + p[i] for i in range(3)]
                b = [sum(rot[i][j] * c[j] for j in range(3)) + trans[i] for i in range(3)]
                worst = max(worst, math.dist(a, b) * 1000)
        self.assertLessEqual(worst, 0.1 + 1e-6)

    def test_the_same_recipe_reuses_and_another_needs_replace(self) -> None:
        code, again = run("render", "--hw", self.hw, "--version", "v1", "--outputs", "glb")
        self.assertEqual((code, again["reused"]), (0, True))
        self.case("tour", {"schema": 1, "segments": [{"id": "a", "to": {"J-001": -90}}, {"id": "b", "to": {"J-001": 90}},
                                                     {"id": "c", "to": {"J-002": -60}}, {"id": "d", "to": {"J-002": 60}}]})
        code, first = run("render", "--hw", self.hw, "--version", "v1", "--case", "tour", "--outputs", "glb")
        self.assertEqual(code, 0, first)
        (self.hw / "motion" / "cases" / "tour" / "plan.yaml").write_text(yaml.safe_dump(
            {"schema": 1, "fps": 24, "segments": [{"id": "a", "to": {"J-001": -90}}, {"id": "b", "to": {"J-001": 90}},
                                                  {"id": "c", "to": {"J-002": -60}}, {"id": "d", "to": {"J-002": 60}}]}),
            encoding="utf-8")
        code, conflict = run("render", "--hw", self.hw, "--version", "v1", "--case", "tour", "--outputs", "glb")
        self.assertEqual(code, 2)
        self.assertIn("--replace", conflict["error"])
        code, replaced = run("render", "--hw", self.hw, "--version", "v1", "--case", "tour", "--outputs", "glb", "--replace")
        self.assertEqual((code, replaced["fps"]), (0, 24))

    def test_a_scratch_plan_renders_only_to_its_out_dir(self) -> None:
        scratch = self.hw.parent / ".cad-work" / "unit"
        scratch.mkdir(parents=True)
        (scratch / "plan.yaml").write_text(yaml.safe_dump({"schema": 1, "case": "draft", "coverage": "partial",
                                                           "coverage_reason": "a first framing test",
                                                           "segments": [{"id": "a", "to": {"J-001": 45}}]}),
                                           encoding="utf-8")
        code, out = run("render", "--hw", self.hw, "--version", "v1", "--plan", scratch / "plan.yaml", "--outputs", "glb")
        self.assertEqual(code, 2)
        self.assertIn("--out-dir", out["error"])
        code, out = run("render", "--hw", self.hw, "--version", "v1", "--plan", scratch / "plan.yaml", "--outputs", "glb",
                        "--out-dir", scratch / "render")
        self.assertEqual((code, out["status"], out["case"]), (0, "flagged", "draft"))
        self.assertTrue((scratch / "render" / "motion.glb").is_file())
        self.assertFalse((self.hw / "motion" / "v1" / "draft").exists())


class GlbRefusals(unittest.TestCase):
    def test_a_glb_with_an_animation_or_nested_occurrences_is_refused(self) -> None:
        data = motion_version.glb([("a", (0, 0, 0), (1, 1, 1), (0, 0, 0), (0, 0, 0, 1)),
                                   ("b", (0, 0, 0), (1, 1, 1), (0, 0, 0), (0, 0, 0, 1))])
        gltf, binary = motion_glb.read_glb(data)
        identity = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]]
        keys = [(0.0, {}), (1.0, {})]
        nested = json.loads(json.dumps(gltf))
        nested["nodes"][0]["children"] = [1]
        nested["nodes"][1]["children"] = [2]
        with self.assertRaisesRegex(motion_glb.GlbError, "lies under another occurrence node"):
            motion_glb.animate(motion_glb.write_glb(nested, binary), {"a": [1], "b": [2]}, lambda s: {"a": identity, "b": identity},
                               keys, "x")
        animated = json.loads(json.dumps(gltf))
        animated["animations"] = [{"samplers": [], "channels": []}]
        with self.assertRaisesRegex(motion_glb.GlbError, "already holds an animation"):
            motion_glb.animate(motion_glb.write_glb(animated, binary), {"a": [1]}, lambda s: {"a": identity}, keys, "x")
        with self.assertRaisesRegex(motion_glb.GlbError, "no occurrence moves"):
            motion_glb.animate(data, {"a": [1]}, lambda s: {"a": identity}, keys, "x")


# --------------------------------------------------------------------------- FreeCAD cross-check


def _evaluate(formula: str, t: float) -> float:
    """A FreeCAD motion formula at time t, parsed (never executed): numbers, `time`, + - * / ^ and parentheses."""
    import ast
    import operator

    binary = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
              ast.Pow: operator.pow}

    def value(node: ast.AST) -> float:
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return float(node.value)
        if isinstance(node, ast.Name) and node.id == "time":
            return t
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
            return -value(node.operand) if isinstance(node.op, ast.USub) else value(node.operand)
        if isinstance(node, ast.BinOp) and type(node.op) in binary:
            return binary[type(node.op)](value(node.left), value(node.right))
        raise ValueError(f"not a motion formula term: {ast.dump(node)}")

    return value(ast.parse(formula.replace("^", "**"), mode="eval").body)


class CrosscheckParsing(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.chain = chain_of(v6_hw(self.tmp))
        effective = plan.prepare(self.chain, plan.default_plan(self.chain), "default")
        self.frames = [{"settings": dict(f.settings), "values": dict(f.values)} for f in plan.expand(self.chain, effective)]
        paths = {pn: self.tmp / f"{pn}.step" for pn in v6_record.PARTS}
        names = {pn: f"{pn} {title}" for pn, (title, _) in v6_record.PARTS.items()}
        self.spec, self.mapping = freecad_assembly.crosscheck_spec(self.chain, paths, names, self.frames, "r",
                                                                   self.tmp / "r.json", self.tmp / "m.FCStd", "coupled")

    def solved(self, values_of) -> list[dict[str, Any]]:
        """FreeCAD-shaped frames: the pre-simulation pose, then each plan frame placed by `values_of`."""
        def placed(values):
            return {oid: [list(t.trans), list(t.quaternion())] for oid, t in self.chain.transforms(values).items()}
        return [placed(self.frames[0]["values"])] + [placed(values_of(f["values"])) for f in self.frames]

    def test_every_law_maps_to_a_freecad_construct(self) -> None:
        self.assertEqual(self.mapping["J-001"], "driven (plan schedule)")
        self.assertEqual(self.mapping["J-031"], "solved (Belt ratio 0.5 to J-001)")
        self.assertEqual(self.mapping["J-011"], "solved (closed loop cylinder-1, displacement)")
        self.assertEqual(self.mapping["J-021"], "solved (closed loop cylinder-1, rod_angle)")
        self.assertTrue(self.mapping["J-041"].startswith("expressed (periodic_table lift"))
        kinds = [j["kind"] for j in self.spec["joints"]]
        self.assertEqual((kinds.count("Belt"), kinds.count("Revolute"), kinds.count("Slider")), (2, 1 + 2 + 6 + 6, 12))
        self.assertEqual(self.spec["time_step"], 1 / 144)
        self.assertTrue(all("e" not in m["formula"].replace("time", "") for m in self.spec["motions"]))

    def test_motion_formulas_reproduce_the_plan_at_every_frame(self) -> None:
        motions = {m["label"]: m["formula"] for m in self.spec["motions"]}
        for label, jid in (("drive J-001", "J-001"), ("J-041 expressed periodic_table lift phase -25 deg", "J-041")):
            scale = math.pi / 180 if jid == "J-001" else 1.0
            for k in (0, 7, 72, 144):
                self.assertAlmostEqual(_evaluate(motions[label], k / 144) / scale, self.frames[k]["values"][jid], places=9)

    def test_freecad_frames_on_the_coupled_motion_pass(self) -> None:
        report = freecad_assembly.compare(self.chain, self.frames, self.solved(lambda v: v), self.mapping)
        self.assertEqual(report["status"], "pass")
        self.assertLess(max(report["max_deviation"].values()), 1e-9)
        self.assertIn("J-031", report["independent_evidence"])
        self.assertNotIn("J-041", report["independent_evidence"])

    def test_a_branch_flip_fails_and_names_the_joint_and_frame(self) -> None:
        report = freecad_assembly.compare(self.chain, self.frames,
                                          self.solved(lambda v: freecad_assembly._far_branch(self.chain, v)), self.mapping)
        self.assertEqual(report["status"], "fail")
        piston = next(f for f in report["findings"] if f.get("joint") == "J-011")
        self.assertAlmostEqual(piston["deviation"], 96.14, places=1)
        self.assertIn("at plan frame", piston["message"])

    def test_a_missing_frame_is_no_result(self) -> None:
        with self.assertRaisesRegex(pose.MotionError, "a motion formula was rejected"):
            freecad_assembly.compare(self.chain, self.frames, self.solved(lambda v: v)[:-1], self.mapping)

    def test_frames_from_another_record_are_refused(self) -> None:
        path = self.tmp / "frames.json"
        document = {"schema": 1, "version": "v1", "frames": [{"settings": f["settings"], "values": dict(f["values"])}
                                                             for f in self.frames]}
        document["frames"][3]["values"]["J-013"] += 0.5
        path.write_text(json.dumps(document), encoding="utf-8")
        with self.assertRaisesRegex(pose.MotionError, "frame 3 has J-013"):
            freecad_assembly.read_frames(path, self.chain, "v1")
        with self.assertRaisesRegex(pose.MotionError, "not v2"):
            freecad_assembly.read_frames(path, self.chain, "v2")


# --------------------------------------------------------------------------- video


def _box(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I4s", 8 + len(payload), kind) + payload


def _mp4(deltas: list[tuple[int, int]], timescale: int = 15360) -> bytes:
    stts = _box(b"stts", struct.pack(">II", 0, len(deltas)) + b"".join(struct.pack(">II", n, d) for n, d in deltas))
    stsd = _box(b"stsd", struct.pack(">II", 0, 1) + _box(b"avc1", b"\x00" * 8))
    mdhd = _box(b"mdhd", struct.pack(">IIIII", 0, 0, 0, timescale, 0))
    hdlr = _box(b"hdlr", struct.pack(">II4s", 0, 0, b"vide") + b"\x00" * 12)
    mdia = _box(b"mdia", mdhd + hdlr + _box(b"minf", _box(b"stbl", stsd + stts)))
    return _box(b"ftyp", b"isom") + _box(b"moov", _box(b"trak", mdia))


def _png(width: int, height: int, rgb: tuple[int, int, int]) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    raw = b"".join(b"\x00" + bytes(rgb) * width for _ in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


class VideoTiming(unittest.TestCase):
    def test_the_mp4_reader_sees_constant_and_varying_sample_durations(self) -> None:
        self.assertEqual(motion.mp4_timing(_mp4([(30, 512)])),
                         {"timescale": 15360, "samples": 30, "sample_deltas": [512], "duration_s": 1.0, "codec": "avc1"})
        self.assertEqual(motion.mp4_timing(_mp4([(10, 512), (1, 1024), (9, 512)]))["sample_deltas"], [512, 1024])

    @unittest.skipUnless(shutil.which("uv"), "uv is required for imageio-ffmpeg, pinned in motion.py's header")
    def test_frames_encode_to_an_mp4_at_constant_fps(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            frames = Path(directory) / "frames"
            frames.mkdir()
            for i in range(12):
                (frames / f"frame-{i:04d}.png").write_bytes(_png(64, 48, (20 * i, 128, 255 - 20 * i)))
            code = (f"import importlib.util, json, sys; from pathlib import Path\n"
                    f"spec = importlib.util.spec_from_file_location('m', {str(SCRIPTS / 'motion.py')!r})\n"
                    f"m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n"
                    f"print(json.dumps(m.encode_video(Path({str(frames)!r}), 12, 24, Path({directory!r}) / 'v.mp4')))\n")
            proc = subprocess.run(scriptenv.python_command(SCRIPTS / "motion.py", "-c", code), capture_output=True,
                                  text=True, timeout=900)
            self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
            video = json.loads(proc.stdout.splitlines()[-1])
        self.assertEqual((video["frames"], video["fps"], video["constant_fps"], video["codec"]), (12, 24, True, "avc1"))
        self.assertEqual(video["sample_delta"] * 24, video["timescale"])
        self.assertEqual(video["encoder"]["imageio-ffmpeg"], scriptenv.pinned(SCRIPTS / "motion.py", "imageio-ffmpeg"))


# --------------------------------------------------------------------------- end to end


class RenderSpec(Fixture):
    def test_tiles_groups_and_parity_checks_follow_the_plan(self) -> None:
        self.case("tour", {"schema": 1, "segments": [{"id": "out", "to": {"J-001": 90}, "camera": "side"},
                                                     {"id": "wait", "hold_frames": 3},
                                                     {"id": "fold", "to": {"J-002": 60}}]})
        ctx = motion.Context(self.hw, "v1")
        effective = plan.load(ctx.chain, self.hw, pose.LAYOUT, "tour")
        frames = plan.expand(ctx.chain, effective)
        spans = plan.spans(effective, frames)
        spec = motion.render_spec(ctx, effective, frames, spans, {0, *(s.last for s in spans)})
        self.assertEqual([(g["id"], g["camera"], g["render"]) for g in spec["groups"]],
                         [("out", "side", [0, 12, 15]), ("fold", "iso", [27])])
        self.assertEqual([t["frame"] for t in spec["sheet"]["tiles"]], [0, 12, 15, 27])
        self.assertEqual(spec["sheet"]["tiles"][2]["lines"], ["2. wait (frame 15)", "J-001=90° J-002=0°"])
        self.assertEqual(sorted(spec["check"]), ["0", "15", "27"])
        delta = spec["frames"][0]["deltas"]["TST-0002"]
        self.assertEqual(delta["translation"], [0.0, 0.0, 0.0])  # frame 0 is the built pose


@unittest.skipUnless(shutil.which("uv") and chromium_installed(), "needs uv and Playwright Chromium")
class RenderEndToEnd(Fixture):
    def test_the_sheet_and_video_publish_with_a_passing_parity_check(self) -> None:
        self.case("quick", {"schema": 1, "fps": 10, "max_step": {"deg": 30},
                            "segments": [{"id": "low", "to": {"J-001": -90, "J-002": -60}},
                                         {"id": "high", "to": {"J-001": 90, "J-002": 60}, "camera": "front"}]})
        proc = subprocess.run(scriptenv.script_command(SCRIPTS / "motion.py", "render", "--hw", str(self.hw), "--version",
                                                       "v1", "--case", "quick", "--outputs", "sheet,video,frames",
                                                       "--size", "320x240"),
                              capture_output=True, text=True, timeout=1800)
        self.assertEqual(proc.returncode, 0, proc.stdout[-3000:] + proc.stderr[-3000:])
        result = json.loads(proc.stdout)
        bundle = Path(result["bundle"])
        self.assertEqual(pose.LAYOUT.verify(bundle), [])
        self.assertEqual(result["render"]["parity"]["status"], "pass")
        self.assertEqual(result["render"]["sheet"]["tiles"], 3)
        self.assertEqual([g["view"] for g in result["render"]["groups"]], ["iso", "front"])
        self.assertEqual(len(list((bundle / "frames").glob("frame-*.png"))), result["frames"])
        self.assertEqual((result["video"]["frames"], result["video"]["fps"]), (result["frames"], 10))
        width, height = struct.unpack(">II", (bundle / "contact-sheet.png").read_bytes()[16:24])
        self.assertEqual((width, height), (3 * 320 + 4 * 8, 240 + 34 + 2 * 8))


@unittest.skipUnless(shutil.which("uv") and freecad_assembly.find_freecad(None), "needs uv and freecadcmd")
class CrosscheckFreecad(unittest.TestCase):
    """The V6 fixture's coupled laws solved by FreeCAD on the default plan's frames."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = Path(tempfile.mkdtemp())
        proc = subprocess.run(["uv", "run", "--quiet", "--script", str(HERE / "fixtures" / "build_fixtures.py"),
                               str(cls.tmp / "fx")], capture_output=True, text=True, timeout=900)
        assert proc.returncode == 0, proc.stderr[-2000:]
        cls.hw = v6_hw(cls.tmp)
        chain = chain_of(cls.hw)
        effective = plan.prepare(chain, plan.default_plan(chain), "default")
        cls.frames = cls.hw.parent / ".cad-work" / "frames.json"
        cls.frames.parent.mkdir()
        cls.frames.write_text(json.dumps({"schema": 1, "version": None, "frames": [
            {"index": f.index, "settings": dict(f.settings), "values": dict(f.values)}
            for f in plan.expand(chain, effective)]}), encoding="utf-8")

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def crosscheck(self, start: str) -> tuple[int, dict[str, Any]]:
        job = self.hw.parent / ".cad-work" / f"crosscheck-{start}"
        proc = subprocess.run(scriptenv.script_command(SCRIPTS / "freecad_assembly.py", "--hw", str(self.hw),
                                                       "--parts-dir", str(self.tmp / "fx" / "v6"), "--frames",
                                                       str(self.frames), "--job-dir", str(job), "--start", start),
                              capture_output=True, text=True, timeout=900)
        self.assertIn(proc.returncode, (0, 1), proc.stderr[-2000:])
        return proc.returncode, json.loads((job / "crosscheck.json").read_text(encoding="utf-8"))

    def test_coupled_start_agrees_within_1e_9_and_a_far_branch_start_fails(self) -> None:
        code, report = self.crosscheck("coupled")
        self.assertEqual((code, report["status"], report["frames"]), (0, "pass", {"plan": 145, "freecad": 146}))
        self.assertLessEqual(max(report["max_deviation"].values()), 1e-9)
        code, report = self.crosscheck("far-branch")
        self.assertEqual((code, report["status"]), (1, "fail"))
        self.assertGreater(report["max_deviation"]["mm"], 90)


if __name__ == "__main__":
    unittest.main()
