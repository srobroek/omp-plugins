#!/usr/bin/env python3
"""Structured build-guide generation from lamp and minimal project records."""

from __future__ import annotations

import csv
import json
import shutil
import subprocess
import tempfile
import tomllib
import unittest
from pathlib import Path

import yaml

SKILL = Path(__file__).resolve().parents[1]
SCRIPT = SKILL / "scripts" / "build_guide.py"
TEMPLATE = SKILL / "assets" / "project-template" / "hw"
LAMP_EXAMPLE = SKILL.parent.parent / "examples" / "lamp-arm"
COVERAGE = {"rows": [
    {"kind": "assembly_operation", "operation": operation, "measured": {"gap": 0.3}}
    for operation in ("press_base_pin", "press_elbow_pin", "press_head_pin")
]}


class BuildGuide(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="cad-build-guide-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.hw = self.root / "hw"
        self.hw.mkdir()
        self.out = self.root / ".cad-work" / "docs"

    def copy_lamp_example(self) -> Path:
        shutil.copytree(LAMP_EXAMPLE / "hw", self.hw, dirs_exist_ok=True)
        return self.hw

    def make_version(self, hw: Path, version: str) -> None:
        version_dir = hw / "versions" / version
        version_dir.mkdir(parents=True)
        bom = hw / "bom.csv"
        made = {}
        with bom.open(newline="", encoding="utf-8") as stream:
            for row in csv.DictReader(stream):
                part = yaml.safe_load((hw / "parts" / row["PN"] / "part.yaml").read_text(encoding="utf-8"))
                if row.get("make_buy") == "make" or part.get("procurement", {}).get("mode") == "made_to_drawing":
                    pn = row["PN"]
                    target = version_dir / "manufacturing" / pn
                    target.mkdir(parents=True)
                    (target / "part.step").write_text("fixture STEP", encoding="utf-8")
                    names = ["part.step"]
                    if part.get("process") == "fdm":
                        (target / "part.stl").write_bytes(b"fixture STL")
                        names.append("part.stl")
                    (target / "manufacturing.json").write_text("{}\n", encoding="utf-8")
                    made[pn] = {"path": f"manufacturing/{pn}", "outputs": names + ["manufacturing.json"]}
                    if part.get("procurement", {}).get("mode") == "made_to_drawing":
                        drawing = hw / "drawings" / version / pn
                        drawing.mkdir(parents=True, exist_ok=True)
                        (drawing / "sheet-1.pdf").write_bytes(b"fixture drawing")
        (version_dir / "manifest.json").write_text(
            json.dumps({"label": version, "manufacturing": made}), encoding="utf-8")

    def copy_coverage(self, hw: Path) -> None:
        target = hw / "drawings" / "v1" / "assembly" / "coverage.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(COVERAGE), encoding="utf-8")

    def run_guide(self, hw: Path, *extra: str, version: str = "v1") -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["uv", "run", "--script", str(SCRIPT), str(hw), "--version", version, "--out", str(self.out), *extra],
            capture_output=True, text=True, timeout=180,
        )

    def generate(self, hw: Path | None = None, version: str = "v1", *extra: str) -> str:
        result = self.run_guide(hw or self.hw, *extra, version=version)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return (self.out / "index.md").read_text(encoding="utf-8")

    def set_evidence(self, hw: Path, evidence: dict[str, str]) -> None:
        path = hw / "verification.csv"
        with path.open(newline="", encoding="utf-8") as stream:
            reader = csv.DictReader(stream)
            columns, rows = reader.fieldnames, list(reader)
        for row in rows:
            row["evidence"] = evidence.get(row["requirement_id"], row["evidence"])
        with path.open("w", newline="", encoding="utf-8") as stream:
            writer = csv.DictWriter(stream, fieldnames=columns, lineterminator="\n")
            writer.writeheader()
            writer.writerows(rows)

    def set_license(self, hw: Path, license_data: dict[str, str]) -> None:
        path = hw / "product.yaml"
        product = yaml.safe_load(path.read_text(encoding="utf-8"))
        product["license"] = license_data
        path.write_text(yaml.safe_dump(product, sort_keys=False), encoding="utf-8")

    def test_documented_docs_argument_is_supported(self) -> None:
        hw = self.copy_lamp_example()
        self.make_version(hw, "v1")
        self.out = hw / "docs"
        self.generate(hw)
        for name in ("index.md", "okh.toml", "din-spec-3105-1-checklist.md"):
            self.assertTrue((self.out / name).is_file(), name)

    def test_missing_release_manifest_is_named_in_guide_and_din(self) -> None:
        hw = self.copy_lamp_example()
        self.make_version(hw, "v1")
        guide = self.generate(hw)
        self.assertIn("MISSING: no hw/releases/<REV>/manifest.json approves v1", guide)
        din = (self.out / "din-spec-3105-1-checklist.md").read_text(encoding="utf-8")
        self.assertIn("MISSING: no hw/releases/<REV>/manifest.json approves v1", din)

    def test_lamp_template_reuses_measured_notes_and_structured_tools(self) -> None:
        hw = self.copy_lamp_example()
        self.make_version(hw, "v1")
        self.copy_coverage(hw)
        self.assertTrue((hw / "drawings" / "v1" / "assembly" / "coverage.json").is_file())
        guide = self.generate(hw)
        self.assertIn('<parts src="../../hw/bom.csv" />', guide)
        for heading in ("Overview", "Parts to make", "Parts to buy", "Tools and consumables",
                        "Assembly steps", "Checks before use"):
            self.assertIn(f"## {heading}", guide)
        self.assertIn("[part.step](../../hw/versions/v1/manufacturing/LMP-0001/part.step)", guide)
        self.assertIn("[part.stl](../../hw/versions/v1/manufacturing/LMP-0001/part.stl)", guide)
        self.assertIn("[drawing sheet PDF](../../hw/drawings/v1/LMP-0005/sheet-1.pdf)", guide)
        self.assertIn("| 11 | LMP-0011 |", guide)
        self.assertIn("OPEN — manufacturer_part_number:", guide)
        self.assertIn("Press item 5 into item 2 along -Z", guide)
        self.assertIn("0.3 mm off the hub top face, as modelled", guide)
        self.assertIn("Press item 6 into item 2 along -Y", guide)
        self.assertIn("Press item 7 into item 3 along -Y", guide)
        self.assertIn("0.3 mm off the cheek face, as modelled", guide)
        self.assertIn("fit 5 H7/p6 (IF-001)", guide)
        self.assertIn("## Assembly steps\n\n1. Heat-set item 8 into item 1", guide)
        self.assertIn("9. Fit ring item 11 onto item 7", guide)
        self.assertLess(guide.index("1. Heat-set item 8"), guide.index("2. Heat-set item 9"))
        self.assertLess(guide.index("2. Heat-set item 9"), guide.index("3. Heat-set item 10"))
        self.assertIn("| 4 | 5 into 2 | Arbor press or pin punch |", guide)
        self.assertIn("| 5 | 11 onto 5 | External circlip pliers |", guide)
        self.assertEqual(guide.count("Arbor press or pin punch"), 3)
        self.assertIn("REQ-001", guide)
        self.assertIn("planned", guide)

    def test_canonical_docs_output_generates_okh_and_din_from_record(self) -> None:
        hw = self.copy_lamp_example()
        self.make_version(hw, "v1")
        self.out = hw / "docs"
        product_path = hw / "product.yaml"
        product = yaml.safe_load(product_path.read_text(encoding="utf-8"))
        product["license"] = {"hardware": "CERN-OHL-S-2.0", "documentation": "CC-BY-4.0"}
        product["manufacturing"] = {"processes": ["fdm", "purchased"]}
        product_path.write_text(yaml.safe_dump(product, sort_keys=False), encoding="utf-8")
        guide = self.generate(hw)
        self.assertIn("External circlip pliers", guide)
        self.assertIn("Press item 5 into item 2", guide)
        self.assertIn("MISSING: no hw/releases/<REV>/manifest.json approves v1", guide)
        self.assertTrue((self.out / "index.md").is_file())
        okh = (self.out / "okh.toml").read_text(encoding="utf-8")
        din = (self.out / "din-spec-3105-1-checklist.md").read_text(encoding="utf-8")
        self.assertIn('name = "lamp-arm"', okh)
        self.assertIn('version = "v1"', okh)
        self.assertIn('license = "CC-BY-4.0"', okh)
        self.assertIn('hardware_license = "CERN-OHL-S-2.0"', okh)
        self.assertIn("planned processes: fdm, purchased", okh)
        self.assertIn("HUMAN-OWNED: licensor", okh)
        self.assertIn("HUMAN-OWNED: assess readiness level", okh)
        self.assertIn("DR-004", din)
        self.assertIn("processes: fdm, purchased", din)
        self.assertIn("verification.csv", din)
        self.assertIn("DR-004", din)

    def test_missing_license_stays_human_owned_not_inferred_from_license_file(self) -> None:
        hw = self.copy_lamp_example()
        self.make_version(hw, "v1")
        self.out = hw / "docs"
        (hw / "LICENSE").write_text("CC0-1.0", encoding="utf-8")
        self.generate(hw)
        okh = (self.out / "okh.toml").read_text(encoding="utf-8")
        self.assertIn("HUMAN-OWNED: set product.license.documentation", okh)
        self.assertIn("HUMAN-OWNED: set product.license.hardware", okh)
        self.assertNotIn('license = "CC0-1.0"', okh)

    def test_hw_docs_files_that_build_guide_did_not_generate_are_kept_unless_replace(self) -> None:
        hw = self.copy_lamp_example()
        self.make_version(hw, "v1")
        self.out = hw / "docs"
        self.out.mkdir()
        own = "# Our assembly notes\n"
        (self.out / "index.md").write_text(own, encoding="utf-8")
        result = self.run_guide(hw)
        self.assertEqual(result.returncode, 2)
        self.assertIn("hw/docs/index.md was not generated by build_guide.py", result.stderr)
        self.assertEqual((self.out / "index.md").read_text(encoding="utf-8"), own)
        self.assertFalse((self.out / "okh.toml").exists(), "a refusal writes nothing")
        self.generate(hw, "v1", "--replace")
        self.assertTrue((self.out / "index.md").read_text(encoding="utf-8").startswith(
            "<!-- Generated by cad-record build_guide.py; sha256 "))

    def test_a_hand_edited_generated_document_is_kept_unless_replace(self) -> None:
        hw = self.copy_lamp_example()
        self.make_version(hw, "v1")
        self.out = hw / "docs"
        self.generate(hw)
        self.generate(hw)  # an unchanged generated document is regenerated in place
        okh = self.out / "okh.toml"
        edited = okh.read_text(encoding="utf-8").replace('licensor = "HUMAN-OWNED: set product licensor"',
                                                         'licensor = "Example Lamps B.V."')
        self.assertIn("Example Lamps B.V.", edited)
        okh.write_text(edited, encoding="utf-8")
        result = self.run_guide(hw)
        self.assertEqual(result.returncode, 2)
        self.assertIn("hw/docs/okh.toml was edited after build_guide.py generated it", result.stderr)
        self.assertEqual(okh.read_text(encoding="utf-8"), edited)

    def test_evidence_keeps_its_text_and_links_files_and_bundle_directories(self) -> None:
        hw = self.copy_lamp_example()
        self.make_version(hw, "v1")
        (hw / "motion" / "v1" / "elbow-sweep").mkdir(parents=True)
        (hw / "docs").mkdir()
        (hw / "docs" / "inspection.md").write_text("# Inspection\n", encoding="utf-8")
        self.set_evidence(hw, {"REQ-002": "sweep hw/motion/v1/elbow-sweep passed",
                               "REQ-004": "hw/analysis/v1/arm-load/results.json",
                               "REQ-005": "see hw/docs/inspection.md."})
        guide = self.generate(hw)
        sweep = "sweep [hw/motion/v1/elbow-sweep](../../hw/motion/v1/elbow-sweep) passed"
        self.assertIn(f"| {sweep} |", guide)
        self.assertIn("| see [hw/docs/inspection.md](../../hw/docs/inspection.md). |", guide)
        self.assertIn("| MISSING: hw/analysis/v1/arm-load/results.json |", guide)
        self.assertNotIn("not recorded[", guide)
        din = (self.out / "din-spec-3105-1-checklist.md").read_text(encoding="utf-8")
        self.assertIn(f"REQ-002: planned — {sweep}", din)

    def test_okh_paths_are_relative_paths_from_its_folder_not_links(self) -> None:
        hw = self.copy_lamp_example()
        self.make_version(hw, "v1")
        self.generate(hw)
        okh = (self.out / "okh.toml").read_text(encoding="utf-8")
        self.assertIn('source = "../../hw/bom.csv"', okh)
        self.assertIn('validation_method = "../../hw/verification.csv"', okh)
        self.assertIn('files = ["../../hw/versions/v1/manufacturing/"]', okh)
        self.assertNotIn("](", okh)
        self.out = hw / "docs"
        self.generate(hw)
        okh = (self.out / "okh.toml").read_text(encoding="utf-8")
        self.assertIn('source = "../bom.csv"', okh)
        self.assertIn('files = ["../versions/v1/manufacturing/"]', okh)

    def test_a_partial_license_prints_human_owned_never_none(self) -> None:
        hw = self.copy_lamp_example()
        self.make_version(hw, "v1")
        self.set_license(hw, {"hardware": "CERN-OHL-S-2.0"})
        guide = self.generate(hw)
        din = (self.out / "din-spec-3105-1-checklist.md").read_text(encoding="utf-8")
        okh = (self.out / "okh.toml").read_text(encoding="utf-8")
        self.assertIn("documentation: HUMAN-OWNED / MISSING: product.license.documentation; hardware: CERN-OHL-S-2.0", din)
        self.assertIn("| Documentation license | HUMAN-OWNED / MISSING: product.license.documentation |", guide)
        self.assertIn('license = "HUMAN-OWNED: set product.license.documentation', okh)
        for document in (guide, din, okh):
            self.assertNotIn("None", document)

    def test_rev_prepares_the_documents_for_that_release_on_its_given_date(self) -> None:
        hw = self.copy_lamp_example()
        self.make_version(hw, "v1")
        undated = self.run_guide(hw, "--rev", "A")
        self.assertEqual(undated.returncode, 2)
        self.assertIn("pass --date YYYY-MM-DD, the UTC date release.py will seal it", undated.stderr)
        self.assertEqual(self.run_guide(hw, "--date", "2026-11-02").returncode, 2, "--date needs --rev")
        self.assertEqual(self.run_guide(hw, "--rev", "A", "--date", "2026-11-31").returncode, 2)
        self.assertFalse(self.out.exists(), "a refusal writes nothing")
        guide = self.generate(hw, "v1", "--rev", "A", "--date", "2026-11-02")
        prepared = "hw/releases/A/manifest.json (release.py seals it with these documents)"
        self.assertIn(f"| Release manifest | {prepared} |", guide)
        self.assertIn(prepared, (self.out / "din-spec-3105-1-checklist.md").read_text(encoding="utf-8"))
        okh = tomllib.loads((self.out / "okh.toml").read_text(encoding="utf-8"))["okhv"]
        self.assertEqual((okh["version"], okh["release"], okh["release_date"]), ("v1", "A", "2026-11-02"))

    def test_unmeasured_standoff_step_has_readable_gap_prompt(self) -> None:
        hw = self.copy_lamp_example()
        self.make_version(hw, "v1")
        guide = self.generate(hw)
        self.assertIn("stands off the hub top face by the modelled gap; gap not measured: run the assembly drawing for v1", guide)

    def test_minimal_record_lists_fields_and_item_numbers(self) -> None:
        hw = self.root / "minimal-hw"
        (hw / "parts" / "TST-0001").mkdir(parents=True)
        (hw / "versions" / "v1" / "parts").mkdir(parents=True)
        (hw / "product.yaml").write_text("id: minimal\n", encoding="utf-8")
        (hw / "parts" / "TST-0001" / "part.yaml").write_text(
            "PN: TST-0001\nrev: A\ntitle: Test part\nmaterial: steel\nprocess: cnc\nmake_buy: make\n",
            encoding="utf-8",
        )
        (hw / "bom.csv").write_text(
            "level,PN,rev,qty,title,material,process,make_buy\n"
            "1,TST-0001,A,1,Test part,steel,cnc,make\n", encoding="utf-8"
        )
        (hw / "assembly.yaml").write_text(
            "subassemblies:\n  - {id: main, title: Main, parts: [TST-0001]}\n"
            "joints: []\ndrawing:\n  number: TST-ASM\n  rev: A\n  title: Test assembly\n"
            "  views: [{id: front, kind: assembled, direction: front}]\n"
            "  items: [{item: 7, PN: TST-0001}]\n", encoding="utf-8"
        )
        (hw / "versions" / "v1" / "manufacturing" / "TST-0001").mkdir(parents=True)
        (hw / "versions" / "v1" / "manufacturing" / "TST-0001" / "part.step").write_text("fixture STEP", encoding="utf-8")
        (hw / "versions" / "v1" / "manufacturing" / "TST-0001" / "manufacturing.json").write_text("{}\n", encoding="utf-8")
        (hw / "versions" / "v1" / "manifest.json").write_text(json.dumps({"label": "v1", "manufacturing": {
            "TST-0001": {"path": "manufacturing/TST-0001", "outputs": ["part.step", "manufacturing.json"]}}}),
            encoding="utf-8")
        guide = self.generate(hw)
        self.assertIn("| Product | minimal |", guide)
        self.assertIn("| Version | v1 |", guide)
        self.assertIn("[part.step](../../minimal-hw/versions/v1/manufacturing/TST-0001/part.step)", guide)
        self.assertIn("## Parts to buy\n\n| Item no.", guide)
        self.assertIn("## Assembly steps\n\nnot recorded", guide)
        self.assertIn("## Checks before use\n\n| Requirement", guide)
        self.assertEqual(guide.count("<parts "), 1)

    def test_generic_empty_record_outputs_not_recorded_values(self) -> None:
        hw = self.root / "empty-hw"
        hw.mkdir()
        (hw / "versions" / "v1").mkdir(parents=True)
        (hw / "versions" / "v1" / "manifest.json").write_text(
            json.dumps({"label": "v1", "parts": {}}), encoding="utf-8"
        )
        guide = self.generate(hw)
        self.assertIn("| Product | not recorded |", guide)
        self.assertIn("## Parts to make\n\n| Item no.", guide)
        self.assertIn("## Parts to buy\n\n| Item no.", guide)
        self.assertIn("## Parts to buy\n\n| Item no. | PN | Designation or manufacturer PN | Qty | Supplier | Order code | Drawing |", guide)
        self.assertIn("## Tools and consumables\n\n| Step | Items |", guide)
        self.assertIn("## Assembly steps\n\nnot recorded", guide)
        self.assertIn("## Checks before use\n\n| Requirement", guide)

    def test_release_manifest_is_the_release_frozen_at_the_selected_version(self) -> None:
        hw = self.root / "released-hw"
        for version in ("v3", "v4", "v5"):
            (hw / "versions" / version).mkdir(parents=True)
            (hw / "versions" / version / "manifest.json").write_text(
                json.dumps({"label": version, "parts": {}}), encoding="utf-8")
        (hw / "product.yaml").write_text("id: released\n", encoding="utf-8")
        for rev, version, released_at in (("A", "v3", "2026-10-01T00:00:00Z"), ("B", "v4", "2026-10-02T00:00:00Z")):
            (hw / "releases" / rev).mkdir(parents=True)
            (hw / "releases" / rev / "manifest.json").write_text(json.dumps({
                "schema_version": 2, "product_id": "released", "rev": rev, "released_at": released_at,
                "frozen": {"version": version}, "files": {"bom.csv": {"sha256": "0" * 64, "original": "hw/bom.csv"}},
            }), encoding="utf-8")
        for version, link, release in (("v3", "[hw/releases/A/manifest.json](", ("A", "2026-10-01")),
                                       ("v4", "[hw/releases/B/manifest.json](", ("B", "2026-10-02")),
                                       ("v5", "MISSING: no hw/releases/<REV>/manifest.json approves v5 |",
                                        ("not released", "not released"))):
            self.out = self.root / ".cad-work" / f"docs-{version}"  # each guide needs a new output directory
            self.assertIn(f"| Release manifest | {link}", self.generate(hw, version))
            okh = tomllib.loads((self.out / "okh.toml").read_text(encoding="utf-8"))["okhv"]
            self.assertEqual((okh["release"], okh["release_date"]), release)
        self.out = self.root / ".cad-work" / "docs-sealed"
        self.generate(hw, "v3", "--rev", "A")  # a sealed release gives its own date
        okh = tomllib.loads((self.out / "okh.toml").read_text(encoding="utf-8"))["okhv"]
        self.assertEqual((okh["release"], okh["release_date"]), ("A", "2026-10-01"))
        self.out = self.root / ".cad-work" / "docs-misdated"
        misdated = self.run_guide(hw, "--rev", "A", "--date", "2026-10-05", version="v3")
        self.assertEqual(misdated.returncode, 2)
        self.assertIn("release A was sealed on 2026-10-01, not 2026-10-05", misdated.stderr)

    def test_buy_identity_open_fields_remain_visible(self) -> None:
        hw = self.copy_lamp_example()
        self.make_version(hw, "v1")
        part_path = hw / "parts" / "LMP-0008" / "part.yaml"
        part = yaml.safe_load(part_path.read_text(encoding="utf-8"))
        part["procurement"].setdefault("open", {})["supplier_part_number"] = "Supplier has not assigned its order code"
        part_path.write_text(yaml.safe_dump(part, sort_keys=False), encoding="utf-8")
        guide = self.generate(hw)
        self.assertIn("OPEN — supplier_part_number: Supplier has not assigned its order code", guide)

    def test_missing_version_manifest_fails_without_output(self) -> None:
        hw = self.root / "missing-build"
        hw.mkdir()
        (hw / "versions" / "v1").mkdir(parents=True)
        result = subprocess.run(
            ["uv", "run", "--script", str(SCRIPT), str(hw), "--version", "v1", "--out", str(self.out)],
            capture_output=True, text=True, timeout=180,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("version manifest is missing", result.stderr)
        self.assertFalse((self.out / "index.md").exists())


if __name__ == "__main__":
    unittest.main()
