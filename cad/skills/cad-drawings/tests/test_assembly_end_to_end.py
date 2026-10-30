#!/usr/bin/env python3
"""assembly_drawing.py end to end: a fixture assembly STEP through FreeCAD to a published, re-checkable package.

The fixture is a 80 x 40 x 6 mm plate with one pin definition placed twice (``@pin-a``, ``@pin-b``),
written through cad-motion's STEP writers. The cases run the real CLI in its uv environment and the
real freecadcmd (FREECADCMD, PATH or the macOS app); they are skipped only when FreeCAD is absent.
Run: uv run --with pyyaml --with defusedxml --with jsonschema python -m unittest discover -s cad/skills/cad-drawings/tests
"""

from __future__ import annotations

import csv
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"
SKILLS = HERE.parents[1]
FIXTURE = HERE / "fixtures" / "build_assembly_fixture.py"
CLI = SCRIPTS / "assembly_drawing.py"
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(SKILLS / "cad-model" / "scripts"))
import assembly_check  # noqa: E402
import freecad_runtime  # noqa: E402
from cadmodel import scriptenv  # noqa: E402

FREECADCMD = freecad_runtime.find_freecadcmd()
FREECAD_PRESENT = FREECADCMD is not None and FREECADCMD.is_file()
PLATE, PIN = "TST-0101", "TST-0102"
PINS = {"pin-a": [20.0, 20.0, 6.0], "pin-b": [60.0, 20.0, 6.0]}

