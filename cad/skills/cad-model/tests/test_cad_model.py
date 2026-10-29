#!/usr/bin/env python3
"""cad-model tests: a two-part project built, checked, and diffed in both kernels, plus check rules.

Run: python3 -m unittest discover -s cad/skills/cad-model/tests -v
Needs `uv`; the first run creates three uv environments (orchestrator, CadQuery, build123d) and
their first OCP imports take minutes. Wall times are printed to stderr. The rule tests import
cadmodel directly and need neither uv nor OCP.
"""

from __future__ import annotations

import contextlib
import csv
import hashlib
import itertools
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "cad-drawings" / "scripts"))
import freecad_runtime  # noqa: E402
FREECADCMD = freecad_runtime.find_freecadcmd()
FREECAD_PRESENT = FREECADCMD is not None and FREECADCMD.is_file() and os.access(FREECADCMD, os.X_OK)
FIXTURES = HERE / "fixtures"
SCRIPTS = HERE.parent / "scripts"
CLI = SCRIPTS / "cad_model.py"
BOM_SCRIPT = HERE.parents[1] / "cad-bom" / "scripts" / "bom.py"
KERNELS = ("cadquery", "build123d")
FINDING_KEYS = {"pn", "check", "type", "message", "where"}

sys.path.insert(0, str(SCRIPTS))
from cadmodel import build, check, diff, fonts, manufacture, mesh, occ, orientation, runner  # noqa: E402 - stdlib-only imports; OCP loads on first use

AP242 = "AP242_MANAGED_MODEL_BASED_3D_ENGINEERING"
SCHEMA = re.compile(r"FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'\s*\)\s*\)")
ASSEMBLY = """joints:
  - {id: J-001, type: revolute, parent: TST-0001, child: TST-0002, axis: [0, 0, 1], origin: [0, 0, 20],
     min: -90, max: 90, nominal: 90}
"""
PARTS = {"TST-0001": ("Base block", "PETG", "base.py"), "TST-0002": ("Swing arm", "Aluminum 6061-T6", "arm.py")}
ARM = {"length": 60.0, "width": 20.0, "thickness": 5.0, "z0": 20.0, "bore": 6.0, "boss": 4.0}
SAFE_CASES = {"SAF-0001": "cut", "SAF-0002": "fuse", "SAF-0003": "intersect",
              "SAF-0004": "intersect_disjoint", "SAF-0005": "invalid_input"}

# Analytic volumes (mm^3). Base: 40 x 40 x 20 minus a 6 mm bore. Arm: (length + 10) x 20 x 5 plate,
# plus an r4 x 5 boss, minus an r3 x 5 bore.
BASE_V = 40 * 40 * 20 - math.pi * 9 * 20
ARM_V1 = 70 * 20 * 5 + math.pi * 16 * 5 - math.pi * 9 * 5
# v3 drops the arm 5 mm into the base; at the nominal 90 deg the overlap is x -10..10, y -10..20,
# z 15..20 minus the shared bore.
OVERLAP_V3 = 20 * 30 * 5 - math.pi * 9 * 5

# The flat-strap project: TST-0003, a 90 deg arc of a 2 x 10 mm TPU strap (inner radius 8) on the base
# top, printed as its flat blank, the arc's developed length at mid-thickness. Its volume is 90 pi mm^3
# in both states. The printer is only 5 mm tall, so the blank (14.1 x 2 x 10 as modelled) must turn
# its 2 mm thickness up: permutation xzy, printer X reversed to keep the rotation proper.
STRAP = "TST-0003"
STRAP_PARAMS = {"inner_radius": 8.0, "thickness": 2.0, "width": 10.0, "angle": 90.0, "z0": 20.0, "flat": "flat"}
STRAP_V = math.pi / 4 * (10 ** 2 - 8 ** 2) * 10
FLAT_LENGTH = math.pi / 2 * 9
FLAT_STATE = ("manufacture: {relationship: different, state: flat, reason: elastic_bending, decision: DR-001,"
              " volume_rel_tolerance: 1.0e-6}\n")
FLAT_PRODUCT = "id: strap\nbuild_volume: {x_mm: 60, y_mm: 60, z_mm: 5, margin_mm: 0}\n"
STRAP_JOINT = ("joints:\n  - {{id: J-001, type: fixed, parent: TST-0001, child: {pn}, axis: [0, 0, 1],"
               " origin: [0, 0, 0], min: 0, max: 0, nominal: 0}}\n")


def assert_vectors(case: unittest.TestCase, got: list[float], want: list[float], places: int) -> None:
    case.assertEqual(len(got), len(want))
    for g, w in zip(got, want):
        case.assertAlmostEqual(g, w, places=places)


def assert_same_holes(case: unittest.TestCase, got: list[dict], want: list[dict], places: int) -> None:
    """Hole lists equal: ids, diameters, and `through` exactly; axis, position, and depth to `places`."""
    case.assertEqual([(h["id"], h["diameter_mm"], h["through"]) for h in got],
                     [(h["id"], h["diameter_mm"], h["through"]) for h in want])
    for g, w in zip(got, want):
        assert_vectors(case, g["axis"], w["axis"], places)
        assert_vectors(case, g["position"], w["position"], places)
        case.assertAlmostEqual(g["depth_mm"], w["depth_mm"], places=places)


def set_model(hw: Path, pn: str, kernel: str, template: str, params: dict, title: str, material: str,
              process: str = "cnc", extra: str = "", make_buy: str = "make") -> None:
    folder = hw / "parts" / pn
    folder.mkdir(parents=True, exist_ok=True)
    source = (FIXTURES / kernel / template).read_text(encoding="utf-8")
    source = re.sub(r"^PARAMS = .*$", f"PARAMS = {params!r}", source, count=1, flags=re.M)
    (folder / "model.py").write_text(source, encoding="utf-8")
    (folder / "part.yaml").write_text(
        f"PN: {pn}\nrev: X1\ntitle: {title}\nmaterial: {material}\nprocess: {process}\nfinish: none\n"
        f"mass_target: 100\nmake_buy: {make_buy}\nsupplier: null\n{extra}", encoding="utf-8")


def two_part_project(root: Path, kernel: str) -> Path:
    hw = root / kernel / "hw"
    hw.mkdir(parents=True)
    (hw / "product.yaml").write_text("id: twoarm\n", encoding="utf-8")
    (hw / "assembly.yaml").write_text(ASSEMBLY, encoding="utf-8")
    set_model(hw, "TST-0001", kernel, "base.py", {"size": 40.0, "height": 20.0, "bore": 6.0}, *PARTS["TST-0001"][:2])
    return hw


def set_strap(hw: Path, kernel: str, flat: str = "flat", manufacture: str = FLAT_STATE, pn: str = STRAP) -> None:
    set_model(hw, pn, kernel, "strap.py", {**STRAP_PARAMS, "flat": flat}, "Strap", "TPU 95A", "fdm", manufacture)


def flat_project(root: Path, kernel: str, name: str = "flat-hw") -> Path:
    """The base block (CNC, made as installed) with the TPU strap fixed on its top (FDM, printed flat)."""
    hw = root / kernel / name
    hw.mkdir(parents=True)
    (hw / "product.yaml").write_text(FLAT_PRODUCT, encoding="utf-8")
    (hw / "assembly.yaml").write_text(STRAP_JOINT.format(pn=STRAP), encoding="utf-8")
    set_model(hw, "TST-0001", kernel, "base.py", {"size": 40.0, "height": 20.0, "bore": 6.0}, *PARTS["TST-0001"][:2])
    set_strap(hw, kernel)
    return hw


def set_arm(hw: Path, kernel: str, template: str = "arm.py", bought: bool = False, **changes: float) -> None:
    """The swing arm, made to its model; `bought` makes it a catalogue part, which has no manufacturing output."""
    params = {**ARM, **changes}
    if template == "arm_invalid.py":
        params = {k: params[k] for k in ("length", "width", "thickness", "z0")}
    record = ("purchased", "procurement: {mode: catalog}\n", "buy") if bought else ("cnc", "", "make")
    set_model(hw, "TST-0002", kernel, template, params, *PARTS["TST-0002"][:2], *record)


def safe_project(root: Path, kernel: str) -> Path:
    hw = root / kernel / "safe-hw"
    hw.mkdir(parents=True)
    (hw / "product.yaml").write_text("id: safe\n", encoding="utf-8")
    joints = "".join(f"  - {{id: J-00{i}, type: fixed, parent: SAF-0001, child: {pn}, axis: [0, 0, 1], origin: [0, 0, 0],"
                     f" min: 0, max: 0, nominal: 0}}\n" for i, pn in enumerate(list(SAFE_CASES)[1:], start=1))
    (hw / "assembly.yaml").write_text("joints:\n" + joints, encoding="utf-8")
    for pn, case in SAFE_CASES.items():
        set_model(hw, pn, kernel, "safe_case.py", {"case": case}, f"Safe edit {case}", "PETG")
    return hw


def cli(*args: str) -> tuple[subprocess.CompletedProcess[str], dict, float]:
    """cad_model.py with `args`; a check gets a pair cache of its own unless `args` name one."""
    started = time.perf_counter()
    with tempfile.TemporaryDirectory() as cache:
        if args[0] == "check" and not {"--cache", "--no-cache"} & set(args):
            args = (*args, "--cache", cache)
        proc = subprocess.run(["uv", "run", "--quiet", "--script", str(CLI), *args],
                              capture_output=True, text=True, check=False)  # no timeout: cold OCP imports take minutes
    wall = time.perf_counter() - started
    print(f"[cad-model wall] {wall:7.1f} s  {' '.join(args[:3])}", file=sys.stderr)
    return proc, (json.loads(proc.stdout) if proc.stdout.strip() else {}), wall


def kernel_sequence(root: Path, kernel: str) -> dict:
    """Build v1..v4 of the two-part project, the safe-edit project and the flat-strap project in one kernel.

    v4 is tried first with the arm made to an invalid model: that run is refused and nothing is
    sealed. v4 is then built with the same invalid arm bought from a catalogue, for `check` to catch."""
    hw = two_part_project(root, kernel)
    runs = {}
    for label, arm in (("v1", {}), ("v2", {"length": 80.0}), ("v3", {"z0": 15.0})):
        set_arm(hw, kernel, **arm)
        runs[label] = cli("run", str(hw), "--label", label)
        runs[f"{label}-model"] = (hw / "parts" / "TST-0002" / "model.py").read_text(encoding="utf-8")
    set_arm(hw, kernel, "arm_invalid.py")
    runs["v4-refused"] = cli("run", str(hw), "--label", "v4")
    runs["v4-refused-state"] = {
        "latest": json.loads((hw / "versions" / "latest.json").read_text(encoding="utf-8"))["label"],
        "versions": sorted(p.name for p in (hw / "versions").iterdir())}
    set_arm(hw, kernel, "arm_invalid.py", bought=True)
    runs["v4"] = cli("run", str(hw), "--label", "v4")
    runs["v4-model"] = (hw / "parts" / "TST-0002" / "model.py").read_text(encoding="utf-8")
    runs["checks"] = {label: cli("check", label, "--hw", str(hw)) for label in ("v1", "v2", "v3", "v4")}
    runs["diff"] = cli("diff", "v1", "v2", "--hw", str(hw))
    runs["safe"] = cli("run", str(safe_project(root, kernel)), "--label", "v1")
    runs["hw"] = hw
    runs["flat-hw"] = flat_project(root, kernel)
    runs["flat"] = cli("run", str(runs["flat-hw"]), "--label", "v1")
    runs["flat-check"] = cli("check", "v1", "--hw", str(runs["flat-hw"]))
    return runs


_SHARED: dict = {}


def all_runs() -> dict:
    """Both kernels' sequences, built once per test process and concurrently."""
    if not _SHARED:
        _SHARED["tmp"] = tempfile.TemporaryDirectory()
        root = Path(_SHARED["tmp"].name)
        with ThreadPoolExecutor(max_workers=len(KERNELS)) as pool:
            futures = {k: pool.submit(kernel_sequence, root, k) for k in KERNELS}
            _SHARED["runs"] = {k: f.result() for k, f in futures.items()}
    return _SHARED["runs"]




