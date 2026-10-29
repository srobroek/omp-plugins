#!/usr/bin/env python3
"""EBOM roll-up tests: pure tree logic, plus an AP242 round trip through OCP XDE."""

from __future__ import annotations

import csv
import hashlib
import importlib.util
import json
import os
import contextlib
import io
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


HERE = Path(__file__).parent
BOM_SCRIPT = HERE / "scripts" / "bom.py"
BUILDER = HERE / "fixtures" / "build_assembly.py"
SPEC = importlib.util.spec_from_file_location("cad_bom", BOM_SCRIPT)
RECORD_VALIDATOR = HERE.parent / "cad-record" / "scripts" / "validate.py"
assert SPEC and SPEC.loader
bom = importlib.util.module_from_spec(SPEC)
sys.modules["cad_bom"] = bom
SPEC.loader.exec_module(bom)

PARTS = {
    "BASE-0001": "rev: X2\ntitle: Base plate\nmaterial: PETG\nprocess: fdm\nmake_buy: make\nmass_target: 40\n",
    "PIN-0001": (
        "rev: X1\ntitle: Dowel pin 4x12\nmaterial: 1.3505 steel\nprocess: purchased\n"
        "make_buy: buy\nsupplier: Misumi\nmass_target: 1.2\n"
    ),
    "BRK-0002": "rev: X1\ntitle: Bracket\nmaterial: 6082-T6\nprocess: cnc\nmake_buy: make\nmass_target: 3.5\n",
    "SCR-0001": "rev: A\ntitle: Screw M3x8\nmaterial: A2-70\nprocess: purchased\nmake_buy: buy\nmass_target: 0.6\n",
}
DATASHEET = b"%PDF-1.4 dowel pin datasheet stand-in\n"
PIN_PROCUREMENT = (
    "procurement:\n  mode: catalog\n  manufacturer: Misumi\n  manufacturer_part_number: MSTH4-12\n"
    "  supplier_part_number: MSTH4-12-EU\n  designation: ISO 8734 4 x 12 A1\n"
    "  specification: {reference: Misumi MSTH datasheet, revision: '2024-03', artifact: parts/PIN-0001/sources/msth.pdf,\n"
    f"                  sha256: {hashlib.sha256(DATASHEET).hexdigest()}}}\n"
)


def write_parts(hw: Path, parts: dict[str, str]) -> None:
    for pn, text in parts.items():
        folder = hw / "parts" / pn
        folder.mkdir(parents=True)
        (folder / "part.yaml").write_text(text, encoding="utf-8")


def rows_by_level_pn(path: Path) -> dict[tuple[str, str], dict[str, str]]:
    with path.open(encoding="utf-8", newline="") as handle:
        return {(row["level"], row["PN"]): row for row in csv.DictReader(handle)}