ASSEMBLY = {
    "occurrences": [{"id": oid, "PN": PIN, "placement": {"translation_mm": xyz}} for oid, xyz in PINS.items()],
    "subassemblies": [{"id": "plate_sub", "title": "Plate", "parts": [PLATE]},
                      {"id": "pins", "title": "Pins", "occurrences": ["@pin-a", "@pin-b"]}],
    "joints": [{"id": f"J-00{n}", "type": "fixed", "parent": PLATE, "child": f"@{oid}", "axis": [0, 0, 1],
                "origin": xyz, "min": 0, "max": 0, "nominal": 0} for n, (oid, xyz) in enumerate(PINS.items(), start=1)],
    "drawing": {
        "number": "TST-ASM", "rev": "A", "title": "Pin plate assembly",
        "views": [{"id": "assembled_front", "kind": "assembled", "direction": "front"},
                  {"id": "exploded_iso", "kind": "exploded", "direction": "iso"}],
        "explode": [{"ref": "@pin-a", "offset_mm": [0, 0, 25]}, {"ref": "@pin-b", "offset_mm": [0, 0, 40]}],
        "items": [{"item": 1, "PN": PLATE}, {"item": 2, "PN": PIN, "occurrences": ["@pin-a", "@pin-b"]}],
        "subassembly_sheets": ["pins"],
        "operations": [{"id": "press_pin_a", "kind": "press_fit", "part": "@pin-a", "into": PLATE,
                        "interface": "IF-001", "direction": [0, 0, -1],
                        "acceptance": {"kind": "seated", "features": ["pin_end", "plate_top"]}}],
    },
}
PARTS = {
    PLATE: {"title": "Pin plate", "material": "Aluminum 6061-T6", "process": "cnc", "mass_target": 52,
            "shape": {"box": [80, 40, 6]}, "frame": "assembly_zero"},
    PIN: {"title": "Dowel pin", "material": "Stainless steel A2", "process": "purchased", "mass_target": 4.5,
          "shape": {"cylinder": [3, 20]}, "frame": "part_local"},
}


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_project(root: Path, regime: str = "iso", bom_pin_qty: int = 2) -> Path:
    """A valid record and a version folder built from the fixture STEPs, hashed as ``cad_model.py run`` would."""
    hw = root / "project" / "hw"
    documents = {
        "product.yaml": {"id": "pin-plate", "rigor": "pro", "units": "mm", "regime": regime,
                         "general_tolerance": "ISO 2768-m", "flow": {"stage": "detail", "recheck_from": "detail"}},
        "requirements.yaml": {"requirements": [{"id": "REQ-001", "text": "Pins", "rationale": "Fixture", "source": "Test",
                                                "priority": "must", "verification": {"method": "I", "criteria": "Made"}}]},
        "interfaces.yaml": {"interfaces": [{"id": "IF-001", "from": "plate", "to": "pin", "type": "mounting",
                                            "description": "Pin pressed into the plate",
                                            "limits": {"press_fit": {"fit": "6 H7/p6", "pair": [PLATE, "@pin-a"]}}}]},
        "assembly.yaml": ASSEMBLY,
    }
    hw.mkdir(parents=True)
    for name, document in documents.items():
        (hw / name).write_text(yaml.safe_dump(document, sort_keys=False), encoding="utf-8")
    with (hw / "bom.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream, lineterminator="\n")
        writer.writerow(["level", "PN", "rev", "qty", "title", "material", "process", "make_buy", "supplier", "mass"])
        for pn, part in PARTS.items():
            qty = bom_pin_qty if pn == PIN else 1
            writer.writerow(["1", pn, "X1", qty, part["title"], part["material"], part["process"],
                             "buy" if part["process"] == "purchased" else "make", "", part["mass_target"]])
    (hw / "verification.csv").write_text("requirement_id,method,criteria,result,evidence\nREQ-001,I,Made,planned,\n",
                                         encoding="utf-8")
    version = hw / "versions" / "v1"
    built = {}
    for pn, part in PARTS.items():
        folder = hw / "parts" / pn
        folder.mkdir(parents=True)
        record = {"PN": pn, "rev": "X1", "title": part["title"], "material": part["material"], "process": part["process"],
                  "finish": "none", "mass_target": part["mass_target"],
                  "make_buy": "buy" if part["process"] == "purchased" else "make", "supplier": None,
                  "model_frame": part["frame"]}
        (folder / "part.yaml").write_text(yaml.safe_dump(record, sort_keys=False), encoding="utf-8")
        (folder / "model.py").write_text(f'KERNEL = "cadquery"\nPARAMS = {{}}\n# {pn}\n', encoding="utf-8")
        built[pn] = {"model": f"parts/{pn}/model.py", "source_sha256": sha(folder / "model.py"), "step": f"parts/{pn}.step"}
    spec = {"definitions": {pn: {"name": f"{pn} {p['title']}", **p["shape"]} for pn, p in PARTS.items()},
            "occurrences": [{"id": PLATE, "PN": PLATE, "explicit": False, "translation_mm": [0, 0, 0], "axis": [0, 0, 1],
                             "angle_deg": 0}] + [{"id": oid, "PN": PIN, "explicit": True, "translation_mm": xyz,
                                                  "axis": [0, 0, 1], "angle_deg": 0} for oid, xyz in PINS.items()],
            "parts_dir": str(version / "parts"), "assembly": str(version / "assembly.step"), "top": "pin-plate v1"}
    (root / "fixture.json").write_text(json.dumps(spec), encoding="utf-8")
    proc = subprocess.run(scriptenv.python_command(FIXTURE, str(FIXTURE), str(root / "fixture.json")),
                          capture_output=True, text=True, timeout=900)
    if proc.returncode != 0:
        raise AssertionError(f"fixture build failed: {proc.stderr[-2000:]}")
    (version / "metrics.json").write_text(json.dumps({"parts": {pn: {"volume_mm3": 1.0, "holes": []} for pn in PARTS}}),
                                          encoding="utf-8")
    files = ["assembly.step", "metrics.json", *(b["step"] for b in built.values())]
    manifest = {"schema_version": 2, "label": "v1", "product_id": "pin-plate",
                "assembly_yaml_sha256": sha(hw / "assembly.yaml"), "parts": built,
                "record": {"record/product.yaml": sha(hw / "product.yaml"),
                           "record/interfaces.yaml": sha(hw / "interfaces.yaml"),
                           "record/assembly.yaml": sha(hw / "assembly.yaml"),
                           **{f"record/parts/{pn}/part.yaml": sha(hw / "parts" / pn / "part.yaml") for pn in PARTS}},
                "manufacturing": {}, "files": {name: sha(version / name) for name in files}}
    for relative in manifest["record"]:
        source = hw / relative.removeprefix("record/")
        target = version / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    manifest["files"].update({name: sha(version / name) for name in manifest["record"]})
    (version / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return hw


def run_cli(hw: Path, out: Path | None = None, jobs: int | None = None, replace: bool = False) -> tuple[int, dict]:
    command = [CLI, str(hw), "--version", "v1", "--timeout", "600"]
    if out is not None:
        command += ["--output-dir", str(out)]
    if jobs is not None:
        command += ["--jobs", str(jobs)]
    if replace:
        command.append("--replace")
    proc = subprocess.run(scriptenv.script_command(*command), capture_output=True, text=True, timeout=1800)
    try:
        return proc.returncode, json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise AssertionError(f"no JSON from the CLI (exit {proc.returncode}): {proc.stderr[-3000:]}") from None


@unittest.skipUnless(FREECAD_PRESENT, "FreeCAD is not installed")
class EndToEnd(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)

    def test_both_regimes_publish_checked_balloons_on_their_own_occurrences(self) -> None:
        for regime in ("iso", "asme"):
            with self.subTest(regime=regime):
                root = self.root / regime
                hw = write_project(root, regime)
                status, result = run_cli(hw)
                self.assertEqual((status, result["status"]), (0, "pass"), result.get("findings"))
                package_path = hw.parent / result["output_dir"]
                package = json.loads((package_path / "package.json").read_text(encoding="utf-8"))
                sheets = [row for row in package["coverage"]["rows"] if row["kind"] == "assembly_sheet"]
                self.assertEqual([(s["sheet"], s["scope"]) for s in sheets], [(1, "top"), (2, "pins")])
                self.assertEqual(sheets[0]["items"]["2"], {"PN": PIN, "qty": 2, "occurrences": ["pin-a", "pin-b"]})
                exploded = sheets[0]["views"]["exploded_iso"]
                balloons = {b["item"]: b for b in assembly_check.read_balloons(
                    assembly_check.SafeET.fromstring((package_path / "sheet-1.svg").read_text(encoding="utf-8")))}
                self.assertEqual(sorted(balloons), ["1", "2"])
                # Each leader dot sits on the measured visible point of its own occurrence, inside the view.
                for item, occurrence in (("1", PLATE), ("2", "pin-a")):
                    self.assertEqual(balloons[item]["occurrence"], occurrence)
                    dot, anchor = balloons[item]["dot"], exploded["anchors"][occurrence]
                    self.assertLess(max(abs(a - b) for a, b in zip(dot, anchor)), 0.01)
                operation = next(r for r in package["coverage"]["rows"] if r["kind"] == "assembly_operation")
                self.assertLess(operation["measured"]["gap"], 0.01)
                for record in package["sheets"]:
                    for kind in ("svg", "pdf", "png"):
                        self.assertTrue((hw.parent / record["files"][kind]).is_file())
                    self.assertEqual(record["export"]["pdf_fonts"], ["osifont"])
                self.assertEqual(assembly_check.check_package(package_path)["status"], "pass")

                tampered = root / "tampered"
                shutil.copytree(package_path, tampered)
                svg_path = tampered / "sheet-1.svg"
                svg = svg_path.read_text(encoding="utf-8")
                start = svg.index('<g id="balloon-exploded_iso-2"')
                end = svg.index("</g></g>", start) + len("</g></g>")
                svg_path.write_text(svg[:start] + svg[end:], encoding="utf-8")
                rechecked = assembly_check.check_package(tampered)
                self.assertEqual(rechecked["status"], "fail")
                self.assertIn("item 2 has 0 balloons in view exploded_iso; expected one",
                              [f["message"] for f in rechecked["findings"]])

    def test_parallel_assembly_sheets_match_sequential_report_order(self) -> None:
        hw = write_project(self.root / "parallel")
        sequential_status, sequential = run_cli(hw, jobs=1)
        parallel_status, parallel = run_cli(hw, jobs=2)
        self.assertEqual((sequential_status, sequential["status"]), (0, "pass"), sequential.get("findings"))
        self.assertEqual((parallel_status, parallel["status"]), (0, "pass"), parallel.get("findings"))
        sequential_package = json.loads((hw.parent / sequential["output_dir"] / "package.json").read_text())
        parallel_package = json.loads((hw.parent / parallel["output_dir"] / "package.json").read_text())
        self.assertEqual([row["sheet"] for row in sequential_package["sheets"]], [1, 2])
        self.assertEqual([row["sheet"] for row in parallel_package["sheets"]], [1, 2])
        self.assertEqual(sequential_package["coverage"]["rows"], parallel_package["coverage"]["rows"])

    def test_a_failed_run_never_replaces_the_sealed_bundle(self) -> None:
        hw = write_project(self.root / "failed")
        status, first = run_cli(hw)
        self.assertEqual((status, first["status"]), (0, "pass"), first.get("findings"))
        bundle = hw.parent / first["output_dir"]
        self.assertEqual(json.loads((bundle / "manifest.json").read_text(encoding="utf-8"))["status"], "pass")
        sealed = {p.relative_to(bundle).as_posix(): p.read_bytes() for p in bundle.rglob("*") if p.is_file()}
        with (hw / "bom.csv").open(encoding="utf-8") as stream:
            rows = list(csv.reader(stream))
        rows[2][3] = "3"  # the parts list no longer matches the two placed pins
        with (hw / "bom.csv").open("w", newline="", encoding="utf-8") as stream:
            csv.writer(stream, lineterminator="\n").writerows(rows)
        status, result = run_cli(hw, replace=True)  # --replace: a failure must still leave the bundle alone
        self.assertNotEqual(status, 0)
        self.assertNotEqual(result["status"], "pass")
        self.assertIn("BOM quantity of TST-0102 is 3", json.dumps(result["findings"]))
        self.assertEqual(sealed, {p.relative_to(bundle).as_posix(): p.read_bytes() for p in bundle.rglob("*") if p.is_file()})
        self.assertEqual(list((hw.parent / ".cad-work" / "replaced").glob("*")) if (hw.parent / ".cad-work" / "replaced").exists() else [], [])


if __name__ == "__main__":
    unittest.main()