class DeterministicTextTests(unittest.TestCase):
    """The runner requires explicit model font paths and injects the verified shared font."""

    def test_runner_refuses_text_without_font_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            model = Path(tmp) / "model.py"
            model.write_text('KERNEL = "cadquery"\nPARAMS = {}\n'
                             'def build(params):\n    return cq.Workplane("XY").text("LMP", 8, -0.6)\n',
                             encoding="utf-8")
            module = runner._load_model("TST-0001", model)
            with self.assertRaisesRegex(runner.ContractError, r"text\(\) must pass an explicit font file path"):
                runner._validate_text_fonts(module)

    def test_runner_accepts_explicit_cadquery_and_build123d_font_paths(self) -> None:
        calls = (("cadquery", 'cq.Workplane("XY").text("LMP", 8, -0.6, fontPath="font.ttf")'),
                 ("build123d", 'bd.Text("LMP", 8, font_path="font.ttf")'))
        for kernel, source in calls:
            with self.subTest(kernel=kernel), tempfile.TemporaryDirectory() as tmp:
                model = Path(tmp) / "model.py"
                model.write_text(f"KERNEL = {kernel!r}\nPARAMS = {{}}\n{source}\n", encoding="utf-8")
                module = type("Model", (), {"__file__": str(model)})()
                runner._validate_text_fonts(module)

    @unittest.skipUnless(FREECAD_PRESENT, "verified bundled Osifont requires FreeCAD 1.1.4 freecadcmd")
    def test_verified_osifont_path_matches_the_runner_contract(self) -> None:
        font = Path(fonts.osifont_path())
        self.assertEqual(hashlib.sha256(font.read_bytes()).hexdigest(), fonts.OSIFONT_SHA256)

    def test_osifont_resolver_checks_the_expected_font_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            command = root / "bin" / "freecadcmd"
            font = root / "share" / fonts.OSIFONT_RELATIVE_PATH
            command.parent.mkdir(parents=True)
            command.write_text("", encoding="utf-8")
            font.parent.mkdir(parents=True)
            font.write_bytes(b"verified osifont test bytes")
            digest = hashlib.sha256(font.read_bytes()).hexdigest()
            with mock.patch.object(fonts, "_freecadcmd", return_value=command), \
                 mock.patch.object(fonts, "OSIFONT_SHA256", digest):
                resolved = Path(fonts._osifont_for(command))
            self.assertEqual(resolved, font.resolve())


    def test_freecad_lookup_uses_the_preflight_candidate_order(self) -> None:
        with mock.patch.dict(os.environ, {"FREECADCMD": "/selected/freecadcmd"}):
            self.assertEqual(fonts._freecadcmd(), Path("/selected/freecadcmd"))

    def test_osifont_resolver_rejects_unexpected_font_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            command = root / "bin" / "freecadcmd"
            font = root / "share" / fonts.OSIFONT_RELATIVE_PATH
            command.parent.mkdir(parents=True)
            command.write_text("", encoding="utf-8")
            font.parent.mkdir(parents=True)
            font.write_bytes(b"unexpected font bytes")
            with mock.patch.object(fonts, "OSIFONT_SHA256", fonts.OSIFONT_SHA256):
                with self.assertRaisesRegex(RuntimeError, "unsupported TechDraw Osifont"):
                    fonts._osifont_for(command)

    def test_missing_freecad_font_fails_instead_of_using_system_font(self) -> None:
        with mock.patch.object(fonts, "_freecadcmd", return_value=None):
            with self.assertRaisesRegex(FileNotFoundError, "cannot find the preflight-selected FreeCAD"):
                fonts.osifont_path.__wrapped__()

    @unittest.skipUnless(FREECAD_PRESENT, "font geometry tests require FreeCAD 1.1.4 bundled Osifont")
    def test_text_fixtures_build_identically_in_both_kernels(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:  # run_kernels writes each part's STEP to its "step" path
            requests = {kernel: [{"pn": f"TXT-{i:04d}", "name": "Text fixture",
                                 "model": str(FIXTURES / kernel / "text.py"), "step": str(Path(tmp) / f"{kernel}.step")}]
                        for i, kernel in enumerate(KERNELS, start=1)}
            results = build.run_kernels(requests)
        shapes = {kernel: next(iter(result["parts"].values())) for kernel, result in results.items()}
        for kernel, part in shapes.items():
            self.assertTrue(part["ok"], part)
        volumes = {kernel: part["kernel_volume_mm3"] for kernel, part in shapes.items()}
        self.assertLess(abs(volumes["cadquery"] - volumes["build123d"]) / volumes["cadquery"], 1e-7)

def tearDownModule() -> None:  # noqa: N802 - unittest hook name
    if "tmp" in _SHARED:
        _SHARED["tmp"].cleanup()

class KernelChecks:
    """The acceptance cases, run once per kernel by the subclasses below."""
    kernel = ""

    @classmethod
    def setUpClass(cls) -> None:
        cls.runs = all_runs()[cls.kernel]

    def test_versions_build_with_the_record_layout(self) -> None:
        hw = self.runs["hw"]
        for label in ("v1", "v2", "v3", "v4"):
            proc, result, _ = self.runs[label]
            self.assertEqual(proc.returncode, 0, proc.stderr[-3000:])
            self.assertEqual(result["status"], "pass")
            folder = hw / "versions" / label
            for name in ("assembly.step", "assembly.glb", "metrics.json", "manifest.json", "part-map.json",
                         "parts/TST-0001.step", "parts/TST-0002.step"):
                self.assertTrue((folder / name).is_file(), f"{label} {name}")
            self.assertEqual((folder / "assembly.glb").read_bytes()[:4], b"glTF")
            manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["parts"]["TST-0002"]["kernel"], self.kernel)
            self.assertIn(self.kernel, manifest["tools"][self.kernel])
            self.assertEqual(manifest["pose"]["values"], {"J-001": 90.0})
            self.assertEqual(manifest["joint_pairs"], [{"pair": ["TST-0001", "TST-0002"], "joint": "J-001",
                                                        "type": "revolute"}])
        sources = {json.loads((hw / "versions" / v / "manifest.json").read_text())["parts"]["TST-0002"]["source_sha256"]
                   for v in ("v1", "v2", "v3", "v4")}
        self.assertEqual(len(sources), 4, "each arm edit has its own source hash")
        v2 = json.loads((hw / "versions" / "v2" / "manifest.json").read_text())
        self.assertEqual(v2["parts"]["TST-0002"]["params"]["length"], 80.0)
        latest = json.loads((hw / "versions" / "latest.json").read_text(encoding="utf-8"))
        self.assertEqual(latest["label"], "v4")
        self.assertEqual(latest["parts"]["TST-0002"], "versions/v4/parts/TST-0002.step")
        for key in ("assembly_step", "glb", "metrics", "part_map", "manifest"):
            self.assertTrue((hw / latest[key]).is_file(), key)
        self.assertFalse(list((hw / "parts").rglob("__pycache__")), "runner must not write bytecode into hw/")

    def test_existing_label_is_refused(self) -> None:
        proc, _, _ = cli("run", str(self.runs["hw"]), "--label", "v1")
        self.assertEqual(proc.returncode, 2, proc.stderr[-2000:])
        self.assertIn("immutable", proc.stderr)

    def test_explicit_kernel_must_match_every_part(self) -> None:
        other = next(k for k in KERNELS if k != self.kernel)
        proc, result, _ = cli("run", str(self.runs["hw"]), "--label", "v9", "--kernel", other)
        self.assertEqual(proc.returncode, 1, proc.stderr[-2000:])
        self.assertEqual({(f["pn"], f["check"]) for f in result["findings"]}, {("TST-0001", "kernel"), ("TST-0002", "kernel")})
        self.assertTrue(all(f.keys() == FINDING_KEYS for f in result["findings"]), result["findings"])
        self.assertFalse((self.runs["hw"] / "versions" / "v9").exists())

    def test_metrics_volumes_and_mass(self) -> None:
        metrics = json.loads((self.runs["hw"] / "versions" / "v1" / "metrics.json").read_text())["parts"]
        self.assertAlmostEqual(metrics["TST-0001"]["volume_mm3"], BASE_V, places=4)
        self.assertAlmostEqual(metrics["TST-0002"]["volume_mm3"], ARM_V1, places=4)
        self.assertAlmostEqual(metrics["TST-0001"]["mass_g"], BASE_V * 1.27 / 1000, places=6)
        self.assertAlmostEqual(metrics["TST-0002"]["mass_g"], ARM_V1 * 2.70 / 1000, places=6)
        self.assertEqual(metrics["TST-0002"]["solids"], 1)
        for got, want in zip(metrics["TST-0002"]["bbox_mm"]["min"], [-10.0, -10.0, 20.0]):
            self.assertAlmostEqual(got, want, places=6)
        # Both through bores (Ø6 x 20 in the base, Ø6 x 5 in the arm); the arm's convex boss is not a hole.
        for pn, top, depth in (("TST-0001", 20.0, 20.0), ("TST-0002", 25.0, 5.0)):
            found = metrics[pn]["holes"]
            self.assertEqual([(h["id"], h["diameter_mm"], h["axis"], h["through"]) for h in found],
                             [("H1", 6.0, [0.0, 0.0, -1.0], True)], pn)
            assert_vectors(self, found[0]["position"], [0.0, 0.0, top], places=6)
            self.assertAlmostEqual(found[0]["depth_mm"], depth, places=6)

    def test_ap242_header_and_product_names_read_back(self) -> None:
        folder = self.runs["hw"] / "versions" / "v1"
        for path in (folder / "assembly.step", folder / "parts" / "TST-0001.step", folder / "parts" / "TST-0002.step"):
            match = SCHEMA.search(path.read_text(encoding="utf-8")[:3000])
            self.assertTrue(match and match.group(1).startswith(AP242), path)
        assembly = (folder / "assembly.step").read_text(encoding="utf-8")
        for name in ("TST-0001 Base block", "TST-0002 Swing arm", "twoarm v1"):
            self.assertIn(f"PRODUCT('{name}'", assembly)
        readback = self.runs["checks"]["v1"][1]["checks"]["step_readback"]
        self.assertEqual(readback["status"], "pass", json.dumps(readback, indent=1))
        arm = readback["parts"]["TST-0002"]
        self.assertEqual((arm["part_step_name"], arm["assembly_name"]), ("TST-0002 Swing arm", "TST-0002 Swing arm"))
        self.assertLessEqual(arm["part_step_rel_error"], 1e-6)
        self.assertLessEqual(arm["assembly_rel_error"], 1e-6)
        part_map = json.loads((folder / "part-map.json").read_text())["parts"]
        self.assertEqual(part_map["TST-0002"]["nodes"], ["TST-0002 Swing arm"])
        self.assertEqual(part_map["TST-0002"]["meshes"], ["TST-0002 Swing arm"])


    def test_check_reports_template_declared_press_pairs(self) -> None:
        hw = self.runs["hw"]
        template = HERE.parents[2] / "examples" / "lamp-arm" / "hw" / "interfaces.yaml"
        shutil.copy(template, hw / "interfaces.yaml")
        _, result, _ = cli("check", "v1", "--hw", str(hw))
        declared = result["checks"]["interference"]["declared_pairs"]
        self.assertEqual({tuple(item["pair"]) for item in declared}, {
            ("LMP-0002", "LMP-0005"), ("LMP-0002", "LMP-0006"), ("LMP-0003", "LMP-0007")})
        self.assertTrue(all(item["classification"] == "interference" for item in declared))
        self.assertTrue(all("interfaces.yaml#/interfaces/" in item["source"] for item in declared))
    def test_clean_versions_pass_check(self) -> None:
        for label in ("v1", "v2"):
            proc, result, _ = self.runs["checks"][label]
            self.assertEqual(proc.returncode, 0, json.dumps(result.get("checks"), indent=1)[:4000] + proc.stderr[-2000:])
            self.assertEqual((result["status"], result["blocking_failures"]), ("pass", []))
        checks = self.runs["checks"]["v1"][1]["checks"]
        self.assertEqual(checks["connection"]["parts"]["TST-0002"]["status"], "touching")
        self.assertEqual(checks["interference"]["joint_pairs"][0]["pair"], ["TST-0001", "TST-0002"])
        self.assertTrue(all(p["watertight"] for p in checks["mesh_watertight"]["parts"].values()))
        self.assertEqual(self.runs["checks"]["v2"][1]["checks"]["solid_structure"]["parts"]["TST-0002"]["baseline"], "v1")

    def test_check_fails_on_deliberate_overlap(self) -> None:
        proc, result, _ = self.runs["checks"]["v3"]
        self.assertEqual(proc.returncode, 1, proc.stderr[-2000:])
        self.assertEqual(result["blocking_failures"], ["interference"])
        hit = result["checks"]["interference"]["joint_pairs"][0]
        self.assertTrue(hit["interferes"])
        self.assertLess(abs(hit["interference_mm3"] - OVERLAP_V3) / OVERLAP_V3, 1e-6)

    def test_check_fails_on_invalid_shape(self) -> None:
        proc, result, _ = self.runs["checks"]["v4"]
        self.assertEqual(proc.returncode, 1, proc.stderr[-2000:])
        self.assertIn("brep_validity", result["blocking_failures"])
        validity = result["checks"]["brep_validity"]["parts"]
        self.assertFalse(validity["TST-0002"]["valid"])
        self.assertIn("NotClosed", validity["TST-0002"]["kernel_errors"])
        self.assertTrue(validity["TST-0001"]["valid"])
        self.assertFalse(result["checks"]["mesh_watertight"]["parts"]["TST-0002"]["watertight"])

    def test_diff_reports_the_arm_extension(self) -> None:
        proc, result, _ = self.runs["diff"]
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        self.assertEqual((result["added"], result["removed"], result["changed"], result["error"]),
                         ([], [], ["TST-0002"], []))
        arm, base = result["parts"]["TST-0002"], result["parts"]["TST-0001"]
        self.assertAlmostEqual(arm["volume_delta_mm3"], 20 * 20 * 5, places=4)
        for got, want in zip(arm["bbox_delta_mm"]["size"], [20.0, 0.0, 0.0]):
            self.assertAlmostEqual(got, want, places=6)
        boss = math.pi * 16 * 5  # the boss moves 20 mm with the arm end
        self.assertAlmostEqual(arm["a_only_mm3"], boss, places=3)
        self.assertAlmostEqual(arm["b_only_mm3"], 2000 + boss, places=3)
        self.assertAlmostEqual(arm["shared_mm3"], ARM_V1 - boss, places=3)
        self.assertEqual(base["status"], "unchanged")
        self.assertAlmostEqual(base["shared_mm3"], BASE_V, places=4)
        made = result["manufacturing"]
        self.assertEqual((made["changed"], made["parts"]["TST-0002"]["changed"]), (["TST-0002"], ["geometry"]))
        self.assertEqual(made["parts"]["TST-0001"]["status"], "unchanged")

    def test_safe_edits_reject_impossible_results(self) -> None:
        expected = {"SAF-0001": "safe_cut rejected an impossible result",
                    "SAF-0002": "safe_fuse rejected an impossible result",
                    "SAF-0003": "safe_intersect rejected an impossible result",
                    "SAF-0004": "safe_intersect rejected an empty result",
                    "SAF-0005": "safe_cut source is not a valid B-rep"}
        proc, result, _ = self.runs["safe"]
        self.assertEqual(proc.returncode, 1, proc.stderr[-2000:])
        found = {f["pn"]: f for f in result["findings"]}
        self.assertEqual(sorted(found), sorted(expected))
        for pn, text in expected.items():
            self.assertEqual(found[pn].keys(), FINDING_KEYS)
            self.assertEqual(found[pn]["type"], "SafeEditError", found[pn])
            self.assertIn(text, found[pn]["message"])
            self.assertTrue(found[pn]["where"].startswith("model.py:"), found[pn])
        self.assertFalse((self.runs["hw"].parent / "safe-hw" / "versions" / "v1").exists())

    def test_an_invalid_made_part_blocks_the_version(self) -> None:
        proc, result, _ = self.runs["v4-refused"]
        self.assertEqual(proc.returncode, 1, proc.stderr[-3000:])
        self.assertEqual([(f["pn"], f["check"], f["type"]) for f in result["findings"]],
                         [("TST-0002", "manufacture", "ManufactureError")])
        self.assertEqual(result["findings"][0].keys(), FINDING_KEYS)
        self.assertIn("native: valid", result["findings"][0]["message"])
        self.assertIn("native", result["manufacturing"]["TST-0002"]["blocking_failures"])
        # nothing sealed, no partial folder left, latest still names v3
        self.assertEqual(self.runs["v4-refused-state"], {"latest": "v3", "versions": ["latest.json", "v1", "v2", "v3"]})

    def test_versions_snapshot_the_record_they_were_built_from(self) -> None:
        hw = self.runs["hw"]
        v2 = hw / "versions" / "v2"
        manifest = json.loads((v2 / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(sorted(manifest["record"]), ["record/assembly.yaml", "record/parts/TST-0001/part.yaml",
                                                      "record/parts/TST-0002/part.yaml", "record/product.yaml"])
        for name, sha in manifest["record"].items():
            self.assertEqual(manifest["files"][name], sha)
        # v2's arm was made; the current record buys it (v4), and the snapshot keeps the old state
        self.assertIn("make_buy: make", (v2 / "record" / "parts" / "TST-0002" / "part.yaml").read_text(encoding="utf-8"))
        self.assertIn("make_buy: buy", (hw / "parts" / "TST-0002" / "part.yaml").read_text(encoding="utf-8"))
        v4 = json.loads((hw / "versions" / "v4" / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(sorted(v4["manufacturing"]), ["TST-0001"])  # a catalogue buy has no manufacturing output
        self.assertEqual(self.runs["checks"]["v1"][1]["checks"]["artifact_integrity"]["status"], "pass")

    def test_the_flat_strap_is_built_in_its_manufacturing_state(self) -> None:
        proc, result, _ = self.runs["flat"]
        self.assertEqual(proc.returncode, 0, proc.stdout[-3000:] + proc.stderr[-3000:])
        folder = self.runs["flat-hw"] / "versions" / "v1"
        made = folder / "manufacturing"
        self.assertEqual(sorted(p.name for p in (made / STRAP).iterdir()), ["manufacturing.json", "part.step", "part.stl"])
        self.assertEqual(sorted(p.name for p in (made / "TST-0001").iterdir()), ["manufacturing.json", "part.step"])
        stl = (made / STRAP / "part.stl").read_bytes()
        self.assertEqual(len(stl), 84 + 50 * struct.unpack_from("<I", stl, 80)[0], "binary STL")
        manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
        strap, base = manifest["manufacturing"][STRAP], manifest["manufacturing"]["TST-0001"]
        self.assertEqual((strap["PN"], strap["rev"], strap["material"], strap["product"]),
                         (STRAP, "X1", "TPU 95A", f"{STRAP} Strap"))
        self.assertEqual(strap["state"], {"relationship": "different", "name": "flat", "reason": "elastic_bending",
                                          "decision": "DR-001", "source": "build_manufacture"})
        self.assertAlmostEqual(strap["native"]["kernel_volume_mm3"], STRAP_V, places=6)
        # the base block has no hook: its installed definition is reused, not built again
        self.assertEqual((base["state"]["relationship"], base["state"]["source"]), ("same", "installed definition"))
        self.assertEqual(base["native"]["kernel_volume_mm3"], base["installed"]["kernel_volume_mm3"])
        self.assertEqual(base["placement"]["transform"], [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]])
        placement = strap["placement"]
        self.assertEqual((placement["method"], placement["orientation"], placement["determinant"]),
                         ("axis_aligned", "xzy", 1.0))
        self.assertEqual([row[:3] for row in placement["transform"]], [[-1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]])
        for name, sha in strap["files"].items():
            self.assertEqual(hashlib.sha256((made / STRAP / name).read_bytes()).hexdigest(), sha, name)
            self.assertEqual(manifest["files"][f"manufacturing/{STRAP}/{name}"], sha)

        proc, checked, _ = self.runs["flat-check"]
        section = checked.get("checks", {}).get("manufacturing")
        self.assertEqual(proc.returncode, 0, json.dumps(section, indent=1)[:4000] + proc.stderr[-2000:])
        self.assertEqual((section["status"], section["complete"], section["blocking_failures"]), ("pass", True, []))
        rows = section["parts"][STRAP]["checks"]
        self.assertEqual({name: row["status"] for name, row in rows.items()},
                         dict.fromkeys(("outputs", "record", "native", "identity", "step", "mesh", "placement"), "pass"))
        self.assertEqual((rows["step"]["units"], rows["step"]["product"], rows["step"]["solids"]), (["mm"], f"{STRAP} Strap", 1))
        self.assertLessEqual(rows["step"]["rel_error"], 1e-6)
        self.assertAlmostEqual(rows["identity"]["allowed_mm3"], STRAP_V * 1e-6, places=10)
        self.assertLessEqual(rows["identity"]["difference_mm3"], rows["identity"]["allowed_mm3"])
        self.assertEqual((rows["mesh"]["watertight"], rows["mesh"]["winding_consistent"], rows["mesh"]["shells"]),
                         (True, True, 1))
        low, high = rows["placement"]["bbox_mm"]["min"], rows["placement"]["bbox_mm"]["max"]
        assert_vectors(self, [high[i] - low[i] for i in range(3)], [FLAT_LENGTH, 10.0, 2.0], places=6)
        assert_vectors(self, [(low[0] + high[0]) / 2, (low[1] + high[1]) / 2, low[2]], [30.0, 30.0, 0.0], places=6)
        self.assertNotIn("mesh", section["parts"]["TST-0001"]["checks"])
        self.assertEqual(checked["checks"]["build_volume"]["parts"][STRAP]["status"], "pass")
        self.assertEqual(checked["checks"]["artifact_integrity"], {"status": "pass", "blocking": True, "problems": []})


@unittest.skipUnless(shutil.which("uv"), "uv is required for the kernel environments")
class CadQueryTests(KernelChecks, unittest.TestCase):
    kernel = "cadquery"


@unittest.skipUnless(shutil.which("uv"), "uv is required for the kernel environments")
class Build123dTests(KernelChecks, unittest.TestCase):
    kernel = "build123d"


@unittest.skipUnless(shutil.which("uv"), "uv is required for the kernel environments")
class CrossKernelTests(unittest.TestCase):
    def test_kernels_produce_identical_json(self) -> None:
        runs = all_runs()
        a, b = (json.loads((runs[k]["hw"] / "versions" / "v1" / "metrics.json").read_text()) for k in KERNELS)
        self.assertEqual(a.keys(), b.keys())
        for pn in a["parts"]:
            self.assertEqual(a["parts"][pn].keys(), b["parts"][pn].keys())
            self.assertLess(abs(a["parts"][pn]["volume_mm3"] - b["parts"][pn]["volume_mm3"]) / BASE_V, 1e-6)
            assert_same_holes(self, a["parts"][pn]["holes"], b["parts"][pn]["holes"], places=3)
        checks = [runs[k]["checks"]["v1"][1] for k in KERNELS]
        self.assertEqual(checks[0].keys(), checks[1].keys())
        self.assertEqual(checks[0]["checks"].keys(), checks[1]["checks"].keys())
        self.assertEqual(runs[KERNELS[0]]["v1"][1].keys(), runs[KERNELS[1]]["v1"][1].keys())

    def test_kernels_place_the_flat_strap_alike(self) -> None:
        runs = all_runs()
        entries = [json.loads((runs[k]["flat-hw"] / "versions" / "v1" / "manifest.json").read_text())["manufacturing"]
                   for k in KERNELS]
        self.assertEqual(entries[0].keys(), entries[1].keys())
        for pn in entries[0]:
            a, b = entries[0][pn], entries[1][pn]
            self.assertLess(abs(a["native"]["kernel_volume_mm3"] - b["native"]["kernel_volume_mm3"]) / STRAP_V, 1e-6)
            self.assertEqual((a["placement"]["method"], a["placement"]["orientation"]),
                             (b["placement"]["method"], b["placement"]["orientation"]))
            for ra, rb in zip(a["placement"]["transform"], b["placement"]["transform"]):
                assert_vectors(self, ra, rb, places=6)


def version_state(hw: Path) -> dict:
    """What a failed run must leave unchanged: the latest label and the entries of hw/versions/."""
    latest = hw / "versions" / "latest.json"
    return {"latest": json.loads(latest.read_text(encoding="utf-8"))["label"] if latest.is_file() else None,
            "versions": sorted(p.name for p in (hw / "versions").iterdir())}


def tree_hashes(folder: Path) -> dict[str, str]:
    return {p.relative_to(folder).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(folder.rglob("*")) if p.is_file()}


@unittest.skipUnless(shutil.which("uv"), "uv is required for the kernel environments")
class ManufacturingStateTests(unittest.TestCase):
    """The flat-strap project (CadQuery only): refused manufacturing declarations and states never seal a
    version, a manufacturing-only change shows in diff, a tampered STL fails check, and a sealed version
    whose latest pointer could not be written is kept and pointed at without a rebuild."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        cls.hw = hw = flat_project(root, "cadquery")
        cls.runs, cls.states = {"v1": cli("run", str(hw), "--label", "v1")}, {}
        base = {"size": 40.0, "height": 20.0, "bore": 6.0}

        def attempt(name: str, extra: tuple[str, ...] = ()) -> None:
            """Run v2 with `extra` parts fixed to the base too, then remove them and their joints again."""
            joints = [STRAP_JOINT.format(pn=pn).replace("J-001", f"J-{i:03d}") for i, pn in enumerate((STRAP, *extra), 1)]
            (hw / "assembly.yaml").write_text("joints:\n" + "".join(j.removeprefix("joints:\n") for j in joints),
                                              encoding="utf-8")
            cls.runs[name] = cli("run", str(hw), "--label", "v2")
            cls.states[name] = version_state(hw)
            (hw / "assembly.yaml").write_text(STRAP_JOINT.format(pn=STRAP), encoding="utf-8")
            for pn in extra:
                shutil.rmtree(hw / "parts" / pn)

        # The hook without a declaration, a declaration without a hook, a hook that is not callable.
        set_strap(hw, "cadquery", manufacture="")
        set_model(hw, "TST-0004", "cadquery", "base.py", base, "Spacer", "PETG", "fdm", FLAT_STATE)
        set_strap(hw, "cadquery", pn="TST-0005")
        with (hw / "parts" / "TST-0005" / "model.py").open("a", encoding="utf-8") as model:
            model.write('\nbuild_manufacture = "flat"\n')
        attempt("contract", ("TST-0004", "TST-0005"))
        # A different state without a volume tolerance, refused before any kernel runs.
        set_strap(hw, "cadquery", manufacture=FLAT_STATE.replace(", volume_rel_tolerance: 1.0e-6", ""))
        attempt("tolerance")
        # A blank 10 % too long, a blank in two pieces, and a blank that is an open shell.
        set_strap(hw, "cadquery", flat="long")
        set_strap(hw, "cadquery", flat="split", pn="TST-0004")
        set_strap(hw, "cadquery", flat="open", pn="TST-0005")
        attempt("identity", ("TST-0004", "TST-0005"))
        # A manufacturing-only change: the declared tolerance; the installed definitions stay identical.
        set_strap(hw, "cadquery", manufacture=FLAT_STATE.replace("1.0e-6", "2.0e-6"))
        cls.runs["v2"] = cli("run", str(hw), "--label", "v2")
        cls.runs["diff"] = cli("diff", "v1", "v2", "--hw", str(hw))
        # One triangle cut from a sealed STL: a crack, and bytes the manifest no longer matches.
        tampered = root / "tampered" / "hw"
        shutil.copytree(hw, tampered)
        stl = tampered / "versions" / "v2" / "manufacturing" / STRAP / "part.stl"
        data = stl.read_bytes()
        stl.write_bytes(data[:80] + struct.pack("<I", struct.unpack_from("<I", data, 80)[0] - 1) + data[84:-50])
        cls.runs["tampered"] = cli("check", "v2", "--hw", str(tampered))
        # The pointer write fails after v3 is sealed: latest.json is a directory.
        (hw / "versions" / "latest.json").unlink()
        (hw / "versions" / "latest.json").mkdir()
        cls.runs["v3"] = cli("run", str(hw), "--label", "v3")
        cls.states["v3"] = version_state(hw)
        cls.v3_files = tree_hashes(hw / "versions" / "v3")
        (hw / "versions" / "latest.json").rmdir()
        cls.runs["stale"] = cli("latest", str(hw), "--label", "v2")
        cls.runs["latest"] = cli("latest", str(hw), "--label", "v3")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def findings(self, name: str) -> dict:
        proc, result, _ = self.runs[name]
        self.assertEqual(proc.returncode, 1, proc.stdout[-2000:] + proc.stderr[-3000:])
        self.assertEqual(self.states[name], {"latest": "v1", "versions": ["latest.json", "v1"]}, name)
        self.assertTrue(all(f.keys() == FINDING_KEYS for f in result["findings"]), result["findings"])
        return {f["pn"]: f for f in result["findings"]}

    def test_a_hook_needs_its_declaration_and_a_declaration_its_callable_hook(self) -> None:
        self.assertEqual(self.runs["v1"][0].returncode, 0, self.runs["v1"][0].stderr[-3000:])
        found = self.findings("contract")
        self.assertEqual(sorted(found), [STRAP, "TST-0004", "TST-0005"])
        self.assertTrue(all(f["type"] == "ContractError" for f in found.values()), found)
        self.assertIn("does not declare manufacture.relationship: different", found[STRAP]["message"])
        self.assertIn("defines no build_manufacture", found["TST-0004"]["message"])
        self.assertIn("not callable", found["TST-0005"]["message"])

    def test_a_different_state_without_a_tolerance_is_refused_before_the_kernels(self) -> None:
        found = self.findings("tolerance")
        self.assertEqual((found[STRAP]["check"], found[STRAP]["type"]), ("manufacture", "ContractError"))
        self.assertIn("without a volume tolerance", found[STRAP]["message"])
        self.assertNotIn("runners", self.runs["tolerance"][1])

    def test_volume_drift_solid_count_and_an_invalid_state_block_the_version(self) -> None:
        found = self.findings("identity")
        self.assertEqual(sorted(found), [STRAP, "TST-0004", "TST-0005"])
        self.assertTrue(all((f["check"], f["type"]) == ("manufacture", "ManufactureError") for f in found.values()))
        self.assertIn("identity: volume_within_tolerance", found[STRAP]["message"])
        self.assertIn("same_solids", found["TST-0004"]["message"])
        self.assertIn("native: valid", found["TST-0005"]["message"])
        identity = self.runs["identity"][1]["manufacturing"][STRAP]["checks"]["identity"]
        self.assertAlmostEqual(identity["difference_mm3"], STRAP_V * 0.1, places=6)
        self.assertAlmostEqual(identity["allowed_mm3"], STRAP_V * 1e-6, places=10)

    def test_a_manufacturing_only_change_shows_in_diff(self) -> None:
        self.assertEqual(self.runs["v2"][0].returncode, 0, self.runs["v2"][0].stderr[-3000:])
        proc, result, _ = self.runs["diff"]
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        self.assertEqual((result["changed"], result["added"], result["removed"]), ([], [], []))
        self.assertEqual(result["manufacturing"]["changed"], [STRAP])
        self.assertEqual(result["manufacturing"]["parts"][STRAP]["changed"], ["tolerance"])

    def test_a_cracked_stl_fails_check(self) -> None:
        proc, result, _ = self.runs["tampered"]
        self.assertEqual(proc.returncode, 1, proc.stderr[-2000:])
        self.assertIn("manufacturing", result["blocking_failures"])
        self.assertIn("artifact_integrity", result["blocking_failures"])
        row = result["checks"]["manufacturing"]["parts"][STRAP]
        self.assertEqual(row["blocking_failures"], ["mesh", "outputs"])
        self.assertEqual(row["checks"]["outputs"]["changed"], ["part.stl"])
        self.assertIn("watertight", row["checks"]["mesh"]["failed"])
        self.assertEqual(result["checks"]["manufacturing"]["parts"]["TST-0001"]["status"], "pass")

    def test_a_sealed_version_keeps_and_reconciles_a_failed_latest_pointer(self) -> None:
        proc, _, _ = self.runs["v3"]
        self.assertEqual(proc.returncode, 2, proc.stderr[-2000:])
        self.assertIn("v3 is sealed", proc.stderr)
        self.assertIn("cad_model.py latest", proc.stderr)
        self.assertEqual(self.states["v3"]["versions"], ["latest.json", "v1", "v2", "v3"])  # no .latest.json.tmp left
        stale, _, _ = self.runs["stale"]
        self.assertEqual(stale.returncode, 2, stale.stderr[-2000:])
        self.assertIn("not the newest", stale.stderr)
        proc, result, _ = self.runs["latest"]
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        self.assertEqual(result["verified_files"], len(self.v3_files) - 1)
        latest = json.loads((self.hw / "versions" / "latest.json").read_text(encoding="utf-8"))
        self.assertEqual((latest["label"], latest["manufacturing"][STRAP]), ("v3", f"versions/v3/manufacturing/{STRAP}"))
        self.assertEqual(tree_hashes(self.hw / "versions" / "v3"), self.v3_files)


@unittest.skipUnless(shutil.which("uv"), "uv is required for the kernel environments")
class AttachedPartTests(unittest.TestCase):
    """An --attach part 1 mm from its parent floats with no movable joint to excuse it (CadQuery only)."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        cls.hw = two_part_project(Path(cls.tmp.name), "cadquery")
        set_arm(cls.hw, "cadquery")
        # The arm template at z0 -6: a plate z -6..-1 under the base block (z 0..20), a 1 mm gap.
        set_model(cls.hw, "TST-0003", "cadquery", "arm.py", {**ARM, "z0": -6.0}, "Spacer plate", "PETG")
        cls.built = cli("run", str(cls.hw), "--label", "v1", "--attach", "TST-0003=TST-0001")
        cls.checked = cli("check", "v1", "--hw", str(cls.hw))

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def test_attached_part_floating_from_its_parent_fails_connection(self) -> None:
        self.assertEqual(self.built[0].returncode, 0, self.built[0].stderr[-3000:])
        manifest = json.loads((self.hw / "versions" / "v1" / "manifest.json").read_text(encoding="utf-8"))
        self.assertIn({"pair": ["TST-0001", "TST-0003"], "joint": "attach:TST-0003", "type": "fixed"},
                      manifest["joint_pairs"])
        proc, result, _ = self.checked
        self.assertEqual(proc.returncode, 1, proc.stderr[-2000:])
        self.assertEqual(result["blocking_failures"], ["connection"])
        rows = result["checks"]["connection"]["parts"]
        spacer = rows["TST-0003"]
        self.assertEqual((spacer["status"], spacer["nearest"], spacer["joint"], spacer["ok"]),
                         ("floating", "TST-0001", None, False))
        self.assertAlmostEqual(spacer["distance_mm"], 1.0, places=6)
        self.assertEqual((rows["TST-0002"]["status"], rows["TST-0002"]["ok"]), ("touching", True))
        attached = result["checks"]["connection"]["fixed_joints"]
        self.assertEqual([(f["joint"], f["ok"]) for f in attached], [("attach:TST-0003", False)])
        self.assertAlmostEqual(attached[0]["distance_mm"], 1.0, places=6)

    def test_model_folder_without_a_pn_name_is_a_contract_finding(self) -> None:
        stray = self.hw / "parts" / "spare_bracket"
        stray.mkdir()
        shutil.copy(self.hw / "parts" / "TST-0001" / "model.py", stray / "model.py")
        try:
            proc, result, _ = cli("run", str(self.hw), "--label", "v2", "--attach", "TST-0003=TST-0001")
        finally:
            shutil.rmtree(stray)
        self.assertEqual(proc.returncode, 1, proc.stderr[-2000:])
        self.assertEqual([(f["pn"], f["check"], f["type"], f["where"]) for f in result["findings"]],
                         [("spare_bracket", "contract", "ContractError", None)])
        self.assertEqual(result["findings"][0].keys(), FINDING_KEYS)
        self.assertFalse((self.hw / "versions" / "v2").exists())


@unittest.skipUnless(shutil.which("uv"), "uv is required for the kernel environments")
class CheckPairCacheTests(unittest.TestCase):
    """check through cad-motion's pair cache: base, arm and attached spacer, then a v2 that changes
    only the arm (CadQuery only)."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        cls.hw = two_part_project(Path(cls.tmp.name), "cadquery")
        set_arm(cls.hw, "cadquery")
        set_model(cls.hw, "TST-0003", "cadquery", "arm.py", {**ARM, "z0": -6.0}, "Spacer plate", "PETG")
        cls.built = [cli("run", str(cls.hw), "--label", "v1", "--attach", "TST-0003=TST-0001")]
        set_arm(cls.hw, "cadquery", length=80.0)
        cls.built.append(cli("run", str(cls.hw), "--label", "v2", "--attach", "TST-0003=TST-0001"))
        cache = str(Path(cls.tmp.name) / "cache")
        cls.checks = {name: cli("check", label, "--hw", str(cls.hw), *option)[1] for name, label, option in (
            ("v1 no cache", "v1", ["--no-cache"]), ("v1 cold", "v1", ["--cache", cache]),
            ("v1 warm", "v1", ["--cache", cache]), ("v2 seeded", "v2", ["--cache", cache]),
            ("v2 no cache", "v2", ["--no-cache"]))}

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def kept(self, name: str) -> dict:
        return {k: v for k, v in self.checks[name].items() if k != "timings_s"}

    def counts(self, name: str) -> tuple[int, int]:
        timings = self.checks[name]["timings_s"]
        return timings["pair_evaluations"], timings["disk_hits"]

    def test_a_cold_and_a_warm_cache_report_what_no_cache_does(self) -> None:
        for proc, result, _ in self.built:
            self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        self.assertEqual(self.kept("v1 cold"), self.kept("v1 no cache"))
        self.assertEqual(self.kept("v1 warm"), self.kept("v1 no cache"))
        self.assertEqual((self.counts("v1 cold"), self.counts("v1 warm")), ((3, 0), (0, 3)))

    def test_the_next_version_measures_only_the_pairs_of_its_changed_part(self) -> None:
        self.assertEqual(self.kept("v2 seeded"), self.kept("v2 no cache"))
        self.assertEqual(self.counts("v2 seeded"), (2, 1))


BASE, ARM_PN, PIN = "TST-0001", "TST-0002", "TST-0003"


def joints(*specs: tuple[str, str, str, str]) -> list[dict]:
    """manifest.json `joint_pairs` entries from (joint id, type, parent, child)."""
    return [{"pair": sorted([a, b]), "joint": jid, "type": kind} for jid, kind, a, b in specs]


def gaps(pairs: dict[tuple[str, str], float | None]) -> dict:
    """check's pair geometry from clearances; no shared volume, none measured where the gap is None."""
    return {pair: {"clearance_mm": gap, "interference_mm3": None if gap is None else 0.0} for pair, gap in pairs.items()}


INSERT = "TST-0003"
# One part-local insert placed six times around the base block (x/y -20..20, z 0..20), each held to it
# by a fixed joint. The insert is the base template at size 4, height 4, bore 1: a block x/y -2..2,
# z 0..4, bored through along Z. Each entry: translation_mm, rotation (None for none).
INSERTS = {
    "ins-1": ([10, 10, 18], None),    # 2 mm into the base top: the one declared press fit
    "ins-2": ([-10, 10, 18], None),   # the same overlap, with no fit declared
    "ins-3": ([10, -10, 20], None),   # on the base top ...
    "ins-4": ([11, -10, 20], None),   # ... sharing x 9..12 with ins-3
    "ins-5": ([-10, -10, 22], {"axis": [1, 0, 0], "angle_deg": 90}),  # turned about +X: y -14..-10, z 20..24
    "ins-6": ([0, 22, 8], None),      # against the base's +Y side
}
INSERT_V = 4 * 4 * 4 - math.pi * 0.25 * 4
PRESSED_V = 4 * 4 * 2 - math.pi * 0.25 * 2      # an insert 2 mm into the base, less its own bore
STACKED_V = 3 * 4 * 4 - 2 * math.pi * 0.25 * 4  # ins-3 and ins-4 over x 9..12, less both bores


def insert_project(root: Path) -> Path:
    """The base block and the six INSERTS, with a press fit declared on `@ins-1` only (CadQuery)."""
    hw = root / "inserts" / "hw"
    hw.mkdir(parents=True)
    (hw / "product.yaml").write_text("id: inserts\n", encoding="utf-8")
    occurrences = "".join(
        f"  - {{id: {oid}, PN: {INSERT}, placement: {{translation_mm: {move}"
        + (f", rotation: {{axis: {turn['axis']}, angle_deg: {turn['angle_deg']}}}" if turn else "") + "}}\n"
        for oid, (move, turn) in INSERTS.items())
    members = ", ".join(f'"@{oid}"' for oid in INSERTS)
    fixed = "".join(f'  - {{id: J-00{n}, type: fixed, parent: {BASE}, child: "@{oid}", axis: [0, 0, 1], '
                    f"origin: [0, 0, 0], min: 0, max: 0, nominal: 0}}\n" for n, oid in enumerate(INSERTS, start=1))
    (hw / "assembly.yaml").write_text(
        f"occurrences:\n{occurrences}subassemblies:\n  - {{id: frame, title: Base and inserts, parts: [{BASE}], "
        f"occurrences: [{members}]}}\njoints:\n{fixed}", encoding="utf-8")
    (hw / "interfaces.yaml").write_text(
        f'interfaces:\n  - id: IF-001\n    limits:\n      press_fit: {{fit: 5 H7/p6, pair: [{BASE}, "@ins-1"]}}\n',
        encoding="utf-8")
    set_model(hw, BASE, "cadquery", "base.py", {"size": 40.0, "height": 20.0, "bore": 6.0}, *PARTS[BASE][:2])
    set_model(hw, INSERT, "cadquery", "base.py", {"size": 4.0, "height": 4.0, "bore": 1.0}, "Insert", "PETG")
    with (hw / "parts" / INSERT / "part.yaml").open("a", encoding="utf-8") as part:
        part.write("model_frame: part_local\n")
    return hw


@unittest.skipUnless(shutil.which("uv"), "uv is required for the kernel environments")
class OccurrenceBuildTests(unittest.TestCase):
    """One part-local PN placed six times: one definition, six placed instances (CadQuery only)."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        cls.hw = insert_project(Path(cls.tmp.name))
        cls.folder = cls.hw / "versions" / "v1"
        cls.built = cli("run", str(cls.hw), "--label", "v1")
        cls.checked = cli("check", "v1", "--hw", str(cls.hw))

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def setUp(self) -> None:
        self.assertEqual(self.built[0].returncode, 0, self.built[0].stderr[-3000:])

    def version_json(self, name: str) -> dict:
        return json.loads((self.folder / name).read_text(encoding="utf-8"))

    def pair_rows(self) -> dict[tuple[str, ...], dict]:
        interference = self.checked[1]["checks"]["interference"]
        return {tuple(row["pair"]): row for row in interference["pairs"] + interference["joint_pairs"]}

    def test_assembly_step_has_one_definition_and_one_component_per_occurrence(self) -> None:
        readback = self.checked[1]["checks"]["step_readback"]
        self.assertEqual(readback["status"], "pass", json.dumps(readback, indent=1)[:3000])
        self.assertEqual((readback["definitions"], readback["components"], readback["unbound_components"],
                          readback["missing_occurrences"]), (2, 7, [], []))
        self.assertEqual(readback["occurrences"]["ins-5"]["component"], f"{INSERT} Insert [@ins-5]")
        self.assertEqual(self.version_json("manifest.json")["parts"][INSERT]["occurrences"], list(INSERTS))

    def test_check_measures_every_occurrence_pair_including_same_pn_pairs(self) -> None:
        rows = self.pair_rows()
        self.assertEqual(set(rows), set(itertools.combinations(sorted([BASE, *INSERTS]), 2)))  # 21, 15 same-PN
        stacked = rows[("ins-3", "ins-4")]
        self.assertEqual((stacked["refs"], stacked["interferes"], stacked["allowed"], stacked["ok"]),
                         (["@ins-3", "@ins-4"], True, False, False))
        self.assertAlmostEqual(stacked["interference_mm3"], STACKED_V, places=3)

    def test_a_fit_declared_on_one_insert_does_not_excuse_the_other(self) -> None:
        proc, result, _ = self.checked
        rows = self.pair_rows()
        declared, undeclared = rows[(BASE, "ins-1")], rows[(BASE, "ins-2")]
        self.assertEqual((declared["interferes"], declared["allowed"], declared["ok"]), (True, True, True))
        self.assertEqual((undeclared["interferes"], undeclared["allowed"], undeclared["ok"]), (True, False, False))
        for row in (declared, undeclared):
            self.assertAlmostEqual(row["interference_mm3"], PRESSED_V, places=3)
        self.assertEqual([item["pair"] for item in result["checks"]["interference"]["declared_pairs"]],
                         [[BASE, "ins-1"]])
        self.assertEqual(sorted(pair for pair, row in rows.items() if not row["ok"]),
                         [(BASE, "ins-2"), ("ins-3", "ins-4")])
        self.assertEqual((proc.returncode, result["blocking_failures"]), (1, ["interference"]), proc.stderr[-2000:])

    def test_one_glb_definition_is_two_nodes_and_the_second_resolves_to_its_own(self) -> None:
        part_map = self.version_json("part-map.json")
        gltf = mesh.gltf_json(self.folder / "assembly.glb")
        first, second = (part_map["occurrences"][oid] for oid in ("ins-1", "ins-2"))
        self.assertEqual((first["nodes"], second["nodes"]),
                         ([f"{INSERT} Insert [@ins-1]"], [f"{INSERT} Insert [@ins-2]"]))
        self.assertEqual((first["meshes"], second["meshes"]), ([f"{INSERT} Insert"], [f"{INSERT} Insert"]))
        self.assertNotEqual(first["node_indices"], second["node_indices"])
        one, two = (gltf["nodes"][entry["node_indices"][0]] for entry in (first, second))
        self.assertEqual(two["name"], f"{INSERT} Insert [@ins-2]")
        positions = [gltf["meshes"][node["mesh"]]["primitives"][0]["attributes"]["POSITION"] for node in (one, two)]
        self.assertEqual(positions[0], positions[1])  # one definition's triangles, instanced by both nodes
        # @ins-2 sits at (-10, 10, 18) mm, Z up; the GLB is in metres, Y up: (x, z, -y) / 1000.
        assert_vectors(self, two["translation"], [-0.010, 0.018, -0.010], places=9)
        self.assertEqual(part_map["parts"][INSERT]["occurrences"], sorted(INSERTS))

    def test_metrics_keep_the_unit_definition_and_place_each_instance(self) -> None:
        metrics = self.version_json("metrics.json")
        unit = metrics["parts"][INSERT]
        self.assertEqual(unit["model_frame"], "part_local")
        self.assertAlmostEqual(unit["volume_mm3"], INSERT_V, places=4)
        assert_same_holes(self, unit["holes"], [{"id": "H1", "diameter_mm": 1.0, "axis": [0.0, 0.0, -1.0],
                                                 "position": [0.0, 0.0, 4.0], "depth_mm": 4.0, "through": True}], 6)
        totals = metrics["totals"]
        self.assertEqual(totals["quantity"], {BASE: 1, INSERT: 6})
        self.assertAlmostEqual(totals["volume_mm3"], BASE_V + 6 * INSERT_V, places=3)
        self.assertAlmostEqual(totals["mass_g"], metrics["parts"][BASE]["mass_g"] + 6 * unit["mass_g"], places=6)
        # ins-5: Rx(90) takes (x, y, z) to (x, -z, y), then moves by (-10, -10, 22).
        turned = metrics["occurrences"]["ins-5"]
        assert_vectors(self, turned["bbox_mm"]["min"], [-12.0, -14.0, 20.0], places=6)
        assert_vectors(self, turned["bbox_mm"]["max"], [-8.0, -10.0, 24.0], places=6)
        assert_same_holes(self, turned["holes"], [{"id": "H1", "diameter_mm": 1.0, "axis": [0.0, 1.0, 0.0],
                                                   "position": [-10.0, -14.0, 22.0], "depth_mm": 4.0,
                                                   "through": True}], 6)
        assert_vectors(self, metrics["occurrences"]["ins-2"]["bbox_mm"]["min"], [-12.0, 8.0, 18.0], places=6)

    def test_bom_rolls_the_six_instances_into_one_row_of_quantity_six(self) -> None:
        out = self.hw.parent / ".cad-work" / "test" / "bom.csv"  # bom.py accepts an explicit --out only there
        proc = subprocess.run(["uv", "run", "--quiet", "--script", str(BOM_SCRIPT), str(self.folder / "assembly.step"),
                               "--hw", str(self.hw), "--out", str(out)], capture_output=True, text=True, check=False)
        self.assertEqual(proc.returncode, 0, proc.stdout[-2000:] + proc.stderr[-2000:])
        with out.open(encoding="utf-8", newline="") as handle:
            rows = list(csv.DictReader(handle))
        self.assertEqual({row["PN"]: row["qty"] for row in rows}, {BASE: "1", INSERT: "6"})


@unittest.skipUnless(shutil.which("uv"), "uv is required for the kernel environments")
class PairClearanceBuildTests(unittest.TestCase):
    """The swing arm built 0.8 mm above the base, on its revolute joint, against a clearance
    requirement on that joint-connected pair (CadQuery only)."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        cls.hw = two_part_project(Path(cls.tmp.name), "cadquery")
        set_arm(cls.hw, "cadquery", z0=20.8)  # the plate's underside 0.8 mm above the base top at z 20
        cls.built = cli("run", str(cls.hw), "--label", "v1")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def checked(self, minimum: float) -> tuple[subprocess.CompletedProcess[str], dict]:
        self.assertEqual(self.built[0].returncode, 0, self.built[0].stderr[-3000:])
        (self.hw / "interfaces.yaml").write_text(
            "interfaces:\n  - {id: IF-001, from: arm, to: base, type: clearance, description: The arm clears the base.,"
            f" pair: [{ARM_PN}, {BASE}], min_clearance_mm: {minimum}}}\n", encoding="utf-8")
        proc, result, _ = cli("check", "v1", "--hw", str(self.hw))
        return proc, result

    def test_a_requirement_above_the_gap_blocks_and_one_below_it_passes(self) -> None:
        proc, result = self.checked(1.0)
        self.assertEqual(proc.returncode, 1, proc.stderr[-2000:])
        self.assertEqual(result["blocking_failures"], ["pair_clearance"])
        # J-001 joins the pair, so interference lists it as a joint pair; the requirement holds all the same.
        self.assertEqual([row["pair"] for row in result["checks"]["interference"]["joint_pairs"]], [[BASE, ARM_PN]])
        (row,) = result["checks"]["pair_clearance"]["requirements"]
        self.assertEqual({key: row[key] for key in ("pair", "refs", "required_mm", "status", "interface", "source")},
                         {"pair": [BASE, ARM_PN], "refs": [BASE, ARM_PN], "required_mm": 1.0, "status": "fail",
                          "interface": "IF-001", "source": "interfaces.yaml#/interfaces/0"})
        self.assertAlmostEqual(row["clearance_mm"], 0.8, places=6)

        proc, result = self.checked(0.5)
        self.assertEqual(proc.returncode, 0, json.dumps(result.get("checks"), indent=1)[:4000] + proc.stderr[-2000:])
        (row,) = result["checks"]["pair_clearance"]["requirements"]
        self.assertEqual((result["checks"]["pair_clearance"]["status"], row["status"], row["required_mm"]),
                         ("pass", "pass", 0.5))
        self.assertAlmostEqual(row["clearance_mm"], 0.8, places=6)


class BoxPart:
    """A test double for a box-shaped part: `extents` along the unit `axes` (rows, in the model frame).

    `measured` patches the OCP measurements cadmodel.orientation takes (the model box, the oriented
    box, and the box after a rotation) with the exact values for this box."""

    def __init__(self, extents: tuple[float, float, float], axes=orientation.IDENTITY) -> None:
        self.extents, self.axes = extents, axes

    def box(self, rotation=orientation.IDENTITY) -> tuple[tuple[float, ...], tuple[float, ...]]:
        size = [sum(e * abs(sum(rotation[i][j] * a[j] for j in range(3))) for e, a in zip(self.extents, self.axes))
                for i in range(3)]
        return tuple(-s / 2 for s in size), tuple(s / 2 for s in size)

    def measured(self, oriented: bool = True) -> contextlib.ExitStack:
        stack = contextlib.ExitStack()
        stack.enter_context(mock.patch.object(occ, "bbox", side_effect=lambda shape: self.box()))
        stack.enter_context(mock.patch.object(orientation, "turned_box", side_effect=lambda shape, rot: self.box(rot)))
        stack.enter_context(mock.patch.object(occ, "oriented_bbox", return_value=(self.extents, self.axes))
                            if oriented else
                            mock.patch.object(occ, "oriented_bbox", side_effect=AssertionError("fallback should not run")))
        return stack


def fdm_record(tmp: str, build_volume: str) -> Path:
    hw = Path(tmp)
    (hw / "parts" / "TST-0001").mkdir(parents=True)
    (hw / "product.yaml").write_text(build_volume, encoding="utf-8")
    (hw / "parts" / "TST-0001" / "part.yaml").write_text("process: fdm\n", encoding="utf-8")
    return hw


class CheckRuleTests(unittest.TestCase):
    """check's verdicts on given measurements; needs no OCP."""
    def test_build_volume_accepts_axis_permutation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            hw = fdm_record(tmp, "build_volume: {x_mm: 35, y_mm: 10, z_mm: 5, margin_mm: 0}\n")
            with BoxPart((35.0, 10.0, 5.0)).measured(oriented=False):
                result = check.build_volume(hw, {"TST-0001": mock.Mock(shape=mock.Mock())})
        self.assertEqual(result["status"], "pass")
        row = result["parts"]["TST-0001"]
        self.assertEqual((row["orientation"], row["method"], row["size_mm"]),
                         ("xyz", "axis_aligned", [35.0, 10.0, 5.0]))

    def test_build_volume_chooses_lowest_print_height(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            hw = fdm_record(tmp, "build_volume: {x_mm: 35, y_mm: 20, z_mm: 10, margin_mm: 0}\n")
            with BoxPart((35.0, 10.0, 20.0)).measured(oriented=False):
                result = check.build_volume(hw, {"TST-0001": mock.Mock(shape=mock.Mock())})
        row = result["parts"]["TST-0001"]
        self.assertEqual((row["orientation"], row["size_mm"]), ("xzy", [35.0, 20.0, 10.0]))
        self.assertEqual(row["rotation"], [[-1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]])
        self.assertEqual(row["determinant"], 1.0)

    def test_build_volume_falls_back_for_rotated_plate(self) -> None:
        half = math.sqrt(0.5)
        with tempfile.TemporaryDirectory() as tmp:
            hw = fdm_record(tmp, "build_volume: {x_mm: 256, y_mm: 256, z_mm: 256, margin_mm: 5}\n")
            with BoxPart((240.0, 240.0, 5.0), ((half, half, 0.0), (-half, half, 0.0), (0.0, 0.0, 1.0))).measured():
                result = check.build_volume(hw, {"TST-0001": mock.Mock(shape=mock.Mock())})
        row = result["parts"]["TST-0001"]
        self.assertEqual((result["status"], row["orientation"], row["method"]), ("pass", "oriented", "oriented"))
        self.assertEqual(row["size_mm"], [240.0, 240.0, 5.0])
        self.assertEqual(row["axes"][2], [0.0, 0.0, 1.0])
        self.assertAlmostEqual(row["determinant"], 1.0, places=12)

    def test_build_volume_fails_if_aabb_and_oriented_box_do_not_fit(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            hw = fdm_record(tmp, "build_volume: {x_mm: 256, y_mm: 256, z_mm: 256, margin_mm: 5}\n")
            with BoxPart((300.0, 20.0, 20.0)).measured():
                result = check.build_volume(hw, {"TST-0001": mock.Mock(shape=mock.Mock())})
        self.assertEqual((result["status"], result["blocking_failures"]), ("fail", ["TST-0001"]))
        message = result["parts"]["TST-0001"]["message"]
        self.assertIn("TST-0001", message)
        self.assertIn("(300.0, 20.0, 20.0)", message)
        self.assertIn("oriented box", message)

    def test_build_volume_warns_when_not_declared(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            hw = fdm_record(tmp, "id: test\n")
            result = check.build_volume(hw, {"TST-0001": mock.Mock(shape=mock.Mock())})
        self.assertEqual((result["status"], result["blocking"]), ("warn", False))
        self.assertIn("TST-0001", result["parts"])

    def test_missing_interfaces_file_means_no_declared_fits(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(check.declared_press_fits(Path(tmp)), [])
    def test_malformed_interfaces_remains_a_usage_finding(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            hw = Path(tmp)
            (hw / "interfaces.yaml").write_text("interfaces: [\n", encoding="utf-8")
            with self.assertRaisesRegex(build.UsageError, "cannot read interfaces"):
                check.declared_press_fits(hw)



    def test_declared_interference_fit_allows_overlap_and_reports_source(self) -> None:
        pair = (BASE, ARM_PN)
        declared = [{"pair": list(pair), "fit": "5 H7/p6", "classification": "interference",
                     "interface": "IF-001", "source": "interfaces.yaml#/interfaces/0/limits/press_fit"}]
        geometry = {pair: {"clearance_mm": -0.01, "interference_mm3": 0.1}}
        with mock.patch.object(check, "load_pose", return_value=mock.Mock(INTERFERENCE_MM3=0.001)):
            result = check.interference(geometry, None, set(), set(), declared)
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["declared_pairs"], declared)
        self.assertTrue(result["pairs"][0]["allowed"])

    def test_undeclared_overlap_still_fails(self) -> None:
        geometry = {(BASE, ARM_PN): {"clearance_mm": -0.01, "interference_mm3": 0.1}}
        with mock.patch.object(check, "load_pose", return_value=mock.Mock(INTERFERENCE_MM3=0.001)):
            result = check.interference(geometry, None, set(), set())
        self.assertEqual((result["status"], result["pairs"][0]["ok"]), ("fail", False))

    def test_declared_interference_fit_with_clearance_is_a_finding(self) -> None:
        pair = (BASE, ARM_PN)
        declared = [{"pair": list(pair), "fit": "5 H7/p6", "classification": "interference",
                     "interface": "IF-001", "source": "interfaces.yaml#/interfaces/0/limits/press_fit"}]
        geometry = {pair: {"clearance_mm": 0.01, "interference_mm3": 0.0}}
        with mock.patch.object(check, "load_pose", return_value=mock.Mock(INTERFERENCE_MM3=0.001)):
            result = check.interference(geometry, None, set(), set(), declared)
        self.assertEqual(result["status"], "fail")
        self.assertEqual(result["declared_fit_findings"][0]["type"], "declared_fit_not_realized")
        self.assertEqual(result["declared_fit_findings"][0]["source"], declared[0]["source"])

    @staticmethod
    def requirement(pair: tuple[str, str], minimum: float) -> dict:
        return {"pair": list(pair), "min_clearance_mm": minimum, "interface": "IF-002",
                "source": "interfaces.yaml#/interfaces/1"}

    def test_a_pair_requirement_fails_above_the_measured_clearance_and_passes_at_or_below_it(self) -> None:
        geometry = gaps({(BASE, ARM_PN): 0.8})
        for minimum, status in ((1.0, "fail"), (0.8, "pass"), (0.5, "pass")):
            with self.subTest(minimum=minimum):
                result = check.pair_clearance(geometry, [self.requirement((BASE, ARM_PN), minimum)], {ARM_PN: "@arm"})
                self.assertEqual((result["status"], result["blocking"]), (status, True))
                self.assertEqual(result["requirements"], [
                    {"pair": [BASE, ARM_PN], "refs": [BASE, "@arm"], "required_mm": minimum, "clearance_mm": 0.8,
                     "status": status, "interface": "IF-002", "source": "interfaces.yaml#/interfaces/1"}])

    def test_a_pair_requirement_compares_the_unrounded_clearance(self) -> None:
        result = check.pair_clearance(gaps({(BASE, ARM_PN): 0.79996}), [self.requirement((BASE, ARM_PN), 0.8)])
        self.assertEqual(result["status"], "fail")

    def test_an_unmeasured_or_absent_pair_fails_its_requirement(self) -> None:
        geometry = gaps({(BASE, ARM_PN): None})
        geometry[(BASE, ARM_PN)]["error"] = "Standard_Failure"
        result = check.pair_clearance(geometry, [self.requirement((BASE, ARM_PN), 0.5), self.requirement((BASE, PIN), 0.5)])
        self.assertEqual(result["status"], "fail")
        self.assertEqual([(row["status"], row.get("error")) for row in result["requirements"]],
                         [("fail", "Standard_Failure"), ("fail", "the version has no such occurrence pair")])
        self.assertEqual(check.pair_clearance(geometry, [])["status"], "pass")

    def test_a_clearance_requirement_record_resolves_through_the_pair_policy(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            hw = Path(tmp)
            path = hw / "interfaces.yaml"
            requirement = ("interfaces:\n  - {id: IF-001, from: arm, to: base, type: clearance, description: Gap.,"
                           " pair: [%s, %s], min_clearance_mm: %s}\n")
            path.write_text(requirement % (ARM_PN, BASE, 0.5), encoding="utf-8")
            self.assertEqual(check.declared_clearances(hw), [{"pair": [BASE, ARM_PN], "min_clearance_mm": 0.5,
                                                              "interface": "IF-001",
                                                              "source": "interfaces.yaml#/interfaces/0"}])
            path.write_text(requirement % (ARM_PN, BASE, 0), encoding="utf-8")
            with self.assertRaisesRegex(build.UsageError, "a clearance requirement needs"):
                check.declared_clearances(hw)
            path.write_text(requirement % ('"@arm-a"', BASE, 0.5), encoding="utf-8")
            with self.assertRaisesRegex(build.UsageError, "no assembly record"):
                check.declared_clearances(hw)

    def test_press_fit_record_is_classified_by_cad_fits(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            hw = Path(tmp)
            (hw / "interfaces.yaml").write_text(
                "interfaces:\n"
                "  - id: IF-001\n"
                "    limits:\n"
                "      press_fit: {fit: 5 H7/p6, pair: [TST-0001, TST-0002]}\n",
                encoding="utf-8",
            )
            declared = check.declared_press_fits(hw)
        self.assertEqual(declared, [{"pair": [BASE, ARM_PN], "fit": "5 H7/p6", "classification": "interference",
                                    "interface": "IF-001",
                                    "source": "interfaces.yaml#/interfaces/0/limits/press_fit"}])

    def test_template_press_pairs_are_declared_and_classified(self) -> None:
        template = HERE.parents[2] / "examples" / "lamp-arm" / "hw"
        declared = check.declared_press_fits(template)
        self.assertEqual({tuple(item["pair"]) for item in declared}, {
            ("LMP-0002", "LMP-0005"), ("LMP-0002", "LMP-0006"), ("LMP-0003", "LMP-0007")})
        self.assertTrue(all(item["classification"] == "interference" for item in declared))

    def test_an_installed_plugin_copy_classifies_press_fits_with_its_own_cad_fits(self) -> None:
        """The plugin runs from OMP's cache or a --plugin-dir, where nothing above it is this repository."""
        with tempfile.TemporaryDirectory() as tmp:
            plugin = Path(tmp) / "cache" / "srobroek-omp___cad___0.0.0"  # never named `cad`, unlike the repository's
            shutil.copytree(HERE.parents[2], plugin, ignore=shutil.ignore_patterns("__pycache__"))
            hw = Path(tmp) / "hw"
            hw.mkdir()
            (hw / "interfaces.yaml").write_text(
                "interfaces:\n  - id: IF-001\n    limits:\n      press_fit: {fit: 5 H7/p6, pair: [TST-0001, TST-0002]}\n",
                encoding="utf-8")
            probe = ("import json, sys\nfrom pathlib import Path\nfrom cadmodel import check\n"
                     "print(json.dumps({'fits': str(check.load_pair_policy().FITS_SCRIPT), "
                     "'declared': check.declared_press_fits(Path(sys.argv[1]))}))\n")
            scripts = plugin / "skills" / "cad-model" / "scripts"
            proc = subprocess.run([sys.executable, "-c", probe, str(hw)], cwd=scripts, capture_output=True, text=True,
                                  check=False, timeout=60, env={**os.environ, "PYTHONPATH": str(scripts)})
            self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
            result = json.loads(proc.stdout)
            self.assertTrue(Path(result["fits"]).is_relative_to(plugin.resolve()), result["fits"])
        self.assertEqual([(item["pair"], item["classification"]) for item in result["declared"]],
                         [([BASE, ARM_PN], "interference")])

    def test_an_allowed_pair_whose_measurement_failed_still_fails(self) -> None:
        geometry = gaps({(BASE, ARM_PN): None})
        geometry[(BASE, ARM_PN)]["error"] = "Standard_Failure"
        result = check.interference(geometry, None, set(), {(BASE, ARM_PN)})
        self.assertEqual((result["status"], result["pairs"][0]["ok"]), ("fail", False))

    def test_a_declared_fit_naming_an_unknown_part_fails(self) -> None:
        result = check.interference(gaps({(BASE, ARM_PN): 0.0}), None, set(), {(BASE, "TST-0009")})
        self.assertEqual((result["status"], result["unknown_allowed"]), ("fail", [[BASE, "TST-0009"]]))

    def test_expected_solids_naming_an_unknown_part_fails(self) -> None:
        result = check.solid_structure({}, {"TST-0009": 1}, None, None)
        self.assertEqual((result["status"], result["unknown_parts"]), ("fail", ["TST-0009"]))

    def test_a_float_across_a_movable_joint_is_its_clearance(self) -> None:
        result = check.connection(gaps({(BASE, ARM_PN): 0.1}), [BASE, ARM_PN],
                                  joints(("J-001", "revolute", BASE, ARM_PN)))
        row = result["parts"][ARM_PN]
        self.assertEqual((result["status"], row["status"], row["joint"]), ("pass", "floating", "J-001"))

    def test_a_float_to_a_rigidly_attached_parent_fails(self) -> None:
        result = check.connection(gaps({(BASE, ARM_PN): 0.0, (BASE, PIN): 1.0, (ARM_PN, PIN): 5.0}),
                                  [BASE, ARM_PN, PIN],
                                  joints(("J-001", "revolute", BASE, ARM_PN), (f"attach:{PIN}", "fixed", BASE, PIN)))
        row = result["parts"][PIN]
        self.assertEqual((result["status"], row["status"], row["joint"], row["ok"]), ("fail", "floating", None, False))

    def test_a_pin_fixed_in_the_parent_carries_the_joint_clearance(self) -> None:
        # The pin is pressed into the base; the arm turns on it with 0.1 mm clearance, 0.5 mm above the base.
        result = check.connection(gaps({(BASE, ARM_PN): 0.5, (BASE, PIN): 0.0, (ARM_PN, PIN): 0.1}),
                                  [BASE, ARM_PN, PIN],
                                  joints(("J-001", "revolute", BASE, ARM_PN), ("J-002", "fixed", BASE, PIN)))
        row = result["parts"][ARM_PN]
        self.assertEqual((result["status"], row["nearest"], row["joint"]), ("pass", PIN, "J-001"))

    def test_a_fixed_pin_with_clearance_in_its_parent_fails_though_it_floats_on_the_joint(self) -> None:
        # The record fixes the pin to the base, but it sits 0.108 mm clear of the base and 0.0125 mm in the arm.
        result = check.connection(gaps({(BASE, ARM_PN): 0.5, (BASE, PIN): 0.108, (ARM_PN, PIN): 0.0125}),
                                  [BASE, ARM_PN, PIN],
                                  joints(("J-001", "revolute", BASE, ARM_PN), ("J-002", "fixed", BASE, PIN)))
        self.assertEqual((result["parts"][PIN]["joint"], result["parts"][PIN]["ok"]), ("J-001", True))
        self.assertEqual([(f["joint"], f["ok"]) for f in result["fixed_joints"]], [("J-002", False)])
        self.assertEqual(result["status"], "fail")


class OrientationRuleTests(unittest.TestCase):
    """cadmodel.orientation: one proper rotation per fit, measured after it is applied; needs no OCP."""

    def test_every_permutation_is_a_proper_rotation_onto_its_named_axes(self) -> None:
        for name in orientation.ORIENTATIONS:
            with self.subTest(orientation=name):
                rotation = orientation.permutation_rotation(name)
                self.assertEqual(orientation.determinant(rotation), 1.0)
                self.assertTrue(orientation.is_proper(rotation))
                self.assertEqual([abs(rotation[i]["xyz".index(axis)]) for i, axis in enumerate(name)], [1.0] * 3)

    def test_a_mirror_a_scale_or_a_shear_is_not_proper(self) -> None:
        for rows in (((-1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)),
                     ((2.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)),
                     ((1.0, 0.1, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))):
            self.assertFalse(orientation.is_proper(rows), rows)

    def test_an_asymmetric_volume_takes_the_oriented_box_axes_in_the_order_that_fits(self) -> None:
        """The tall axis of a tilted plate fits only along printer X; testing its oriented-box extents in
        their own order and then lowering the height would have claimed a fit 280 mm deep in Y."""
        a2 = tuple(v / math.sqrt(3) for v in (1.0, 1.0, 1.0))
        a0 = tuple(v / math.sqrt(2) for v in (1.0, -1.0, 0.0))
        a1 = tuple(v / math.sqrt(6) for v in (1.0, 1.0, -2.0))
        part = BoxPart((10.0, 40.0, 280.0), (a0, a1, a2))
        volume = orientation.BuildVolume((300.0, 50.0, 300.0), 0.0, orientation.ORIENTATIONS)
        with part.measured():
            _, found, _ = orientation.fit(mock.Mock(), volume)
        self.assertEqual((found.method, found.orientation), ("oriented", "oriented"))
        assert_vectors(self, list(found.size_mm), [280.0, 40.0, 10.0], places=9)
        self.assertTrue(orientation.fits(found.size_mm, volume.usable_mm))
        self.assertTrue(orientation.is_proper(found.rotation))

    def test_a_declared_volume_reads_from_the_product_record(self) -> None:
        self.assertIsNone(orientation.BuildVolume.declared({"id": "x"}))
        volume = orientation.BuildVolume.declared({"build_volume": {"x_mm": 256, "y_mm": 200, "z_mm": 100,
                                                                    "margin_mm": 5, "orientations": ["xyz", "zyx"]}})
        self.assertEqual((volume.usable_mm, volume.orientations), ((246.0, 190.0, 90.0), ("xyz", "zyx")))
        with self.assertRaises(ValueError):
            orientation.BuildVolume.declared({"build_volume": {"x_mm": "wide", "y_mm": 1, "z_mm": 1}})


class ManufactureRuleTests(unittest.TestCase):
    """Which parts get manufacturing outputs and which declarations are refused; needs no OCP."""

    @staticmethod
    def part(pn: str, **fields) -> dict:
        return {"PN": pn, "rev": "X1", "title": "Part", "material": "PETG", "process": "fdm", "finish": "none",
                "mass_target": 1, "make_buy": "make", "supplier": None, **fields}

    def test_custom_made_parts_are_planned_and_catalogue_buys_are_not(self) -> None:
        records = {"TST-0001": self.part("TST-0001"),
                   "TST-0002": self.part("TST-0002", make_buy="buy", process="cnc",
                                         procurement={"mode": "made_to_drawing"}),
                   "TST-0003": self.part("TST-0003", make_buy="buy", process="purchased", procurement={"mode": "catalog"})}
        plans, refused = manufacture.plan(records)
        self.assertEqual((sorted(plans), refused), (["TST-0001", "TST-0002"], []))
        self.assertEqual(plans["TST-0001"].policy.outputs, ("part.step", "part.stl", "manufacturing.json"))
        self.assertEqual(plans["TST-0002"].policy.outputs, ("part.step", "manufacturing.json"))
        self.assertEqual((plans["TST-0001"].policy.relationship, plans["TST-0001"].policy.volume_tolerance_mm3(1000.0)),
                         ("same", 1000.0 * 1e-9))

    def test_a_different_state_needs_its_declaration_and_a_positive_tolerance(self) -> None:
        state = {"relationship": "different", "state": "flat", "reason": "elastic_bending", "decision": "DR-001"}
        records = {"TST-0001": self.part("TST-0001", manufacture=state),
                   "TST-0002": self.part("TST-0002", manufacture={**state, "decision": None, "volume_rel_tolerance": 1e-6}),
                   "TST-0003": self.part("TST-0003", manufacture={**state, "volume_rel_tolerance": 0.0}),
                   "TST-0004": self.part("TST-0004", manufacture={**state, "volume_abs_tolerance_mm3": 0.5})}
        plans, refused = manufacture.plan(records)
        self.assertEqual(sorted(plans), ["TST-0004"])
        reasons = dict(refused)
        self.assertIn("without a volume tolerance", reasons["TST-0001"])
        self.assertIn("also needs decision", reasons["TST-0002"])
        self.assertIn("tolerance refused", reasons["TST-0003"])
        self.assertEqual(plans["TST-0004"].policy.volume_tolerance_mm3(100.0), 0.5)

    def test_diff_names_a_manufacturing_only_change(self) -> None:
        entry = {"state": {"relationship": "different", "name": "flat"}, "tolerance": {"volume_rel": 1e-6, "volume_abs_mm3": 0.0},
                 "mesh": {"linear_deflection_mm": 0.05}, "build_volume": None,
                 "native": {"kernel_volume_mm3": 100.0, "kernel_solids": 1},
                 "placement": {"method": "axis_aligned", "orientation": "xzy", "transform": [[1.0, 0.0, 0.0, 0.0]] * 3}}
        looser = {**entry, "tolerance": {"volume_rel": 2e-6, "volume_abs_mm3": 0.0}}
        result = diff.compare_manufacturing({"TST-0001": entry, "TST-0002": entry}, {"TST-0001": looser, "TST-0003": entry})
        self.assertEqual(result["changed"], ["TST-0001", "TST-0002", "TST-0003"])
        self.assertEqual(result["parts"]["TST-0001"]["changed"], ["tolerance"])
        self.assertEqual((result["parts"]["TST-0002"]["status"], result["parts"]["TST-0003"]["status"]), ("removed", "added"))
        self.assertFalse(diff.compare_manufacturing(None, {})["available"])

    def test_latest_names_each_manufacturing_folder(self) -> None:
        manifest = {"parts": {"TST-0001": {"step": "parts/TST-0001.step"}},
                    "manufacturing": {"TST-0001": {"path": "manufacturing/TST-0001"}, "TST-0002": {"path": None}}}
        latest = build.latest_pointer("v3", manifest)
        self.assertEqual(latest["manufacturing"], {"TST-0001": "versions/v3/manufacturing/TST-0001"})
        self.assertEqual(latest["parts"], {"TST-0001": "versions/v3/parts/TST-0001.step"})


class VersionLabelTests(unittest.TestCase):
    def test_a_label_at_or_below_the_newest_version_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            hw = Path(tmp)
            (hw / "versions" / "v3").mkdir(parents=True)
            (hw / "versions" / "v3" / "manifest.json").write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(build.UsageError, "pick v4"):
                build.run(hw, "v2", "auto", [])


class DiffRuleTests(unittest.TestCase):
    def test_a_kernel_failure_is_an_error_not_a_change(self) -> None:
        metrics = {"volume_mm3": 100.0, "bbox_mm": {"min": [0.0] * 3, "max": [1.0] * 3, "size": [1.0] * 3}, "solids": 1}
        with mock.patch.object(occ, "occupied", side_effect=occ.GeometryError("occupied-volume partition failed")):
            row = diff.compare_part(metrics, metrics, object(), object())
        self.assertEqual((row["status"], row["a_only_mm3"]), ("error", None))
        self.assertIn("partition failed", row["error"])


FAKE_RUNNER = """# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
import atexit, json, pathlib, sys, time
request = json.load(sys.stdin)
part = request["parts"][0]
{body}
pathlib.Path(request["result"]).write_text(json.dumps({{"kernel": "fake", "tools": {{}}, "import_s": 0.0, "parts": {{}}}}))
"""
FAKE_BODIES = {
    "waits_for_peer": "deadline = time.monotonic() + 30\n"
                      "while not pathlib.Path(part['marker']).exists():\n"
                      "    if time.monotonic() > deadline:\n"
                      "        sys.exit(3)\n"
                      "    time.sleep(0.05)",
    "signals_peer": "pathlib.Path(part['marker']).touch()",
    "fails": "sys.exit(2)",
    "writes_late": "time.sleep(4)\npathlib.Path(part['step']).parent.mkdir(parents=True, exist_ok=True)\n"
                   "pathlib.Path(part['step']).write_text('late')",
    # OCCT's STEP-writer statistics on stdout, around a decoy JSON line, and an unterminated line at exit.
    "stdout_noise": "print('****** Statistics on Transfer (Write) ******')\n"
                    "print(json.dumps({'kernel': 'decoy', 'tools': {}, 'import_s': 0.0, 'parts': {}}))\n"
                    "atexit.register(sys.stdout.write, '****** Transfer Mode = 0  I.E.  As Is ******')",
    "exits_without_result": "sys.exit(0)",
}


@unittest.skipUnless(shutil.which("uv"), "uv is required to start the runners")
class RunnerLifecycleTests(unittest.TestCase):
    """`run_kernels` with stand-in runners: they run at once, a failure stops the others, and the
    result comes from the file the request names, whatever the runner prints."""

    def runners(self, root: Path, cadquery: str, build123d: str) -> dict[str, Path]:
        paths = {}
        for kernel, body in (("cadquery", cadquery), ("build123d", build123d)):
            paths[kernel] = root / f"{body}.py"
            paths[kernel].write_text(FAKE_RUNNER.format(body=FAKE_BODIES[body]), encoding="utf-8")
        return paths

    def test_each_runner_gets_its_request_without_waiting_for_the_other(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            marker = str(root / "build123d-started")
            with mock.patch.dict(build.RUNNERS, self.runners(root, "waits_for_peer", "signals_peer")):
                results = build.run_kernels({"cadquery": [{"pn": "TST-0001", "marker": marker}],
                                             "build123d": [{"pn": "TST-0002", "marker": marker}]})
        self.assertEqual(sorted(results), ["build123d", "cadquery"])

    def test_a_failed_runner_stops_the_other_before_it_writes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            late = root / ".v1.partial" / "parts" / "TST-0002.step"
            with mock.patch.dict(build.RUNNERS, self.runners(root, "fails", "writes_late")):
                started = time.monotonic()
                with self.assertRaisesRegex(build.UsageError, "cadquery runner exited 2"):
                    build.run_kernels({"cadquery": [{"pn": "TST-0001"}],
                                       "build123d": [{"pn": "TST-0002", "step": str(late)}]})
                self.assertLess(time.monotonic() - started, 4.0)
            time.sleep(6)
            self.assertFalse(late.parent.exists(), "the stopped runner recreated the partial folder")

    def test_the_result_file_is_immune_to_stray_stdout_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.dict(build.RUNNERS, self.runners(Path(tmp), "stdout_noise", "stdout_noise")):
                results = build.run_kernels({"cadquery": [{"pn": "TST-0001"}], "build123d": [{"pn": "TST-0002"}]})
        for kernel, result in results.items():
            with self.subTest(kernel=kernel):
                self.assertEqual(result["kernel"], "fake")
                self.assertIn("Transfer Mode = 0", result["console_tail"])

    def test_a_runner_that_exits_without_its_result_is_a_usage_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.dict(build.RUNNERS, self.runners(Path(tmp), "exits_without_result", "signals_peer")):
                with self.assertRaisesRegex(build.UsageError, "cadquery runner wrote no result"):
                    build.run_kernels({"cadquery": [{"pn": "TST-0001"}]})


@unittest.skipUnless(shutil.which("uv"), "uv is required for the trimesh environment")
class MeshWatertightTests(unittest.TestCase):
    """A sphere-pole triangle collapses when welded: it must neither fail a closed mesh nor close an open one."""

    def test_collapsed_triangles_are_dropped_and_holes_still_fail(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            proc = subprocess.run(["uv", "run", "--quiet", "--script", str(FIXTURES / "mesh_probe.py"), tmp],
                                  capture_output=True, text=True, check=False)
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        report = json.loads(proc.stdout)
        self.assertEqual((report["TST-0001"]["watertight"], report["TST-0001"]["collapsed_triangles"]), (True, 1))
        self.assertEqual((report["TST-0002"]["watertight"], report["TST-0002"]["collapsed_triangles"]), (False, 1))


@unittest.skipUnless(shutil.which("uv"), "uv is required for the OCP environment")
class HoleMetricsTests(unittest.TestCase):
    """Bores are read from the STEP read-back: a through and a blind hole are listed, a boss is not."""

    def test_through_and_blind_holes_are_listed_and_a_boss_is_not(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            proc = subprocess.run(["uv", "run", "--quiet", "--script", str(FIXTURES / "holes_probe.py"), tmp],
                                  capture_output=True, text=True, check=False)
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        report = json.loads(proc.stdout)
        assert_same_holes(self, report["TST-0001"], [
            {"id": "H1", "diameter_mm": 3.0, "axis": [0.0, 0.0, -1.0], "position": [30.0, 15.0, 8.0],
             "depth_mm": 4.0, "through": False},
            {"id": "H2", "diameter_mm": 5.0, "axis": [0.0, 0.0, -1.0], "position": [10.0, 15.0, 8.0],
             "depth_mm": 8.0, "through": True},
        ], places=6)
        self.assertEqual(report["TST-0002"], [])


@unittest.skipUnless(shutil.which("uv"), "uv is required for the OCP environment")
class ContainmentTests(unittest.TestCase):
    """A part buried in another, no faces touching, interferes whether the container reads back as
    a SOLID or as a COMPOUND, in either argument order (fixtures/containment_probe.py)."""

    def test_a_part_buried_in_a_solid_or_a_compound_part_interferes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            proc = subprocess.run(["uv", "run", "--quiet", "--script", str(FIXTURES / "containment_probe.py"), tmp],
                                  capture_output=True, text=True, check=False)
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        report = json.loads(proc.stdout)
        self.assertEqual(report["shape_types"], {"TST-0301": "TopAbs_COMPOUND", "TST-0302": "TopAbs_SOLID",
                                                 "TST-0303": "TopAbs_SOLID"})
        for container in ("solid", "compound"):
            for order in ("container_first", "buried_first"):
                with self.subTest(container=container, order=order):
                    row = report[container][order]
                    self.assertEqual((row["clearance_mm"], row["status"]), (0.0, "fail"))
                    self.assertAlmostEqual(row["interference_mm3"], 8.0, places=6)


if __name__ == "__main__":
    unittest.main()
