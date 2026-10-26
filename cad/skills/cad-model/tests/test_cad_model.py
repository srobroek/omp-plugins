#!/usr/bin/env python3
"""cad-model tests: a two-part project built, checked, and diffed in both kernels.

Run: python3 -m unittest discover -s cad/skills/cad-model/tests -v
Needs `uv`; the first run creates three uv environments (orchestrator, CadQuery, build123d) and
their first OCP imports take minutes. Wall times are printed to stderr.
"""

from __future__ import annotations

import json
import math
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"
CLI = HERE.parent / "scripts" / "cad_model.py"
KERNELS = ("cadquery", "build123d")
AP242 = "AP242_MANAGED_MODEL_BASED_3D_ENGINEERING"

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


def set_model(hw: Path, pn: str, kernel: str, template: str, params: dict, title: str, material: str) -> None:
    folder = hw / "parts" / pn
    folder.mkdir(parents=True, exist_ok=True)
    source = (FIXTURES / kernel / template).read_text(encoding="utf-8")
    source = re.sub(r"^PARAMS = .*$", f"PARAMS = {params!r}", source, count=1, flags=re.M)
    (folder / "model.py").write_text(source, encoding="utf-8")
    (folder / "part.yaml").write_text(
        f"PN: {pn}\nrev: X1\ntitle: {title}\nmaterial: {material}\nprocess: cnc\nfinish: none\n"
        f"mass_target: 100\nmake_buy: make\nsupplier: null\n", encoding="utf-8")


def two_part_project(root: Path, kernel: str) -> Path:
    hw = root / kernel / "hw"
    hw.mkdir(parents=True)
    (hw / "product.yaml").write_text("id: twoarm\n", encoding="utf-8")
    (hw / "assembly.yaml").write_text(ASSEMBLY, encoding="utf-8")
    set_model(hw, "TST-0001", kernel, "base.py", {"size": 40.0, "height": 20.0, "bore": 6.0}, *PARTS["TST-0001"][:2])
    return hw


def set_arm(hw: Path, kernel: str, template: str = "arm.py", **changes: float) -> None:
    params = {**ARM, **changes}
    if template == "arm_invalid.py":
        params = {k: params[k] for k in ("length", "width", "thickness", "z0")}
    set_model(hw, "TST-0002", kernel, template, params, *PARTS["TST-0002"][:2])


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
    started = time.perf_counter()
    proc = subprocess.run(["uv", "run", "--quiet", "--script", str(CLI), *args],
                          capture_output=True, text=True, check=False)  # no timeout: cold OCP imports take minutes
    wall = time.perf_counter() - started
    print(f"[cad-model wall] {wall:7.1f} s  {' '.join(args[:3])}", file=sys.stderr)
    return proc, (json.loads(proc.stdout) if proc.stdout.strip() else {}), wall


def kernel_sequence(root: Path, kernel: str) -> dict:
    """Build v1..v4 of the two-part project and the safe-edit project in one kernel."""
    hw = two_part_project(root, kernel)
    runs = {}
    for label, arm in (("v1", {}), ("v2", {"length": 80.0}), ("v3", {"z0": 15.0}), ("v4", "invalid")):
        if arm == "invalid":
            set_arm(hw, kernel, "arm_invalid.py")
        else:
            set_arm(hw, kernel, **arm)
        runs[label] = cli("run", str(hw), "--label", label)
        runs[f"{label}-model"] = (hw / "parts" / "TST-0002" / "model.py").read_text(encoding="utf-8")
    runs["checks"] = {label: cli("check", label, "--hw", str(hw)) for label in ("v1", "v2", "v3", "v4")}
    runs["diff"] = cli("diff", "v1", "v2", "--hw", str(hw))
    runs["safe"] = cli("run", str(safe_project(root, kernel)), "--label", "v1")
    runs["hw"] = hw
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


def tearDownModule() -> None:  # noqa: N802 - unittest hook name
    if "tmp" in _SHARED:
        _SHARED["tmp"].cleanup()


SCHEMA = re.compile(r"FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'")


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
            self.assertEqual(manifest["joint_pairs"], [["TST-0001", "TST-0002"]])
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
        self.assertEqual((result["added"], result["removed"], result["changed"]), ([], [], ["TST-0002"]))
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
            self.assertEqual(found[pn]["type"], "SafeEditError", found[pn])
            self.assertIn(text, found[pn]["message"])
            self.assertTrue(found[pn]["where"].startswith("model.py:"), found[pn])
        self.assertFalse((self.runs["hw"].parent / "safe-hw" / "versions" / "v1").exists())


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
        checks = [runs[k]["checks"]["v1"][1] for k in KERNELS]
        self.assertEqual(checks[0].keys(), checks[1].keys())
        self.assertEqual(checks[0]["checks"].keys(), checks[1]["checks"].keys())
        self.assertEqual(runs[KERNELS[0]]["v1"][1].keys(), runs[KERNELS[1]]["v1"][1].keys())


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


if __name__ == "__main__":
    unittest.main()