class RollUpTests(unittest.TestCase):
    """Tree semantics on hand-built product trees; needs no OCP."""

    def test_repeated_part_counts_instances_per_parent(self) -> None:
        pin = bom.Node("PIN-0001", False)
        top = bom.Node("ASM-0001", True, [(pin, 2)])
        result = bom.roll_up([top], {"PIN-0001": {"rev": "X1"}})
        self.assertEqual([(r["level"], r["PN"], r["qty"]) for r in result["rows"]], [("0", "ASM-0001", "1"), ("1", "PIN-0001", "2")])

    def test_repeated_subassembly_multiplies_totals_not_rows(self) -> None:
        pin = bom.Node("PIN-0001", False)
        sub = bom.Node("SUB-0001", True, [(pin, 3)])
        top = bom.Node("ASM-0001", True, [(sub, 2)])
        result = bom.roll_up([top], {"PIN-0001": {}})
        self.assertEqual([(r["level"], r["PN"], r["qty"]) for r in result["rows"]], [("0", "ASM-0001", "1"), ("1", "SUB-0001", "2"), ("2", "PIN-0001", "3")])
        self.assertEqual(result["total_qty"]["PIN-0001"], 6)

    def test_phantom_group_merges_into_parent(self) -> None:
        pin = bom.Node("PIN-0001", False)
        group = bom.Node("pins", True, [(pin, 2)])
        top = bom.Node("ASM-0001", True, [(pin, 1), (group, 2)])
        result = bom.roll_up([top], {"PIN-0001": {}})
        self.assertEqual([(r["level"], r["PN"], r["qty"]) for r in result["rows"]], [("0", "ASM-0001", "1"), ("1", "PIN-0001", "5")])

    def test_unnumbered_leaf_is_reported(self) -> None:
        top = bom.Node("ASM-0001", True, [(bom.Node("Body001", False), 1)])
        self.assertEqual(bom.roll_up([top], {})["unidentified"], ["Body001"])

    def test_part_number_must_end_at_four_digits(self) -> None:
        self.assertEqual(bom.Node("PIN-0001 pin", False).pn, "PIN-0001")
        self.assertIsNone(bom.Node("PIN-00012", False).pn)
        self.assertIsNone(bom.Node("pin-0001", False).pn)

    def test_procurement_columns_come_from_part_yaml(self) -> None:
        pin = bom.Node("PIN-0001", False)
        top = bom.Node("ASM-0001", True, [(pin, 2)])
        procurement = {"mode": "catalog", "manufacturer": "Misumi", "manufacturer_part_number": "MSTH4-12",
                       "supplier_part_number": "MSTH4-12-EU", "designation": "ISO 8734 4 x 12 A1",
                       "specification": {"reference": "Misumi MSTH datasheet", "revision": "2024-03"}}
        rows = bom.roll_up([top], {"PIN-0001": {"rev": "X1", "procurement": procurement}})["rows"]
        self.assertTrue(all(set(row) == set(bom.COLUMNS) for row in rows), rows)
        self.assertEqual({k: rows[1][k] for k in bom.COLUMNS[10:]}, {
            "unit": "pcs", "designation": "ISO 8734 4 x 12 A1", "manufacturer": "Misumi",
            "manufacturer_part_number": "MSTH4-12", "supplier_part_number": "MSTH4-12-EU",
            "specification_ref": "Misumi MSTH datasheet", "specification_rev": "2024-03"})
        self.assertEqual({k: rows[0][k] for k in bom.COLUMNS[10:]},
                         {"unit": "pcs", **{k: "" for k in bom.COLUMNS[11:]}}, "an assembly has no part.yaml")


class ConsoleRedirectTests(unittest.TestCase):
    """The OCCT console redirect keeps output written through C stdio, as OCCT writes it, off the JSON stdout."""

    @unittest.skipUnless(os.name == "posix", "the probe reaches C stdio through the POSIX libc")
    def test_c_stdio_output_inside_the_redirect_reaches_stderr_not_a_piped_stdout(self) -> None:
        # A pipe makes C stdout fully buffered: left in the buffer, the noise reaches stdout at exit, after the JSON.
        probe = ("import ctypes, importlib.util, json, sys\n"
                 f"spec = importlib.util.spec_from_file_location('bom', {str(BOM_SCRIPT)!r})\n"
                 "bom = sys.modules['bom'] = importlib.util.module_from_spec(spec)\n"
                 "spec.loader.exec_module(bom)\n"
                 "with bom._stdout_to_stderr():\n"
                 "    ctypes.CDLL(None).puts(b'****** Statistics on Transfer (Read) ******')\n"
                 "print(json.dumps({'status': 'pass'}))\n")
        proc = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True, check=False, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, '{"status": "pass"}\n')
        self.assertIn("Statistics on Transfer (Read)", proc.stderr)


@unittest.skipUnless(shutil.which("uv"), "uv is required to build and read STEP through OCP")
class StepRoundTripTests(unittest.TestCase):
    """Builds an AP242 assembly with OCP, then rolls it up with bom.py."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        cls.step = Path(cls.tmp.name) / "assembly.step"
        proc = subprocess.run(
            ["uv", "run", "--quiet", "--script", str(BUILDER), str(cls.step)],
            capture_output=True, text=True, check=False, timeout=900,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"fixture build failed: {proc.stderr}")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def run_bom(self, hw: Path) -> tuple[subprocess.CompletedProcess[str], dict]:
        proc = subprocess.run(
            ["uv", "run", "--quiet", "--script", str(BOM_SCRIPT), str(self.step), "--hw", str(hw)],
            capture_output=True, text=True, check=False, timeout=900,
        )
        return proc, json.loads(proc.stdout) if proc.stdout else {}

    def test_fixture_is_ap242(self) -> None:
        self.assertIn("AP242_MANAGED_MODEL_BASED_3D_ENGINEERING", self.step.read_text(encoding="utf-8")[:2000])

    def test_complete_record_rolls_up_with_qty_2_for_repeated_pin(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            hw = Path(directory)
            write_parts(hw, PARTS)
            proc, summary = self.run_bom(hw)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(summary["status"], "pass")
            with (hw / "bom.csv").open(encoding="utf-8") as handle:
                self.assertEqual(handle.readline().strip(), ",".join(bom.COLUMNS))
            rows = rows_by_level_pn(hw / "bom.csv")
        pin = rows[("1", "PIN-0001")]
        self.assertEqual(pin["qty"], "2")
        self.assertEqual(
            {k: pin[k] for k in ("rev", "title", "material", "process", "make_buy", "supplier", "mass")},
            {"rev": "X1", "title": "Dowel pin 4x12", "material": "1.3505 steel", "process": "purchased",
             "make_buy": "buy", "supplier": "Misumi", "mass": "1.2"},
        )
        self.assertEqual(rows[("0", "ASM-0001")]["title"], "Test assembly")
        self.assertEqual(rows[("1", "BASE-0001")]["qty"], "1")
        self.assertEqual(rows[("1", "SUB-0001")]["qty"], "1")
        self.assertEqual(rows[("2", "PIN-0001")]["qty"], "1")
        self.assertEqual(rows[("2", "BRK-0002")]["qty"], "1")
        self.assertEqual(rows[("1", "SCR-0001")]["qty"], "2")  # phantom "fasteners" group merged up
        self.assertEqual(summary["total_qty"]["PIN-0001"], 3)


    def test_version_reconciles_from_snapshot_not_current_parts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            hw = Path(directory) / "hw"
            snapshot = Path(directory) / "snapshot"
            hw.mkdir()
            snapshot.mkdir()
            write_parts(hw, {"PIN-0001": "title: Current title\n"})
            write_parts(snapshot, {"PIN-0001": "title: Snapshot title\n"})
            step = self.step
            output = io.StringIO()
            with mock.patch.object(bom.LAYOUT, "built_version", return_value=("v1", hw, snapshot)), \
                 mock.patch.object(bom, "read_step_tree", return_value=[bom.Node("PIN-0001", False)]), \
                 contextlib.redirect_stdout(output):
                status = bom.main([str(step), "--hw", str(hw), "--version", "v1"])
            summary = json.loads(output.getvalue())
            self.assertEqual(status, 0)
            self.assertEqual(summary["reconciled_against"], "v1")
            self.assertEqual(rows_by_level_pn(hw / "bom.csv")[("0", "PIN-0001")]["title"], "Snapshot title")

    def test_output_outside_cad_work_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            hw = Path(directory) / "hw"
            hw.mkdir()
            outside = Path(directory) / "elsewhere.csv"
            proc = subprocess.run(
                ["uv", "run", "--quiet", "--script", str(BOM_SCRIPT), str(Path(directory) / "unused.step"),
                 "--hw", str(hw), "--out", str(outside)],
                capture_output=True, text=True, check=False, timeout=900,
            )
        self.assertEqual(proc.returncode, 2)
        self.assertIn("--out", proc.stderr)
    def test_mismatches_are_reported_both_ways(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            hw = Path(directory)
            parts = {pn: text for pn, text in PARTS.items() if pn != "BRK-0002"}
            parts["NUT-0001"] = "rev: A\ntitle: Nut M3\n"
            write_parts(hw, parts)
            proc, summary = self.run_bom(hw)
            self.assertTrue((hw / "bom.csv").is_file())
        self.assertEqual(proc.returncode, 1, proc.stderr)
        self.assertEqual(summary["status"], "fail")
        self.assertEqual(summary["missing_part_yaml"], ["BRK-0002"])
        self.assertEqual(summary["missing_in_step"], ["NUT-0001"])

    def test_generated_bom_pipes_into_cad_record_validator(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory) / "project"
            hw = project / "hw"
            hw.mkdir(parents=True)
            parts = dict(PARTS)
            parts["BASE-0001"] = (
                "rev: X2\ntitle: Base plate\nmaterial: PETG\nprocess: fdm\nfinish: deburred\n"
                "make_buy: make\nmass_target: 40\n"
            )
            parts["PIN-0001"] += PIN_PROCUREMENT
            for pn, text in parts.items():
                folder = hw / "parts" / pn
                folder.mkdir(parents=True)
                extra = "finish: deburred\n" if "finish:" not in text else ""
                (folder / "part.yaml").write_text(f"PN: {pn}\n" + text + extra, encoding="utf-8")
            (hw / "parts" / "PIN-0001" / "sources").mkdir()
            (hw / "parts" / "PIN-0001" / "sources" / "msth.pdf").write_bytes(DATASHEET)
            (hw / "product.yaml").write_text(
                "id: test-assembly\nrigor: pro\nunits: mm\nregime: iso\ngeneral_tolerance: 0.1\n"
                "flow: {stage: layout, recheck_from: layout}\n", encoding="utf-8"
            )
            (hw / "requirements.yaml").write_text(
                "requirements:\n  - id: REQ-001\n    text: Fit\n    rationale: Assemble\n"
                "    source: Test\n    priority: must\n    verification: {method: I, criteria: Fits}\n",
                encoding="utf-8",
            )
            (hw / "interfaces.yaml").write_text("interfaces: []\n", encoding="utf-8")
            (hw / "assembly.yaml").write_text(
                "subassemblies:\n  - id: main\n    title: Main assembly\n    parts: [BASE-0001, PIN-0001, BRK-0002, SCR-0001]\n"
                "joints: []\n", encoding="utf-8"
            )
            (hw / "verification.csv").write_text(
                "requirement_id,method,criteria,result,evidence\nREQ-001,I,Fits,planned,\n", encoding="utf-8"
            )

            bom_proc, _ = self.run_bom(hw)
            self.assertEqual(bom_proc.returncode, 0, bom_proc.stderr)
            pin = rows_by_level_pn(hw / "bom.csv")[("1", "PIN-0001")]
            self.assertEqual((pin["unit"], pin["designation"], pin["specification_rev"]),
                             ("pcs", "ISO 8734 4 x 12 A1", "2024-03"))
            validation = subprocess.run(
                [sys.executable, str(RECORD_VALIDATOR), str(project)],
                capture_output=True, text=True, check=False, timeout=60,
            )

        self.assertEqual(validation.returncode, 0, validation.stdout + validation.stderr)
        self.assertEqual(json.loads(validation.stdout), {"ok": True, "findings": []})

    def test_missing_step_exits_2(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            proc = subprocess.run(
                ["uv", "run", "--quiet", "--script", str(BOM_SCRIPT), str(Path(directory) / "none.step"), "--hw", directory],
                capture_output=True, text=True, check=False, timeout=900,
            )
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
