#!/usr/bin/env python3
"""Regression cases for CAD record validation and example-record provenance."""

from __future__ import annotations

import csv
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
import yaml
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
CONCEPT = SKILL.parent / "cad-concept"
TEMPLATE = SKILL / "assets" / "project-template"
LAMP_EXAMPLE = SKILL.parent.parent / "examples" / "lamp-arm"
EXAMPLE = LAMP_EXAMPLE / "hw"
VALIDATOR = SKILL / "scripts" / "validate.py"


class ValidateProject(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="cad-record-test-")
        self.addCleanup(self.temporary.cleanup)
        self.project = Path(self.temporary.name) / "project"
        self.hw = self.project / "hw"
        shutil.copytree(EXAMPLE, self.hw)
        self.part_path = self.hw / "parts" / "LMP-0001" / "part.yaml"

    def set_part(self, pn: str = "LMP-0001", rev: str = "X1") -> None:
        lines = self.part_path.read_text(encoding="utf-8").splitlines()
        lines = [f"PN: {pn}" if line.startswith("PN:") else line for line in lines]
        lines = [f"rev: {rev}" if line.startswith("rev:") else line for line in lines]
        self.part_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def set_joint(self, field: str, value: int) -> None:
        path = self.hw / "assembly.yaml"
        lines = path.read_text(encoding="utf-8").splitlines()
        start = lines.index("    min: -10")
        target = {"min": start, "max": start + 1, "nominal": start + 2}[field]
        lines[target] = f"    {field}: {value}"
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def validate(self, validator: Path = VALIDATOR) -> tuple[subprocess.CompletedProcess[str], dict[str, object]]:
        result = subprocess.run(
            [sys.executable, str(validator), str(self.project)],
            capture_output=True,
            text=True,
            timeout=60,
        )
        return result, json.loads(result.stdout)

    def test_copied_template_with_one_placeholder_part_validates(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="cad-record-template-")
        self.addCleanup(temporary.cleanup)
        project = Path(temporary.name) / "project"
        shutil.copytree(TEMPLATE, project)
        hw = project / "hw"
        part_dir = hw / "parts" / "PRT-0001"
        part_dir.mkdir(parents=True)
        (part_dir / "part.yaml").write_text(
            "PN: PRT-0001\nrev: X1\ntitle: Placeholder part\nmaterial: Placeholder material\n"
            "process: cnc\nfinish: As machined\nmass_target: null\nmake_buy: make\n",
            encoding="utf-8",
        )
        result = subprocess.run([sys.executable, str(VALIDATOR), str(project)], capture_output=True,
                                text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout), {"ok": True, "findings": []})

    def test_empty_template_passes_at_ground_but_requires_parts_at_layout(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="cad-record-empty-template-")
        self.addCleanup(temporary.cleanup)
        project = Path(temporary.name) / "project"
        shutil.copytree(TEMPLATE, project)
        result = subprocess.run([sys.executable, str(VALIDATOR), str(project)], capture_output=True,
                                text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout), {"ok": True, "findings": []})

        product = project / "hw" / "product.yaml"
        product.write_text(product.read_text(encoding="utf-8").replace("stage: ground", "stage: layout"),
                            encoding="utf-8")
        result = subprocess.run([sys.executable, str(VALIDATOR), str(project)], capture_output=True,
                                text=True, timeout=60)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("no part records found", result.stdout)

        product.write_text(product.read_text(encoding="utf-8").replace("stage: layout", "stage: design_freeze")
                            .replace("  recheck_from: ground", "  recheck_from: ground\n  frozen:\n    version: v1\n    manifest_sha256: '" + "0" * 64 + "'\n    decision: DR-001"),
                            encoding="utf-8")
        (project / "hw" / "decisions").mkdir()
        (project / "hw" / "decisions" / "DR-001.md").write_text("# DR-001\n", encoding="utf-8")
        result = subprocess.run([sys.executable, str(VALIDATOR), str(project)], capture_output=True,
                                text=True, timeout=60)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("flow/frozen/version v1 is not a built version", result.stdout)

    def test_example_record_validates(self) -> None:
        result, report = self.validate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(report, {"ok": True, "findings": []})

    def test_product_rejects_nonpositive_build_volume_axis(self) -> None:
        path = self.hw / "product.yaml"
        path.write_text(path.read_text(encoding="utf-8").replace("x_mm: 256", "x_mm: 0"), encoding="utf-8")
        result, report = self.validate()
        self.assertEqual(result.returncode, 1)
        self.assertIn("x_mm", json.dumps(report["findings"]))

    def test_rejects_bad_part_number(self) -> None:
        self.set_part(pn="BAD-one")
        result, report = self.validate()
        self.assertEqual(result.returncode, 1)
        self.assertIn("PN", json.dumps(report["findings"]))

    def test_rejects_each_reserved_revision_letter(self) -> None:
        for revision in "IOQSXZ":
            with self.subTest(revision=revision):
                self.set_part(rev=revision)
                result, report = self.validate()
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn("rev", json.dumps(report["findings"]))

    def test_rejects_joint_minimum_greater_than_maximum(self) -> None:
        self.set_joint("min", 90)
        result, report = self.validate()
        self.assertEqual(result.returncode, 1)
        self.assertIn("minimum exceeds maximum", json.dumps(report["findings"]))

    def test_rejects_joint_nominal_outside_limits(self) -> None:
        self.set_joint("nominal", 81)
        result, report = self.validate()
        self.assertEqual(result.returncode, 1)
        self.assertIn("nominal is outside its limits", json.dumps(report["findings"]))


    def test_rejects_requirement_without_verification_method(self) -> None:
        path = self.hw / "requirements.yaml"
        path.write_text(path.read_text(encoding="utf-8").replace("method: T", "method: X", 1), encoding="utf-8")
        result, report = self.validate()
        self.assertEqual(result.returncode, 1)
        self.assertIn("verification/method", json.dumps(report["findings"]))

    def test_rejects_bom_part_number_absent_from_parts(self) -> None:
        path = self.hw / "bom.csv"
        with path.open(newline="", encoding="utf-8") as stream:
            rows = list(csv.DictReader(stream))
            columns = rows[0].keys()
        rows[0]["PN"] = "LMP-9999"
        with path.open("w", newline="", encoding="utf-8") as stream:
            writer = csv.DictWriter(stream, fieldnames=columns)
            writer.writeheader()
            writer.writerows(rows)
        result, report = self.validate()
        self.assertEqual(result.returncode, 1)
        self.assertIn("has no matching", json.dumps(report["findings"]))

    def test_rejects_joint_parent_outside_assembly_parts(self) -> None:
        path = self.hw / "assembly.yaml"
        path.write_text(path.read_text(encoding="utf-8").replace("parent: LMP-0001", "parent: LMP-9999", 1), encoding="utf-8")
        result, report = self.validate()
        self.assertEqual(result.returncode, 1)
        self.assertIn("does not exist", json.dumps(report["findings"]))

    def test_rejects_joint_type_not_supported_by_pose(self) -> None:
        path = self.hw / "assembly.yaml"
        path.write_text(path.read_text(encoding="utf-8").replace("type: revolute", "type: cylindrical", 1), encoding="utf-8")
        result, report = self.validate()
        self.assertEqual(result.returncode, 1)
        self.assertIn("cylindrical", json.dumps(report["findings"]))

    def test_requires_verification_row_for_each_requirement_at_release(self) -> None:
        path = self.hw / "verification.csv"
        with path.open(newline="", encoding="utf-8") as stream:
            rows = list(csv.DictReader(stream))
            columns = rows[0].keys()
        rows.pop()
        with path.open("w", newline="", encoding="utf-8") as stream:
            writer = csv.DictWriter(stream, fieldnames=columns)
            writer.writeheader()
            writer.writerows(rows)
        result, report = self.validate()
        self.assertEqual(result.returncode, 1)
        self.assertIn("REQ-007 has no verification row", json.dumps(report["findings"]))

    def make_release_ready(self) -> None:
        for part_file in (self.hw / "parts").glob("*/part.yaml"):
            part_file.write_text(
                part_file.read_text(encoding="utf-8").replace("rev: X1", "rev: A"),
                encoding="utf-8",
            )
        bom_path = self.hw / "bom.csv"
        with bom_path.open(newline="", encoding="utf-8") as stream:
            rows = list(csv.DictReader(stream))
            columns = rows[0].keys()
        for row in rows:
            row["rev"] = "A"
        with bom_path.open("w", newline="", encoding="utf-8") as stream:
            writer = csv.DictWriter(stream, fieldnames=columns)
            writer.writeheader()
            writer.writerows(rows)
        verification_path = self.hw / "verification.csv"
        with verification_path.open(newline="", encoding="utf-8") as stream:
            rows = list(csv.DictReader(stream))
            columns = rows[0].keys()
        for row in rows:
            row["result"] = "pass"
        with verification_path.open("w", newline="", encoding="utf-8") as stream:
            writer = csv.DictWriter(stream, fieldnames=columns)
            writer.writeheader()
            writer.writerows(rows)

    def write_release(self, directory: str, rev: str, files: list[str]) -> None:
        release_dir = self.hw / "releases" / directory
        release_dir.mkdir(parents=True, exist_ok=True)
        (release_dir / "manifest.json").write_text(json.dumps({
            "product_id": "lamp-arm",
            "rev": rev,
            "released_at": "2026-10-26T00:00:00Z",
            "files": files,
            "checks": {"record-validation": "pass"},
        }), encoding="utf-8")

    def test_accepts_release_with_existing_files_and_verified_released_parts(self) -> None:
        self.make_release_ready()
        self.write_release("A", "A", ["hw/product.yaml", "hw/bom.csv"])
        result, report = self.validate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(report["findings"], [])

    def test_rejects_release_with_mismatched_directory_missing_file_planned_checks_and_prototype(self) -> None:
        self.write_release("B", "A", ["hw/product.yaml", "hw/not-present.step"])
        result, report = self.validate()
        findings = json.dumps(report["findings"])
        self.assertEqual(result.returncode, 1)
        self.assertIn("directory name does not match manifest rev", findings)
        self.assertIn("release file does not exist within project: hw/not-present.step", findings)
        self.assertIn("verification result must be pass or waived", findings)
        self.assertIn("release cannot include prototype revision X1", findings)

    def test_rejects_part_with_missing_decision_reference(self) -> None:
        path = self.hw / "parts" / "LMP-0001" / "part.yaml"
        text = path.read_text(encoding="utf-8").replace("decisions: [DR-002, DR-004]", "decisions: [DR-999]")
        path.write_text(text, encoding="utf-8")
        result, report = self.validate()
        self.assertEqual(result.returncode, 1)
        self.assertIn("decision DR-999 does not exist", json.dumps(report["findings"]))

    def test_validates_optional_concept_handoff(self) -> None:
        source = CONCEPT / "assets" / "examples" / "lamp-arm.scene.json"
        scene = json.loads(source.read_text(encoding="utf-8"))
        scene["chosen"] = scene["variants"][0]["id"]
        scene_path = self.hw / "concept" / "lamp-arm.scene.json"
        scene_path.parent.mkdir(parents=True)
        self.addCleanup(shutil.rmtree, scene_path.parent, ignore_errors=True)
        scene_path.write_text(json.dumps(scene), encoding="utf-8")
        handoff_path = scene_path.parent / "handoff.json"
        handoff = subprocess.run(
            [sys.executable, str(CONCEPT / "scripts" / "concept.py"), "handoff", str(scene_path), "--out", str(handoff_path)],
            capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(handoff.returncode, 0, handoff.stdout + handoff.stderr)
        self.assertTrue(json.loads(handoff.stdout)["ok"])
        result, report = self.validate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(report["findings"], [])

    def test_reports_info_when_concept_handoff_schema_is_missing(self) -> None:
        handoff_path = self.hw / "concept" / "handoff.json"
        handoff_path.parent.mkdir(parents=True)
        handoff_path.write_text("{}", encoding="utf-8")
        validator_copy = self.project / "skill" / "scripts" / "validate.py"
        validator_copy.parent.mkdir(parents=True)
        shutil.copy2(VALIDATOR, validator_copy)
        for sibling in ("assembly_data.py", "design_rules.py", "layout.py"):
            shutil.copy2(VALIDATOR.with_name(sibling), validator_copy.with_name(sibling))
        shutil.copytree(SKILL / "schemas", self.project / "skill" / "schemas")
        shutil.copy2(SKILL / "layout.json", self.project / "skill" / "layout.json")
        coupling_copy = self.project / "cad-motion" / "scripts" / "coupling.py"  # the sibling skill's module
        coupling_copy.parent.mkdir(parents=True)
        shutil.copy2(SKILL.parent / "cad-motion" / "scripts" / "coupling.py", coupling_copy)
        result, report = self.validate(validator_copy)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(any(item["severity"] == "info" and "skipped handoff schema validation" in item["message"] for item in report["findings"]))

    def edit_assembly(self, old: str, new: str) -> None:
        path = self.hw / "assembly.yaml"
        text = path.read_text(encoding="utf-8")
        self.assertIn(old, text)
        path.write_text(text.replace(old, new, 1), encoding="utf-8")

    def messages(self) -> list[str]:
        result, report = self.validate()
        self.assertEqual(result.returncode, 1, result.stdout)
        return [item["message"] for item in report["findings"]]

    def test_a_bare_pn_placed_three_times_is_an_ambiguous_joint_endpoint(self) -> None:
        self.edit_assembly('child: "@ring-elbow"', "child: LMP-0011")
        self.assertTrue(any("ambiguous" in m and "@ring-base, @ring-elbow, @ring-head" in m for m in self.messages()))

    def test_an_unknown_occurrence_reference_is_rejected(self) -> None:
        self.edit_assembly('child: "@ring-head"', 'child: "@ring-tail"')
        self.assertTrue(any("@ring-tail names no occurrence" in m for m in self.messages()))

    def test_a_repeated_part_must_be_part_local(self) -> None:
        path = self.hw / "parts" / "LMP-0011" / "part.yaml"
        path.write_text(path.read_text(encoding="utf-8").replace("model_frame: part_local\n", ""), encoding="utf-8")
        self.assertTrue(any("LMP-0011 is placed 3 times but its model_frame is assembly_zero" in m for m in self.messages()))

    def test_bom_quantity_must_match_the_occurrence_count(self) -> None:
        path = self.hw / "bom.csv"
        path.write_text(path.read_text(encoding="utf-8").replace("1,LMP-0011,X1,3,", "1,LMP-0011,X1,2,"), encoding="utf-8")
        self.assertTrue(any("BOM quantity of LMP-0011 is 2" in m and "places it 3 times" in m for m in self.messages()))

    def test_an_explicit_pn_cannot_also_be_a_legacy_member(self) -> None:
        self.edit_assembly("LMP-0009, LMP-0010]", "LMP-0009, LMP-0010, LMP-0011]")
        self.assertTrue(any("lists LMP-0011 in parts, but LMP-0011 has explicit occurrences" in m for m in self.messages()))

    def test_an_occurrence_needs_finite_placement_and_one_group(self) -> None:
        self.edit_assembly("translation_mm: [0, 0, 21.495]", "translation_mm: [0, 0, .nan]")
        self.edit_assembly('occurrences: ["@ring-base", ', "occurrences: [")
        found = self.messages()
        self.assertTrue(any("translation_mm" in m for m in found), found)

    def test_an_occurrence_belonging_to_no_group_is_rejected(self) -> None:
        self.edit_assembly('occurrences: ["@ring-base", ', "occurrences: [")
        self.assertTrue(any("@ring-base belongs to no subassembly" in m for m in self.messages()))

    def test_a_heat_set_pair_naming_an_occurrence_of_another_part_is_rejected(self) -> None:
        path = self.hw / "interfaces.yaml"
        text = path.read_text(encoding="utf-8").replace("pair: [LMP-0004, LMP-0010]", 'pair: [LMP-0004, "@ring-hub"]')
        path.write_text(text, encoding="utf-8")
        self.assertTrue(any("@ring-hub names no occurrence" in m for m in self.messages()))

    def add_clearance(self, pair: str, minimum: object = 2.0, kind: str = "clearance", number: int = 6) -> None:
        """Append a clearance requirement interface IF-00<number> to the lamp example's interfaces.yaml."""
        path = self.hw / "interfaces.yaml"
        with path.open("a", encoding="utf-8") as stream:
            stream.write(f"  - {{id: IF-00{number}, from: head, to: base_plate, type: {kind}, "
                         f"description: The head clears the base plate., pair: {pair}, min_clearance_mm: {minimum}}}\n")

    def test_a_clearance_requirement_on_two_occurrences_validates(self) -> None:
        self.add_clearance('[LMP-0004, "@ring-base"]')
        result, report = self.validate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(report["findings"], [])

    def test_a_clearance_requirement_rejects_an_unresolved_reference(self) -> None:
        self.add_clearance('[LMP-0004, "@ring-tail"]', number=6)
        self.add_clearance("[LMP-0099, LMP-0001]", number=7)
        self.add_clearance("[LMP-0011, LMP-0001]", number=8)
        found = self.messages()
        self.assertTrue(any(m.startswith("interfaces/5/pair:") and "@ring-tail names no occurrence" in m for m in found), found)
        self.assertIn("interfaces/6/pair: part LMP-0099 does not exist", found)
        self.assertTrue(any(m.startswith("interfaces/7/pair:") and "ambiguous" in m for m in found), found)

    def test_a_clearance_requirement_needs_a_positive_minimum_and_its_type(self) -> None:
        for minimum, kind, expected in ((0, "clearance", "less than or equal to the minimum of 0"),
                                        (-1.5, "clearance", "less than or equal to the minimum of 0"),
                                        (2.0, "mounting", "'clearance' was expected")):
            with self.subTest(minimum=minimum, kind=kind):
                shutil.copy2(EXAMPLE / "interfaces.yaml", self.hw / "interfaces.yaml")
                self.add_clearance("[LMP-0004, LMP-0001]", minimum, kind)
                found = self.messages()
                self.assertTrue(any(m.startswith("interfaces/5") and expected in m for m in found), found)

    def test_a_clearance_pair_without_a_minimum_is_rejected(self) -> None:
        path = self.hw / "interfaces.yaml"
        with path.open("a", encoding="utf-8") as stream:
            stream.write("  - {id: IF-006, from: head, to: base, type: clearance, description: Gap., pair: [LMP-0004, LMP-0001]}\n")
        self.assertTrue(any("'min_clearance_mm' is a dependency of 'pair'" in m for m in self.messages()))

    def test_a_clearance_requirement_on_one_occurrence_is_rejected(self) -> None:
        self.add_clearance('["@ring-base", "@ring-base"]')
        self.assertTrue(any(m.startswith("interfaces/5/pair:") and "non-unique" in m for m in self.messages()))
        # A PN placed once and its @id name one occurrence: make @ring-head the one, part-local LMP-0010.
        shutil.copy2(EXAMPLE / "interfaces.yaml", self.hw / "interfaces.yaml")
        self.edit_assembly("  - id: ring-head\n    PN: LMP-0011", "  - id: ring-head\n    PN: LMP-0010")
        self.edit_assembly("LMP-0009, LMP-0010]", "LMP-0009]")
        with (self.hw / "parts" / "LMP-0010" / "part.yaml").open("a", encoding="utf-8") as part:
            part.write("model_frame: part_local\n")
        self.add_clearance('[LMP-0010, "@ring-head"]')
        self.assertIn("interfaces/5/pair: LMP-0010 and @ring-head are the same occurrence", self.messages())

    def test_an_occurrence_pair_takes_one_clearance_requirement(self) -> None:
        self.add_clearance('[LMP-0004, "@ring-base"]', number=6)
        self.add_clearance('["@ring-base", LMP-0004]', 3.0, number=7)
        self.assertIn('interfaces/6/pair: @ring-base / LMP-0004 already has a clearance requirement at interfaces/5',
                      self.messages())

    HEAD = "    min: -45\n    max: 45\n    nominal: 0\n"  # J-003, the head joint
    ELBOW = "    min: -120\n    max: 0\n    nominal: -30\n"  # J-002, the elbow joint

    def couple_head(self, coupling: str) -> None:
        self.edit_assembly(self.HEAD, f"    min: -45\n    max: 45\n    coupling: {coupling}\n")

    def test_a_coupled_joint_validates_without_a_nominal(self) -> None:
        self.couple_head("{type: linear, driver: J-002, ratio: 0.25}")
        result, report = self.validate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(report["findings"], [])

    def test_a_self_coupling_is_rejected(self) -> None:
        self.couple_head("{type: linear, driver: J-003, ratio: 1}")
        self.assertIn("J-003 coupling: J-003 is coupled to itself", self.messages())

    def test_a_coupling_cycle_is_rejected_by_name(self) -> None:
        self.couple_head("{type: linear, driver: J-002, ratio: 1}")
        self.edit_assembly(self.ELBOW, "    min: -120\n    max: 0\n    coupling: {type: linear, driver: J-003, ratio: 1}\n")
        self.assertTrue(any(m.startswith("coupling cycle: J-00") and "(each joint drives the next)" in m
                            for m in self.messages()))

    def test_a_missing_driver_or_profile_is_rejected(self) -> None:
        self.couple_head("{type: linear, driver: J-099, ratio: 1}")
        self.assertIn("J-003 coupling: driver J-099 is not a joint of this assembly", self.messages())
        self.couple_head_again("{type: periodic_table, driver: J-002, profile: tilt}")
        self.assertIn("J-003 coupling: profile 'tilt' is not in `profiles`", self.messages())

    def couple_head_again(self, coupling: str) -> None:
        path = self.hw / "assembly.yaml"
        lines = path.read_text(encoding="utf-8").splitlines()
        index = next(i for i, line in enumerate(lines) if line.startswith("    coupling: "))
        lines[index] = f"    coupling: {coupling}"
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def test_a_derived_coordinate_beyond_its_limits_is_rejected(self) -> None:
        self.couple_head("{type: linear, driver: J-002, ratio: 1}")  # J-003 would follow J-002 down to -120
        self.assertIn("J-003 follows J-002 (linear ratio 1 offset 0) reaches -120 deg at J-002 = -120 deg, "
                      "outside its limits [-45, 45]", self.messages())

    def test_a_coupled_joint_cannot_also_author_a_nominal(self) -> None:
        self.edit_assembly(self.HEAD, self.HEAD + "    coupling: {type: linear, driver: J-002, ratio: 0.25}\n")
        self.assertTrue(any(m.startswith("joints/2: ") and "is valid under each of" in m for m in self.messages()))

    def test_a_fixed_joint_cannot_be_coupled(self) -> None:
        assembly = yaml.safe_load((self.hw / "assembly.yaml").read_text(encoding="utf-8"))
        fixed = next(joint for joint in assembly["joints"] if joint["type"] == "fixed")
        del fixed["nominal"]
        fixed["coupling"] = {"type": "linear", "driver": "J-001", "ratio": 1}
        (self.hw / "assembly.yaml").write_text(yaml.safe_dump(assembly, sort_keys=False), encoding="utf-8")
        self.assertTrue(any(f"joints/3: 'nominal' is a required property" == m for m in self.messages()))

    def author_motion_case(self, case: str, to: str) -> Path:
        path = self.hw / "motion" / "cases" / case / "plan.yaml"
        path.parent.mkdir(parents=True)
        path.write_text(f"schema: 1\nsegments:\n  - id: reach\n    to: {to}\n    camera: iso\n", encoding="utf-8")
        return path.parent

    def motion_findings(self) -> tuple[int, list[tuple[str, str, str]]]:
        result, report = self.validate()
        return result.returncode, [(item["path"], item["severity"], item["message"]) for item in report["findings"]
                                   if "/motion/" in item["path"]]

    def test_an_authored_motion_case_inside_the_joint_limits_validates(self) -> None:
        self.author_motion_case("reach-out", "{J-001: 80, J-002: -120}")
        self.assertEqual(self.motion_findings(), (0, []))

    def test_motion_cases_are_checked_when_a_member_is_left_for_attach(self) -> None:
        # Without J-010 the base ring has no joint path to the ground, which `--attach` connects at run time.
        self.edit_assembly('  - id: J-010\n    type: fixed\n    parent: LMP-0005\n    child: "@ring-base"\n'
                           "    axis: [0, 0, 1]\n    origin: [0, 0, 40]\n    min: 0\n    max: 0\n    nominal: 0\n", "")
        self.author_motion_case("reach-out", "{J-001: 80, J-002: -120}")
        too_far = str(self.author_motion_case("too-far", "{J-002: 30}"))
        self.assertEqual(self.motion_findings(),
                         (1, [(too_far, "error", "segments[0] (reach): J-002 = 30 deg is outside [-120, 0]")]))

    def test_an_authored_motion_case_names_each_target_the_render_would_refuse(self) -> None:
        self.couple_head("{type: linear, driver: J-002, ratio: 0.25}")
        case = str(self.author_motion_case("reach-out", "{J-002: 30, J-003: 10, J-099: 1}"))
        code, findings = self.motion_findings()
        self.assertEqual(code, 1)
        problems = {message for path, severity, message in findings if path == case and severity == "error"}
        self.assertIn("segments[0] (reach): J-002 = 30 deg is outside [-120, 0]", problems)
        self.assertTrue(any(m.startswith("segments[0] (reach): J-003 follows J-002") and m.endswith("move its driver instead")
                            for m in problems), problems)
        self.assertTrue(any(m.startswith("segments[0] (reach): J-099 is not a joint of this record") for m in problems))

    def test_the_generated_default_motion_case_cannot_be_authored(self) -> None:
        case = self.author_motion_case("default", "{J-001: 0}")
        for contents in ("an authored plan", "no plan"):
            if contents == "no plan":
                (case / "plan.yaml").replace(case / ".gitkeep")
            result, report = self.validate()
            self.assertEqual(result.returncode, 1, f"{contents}: {result.stderr}")
            self.assertTrue(any(item["path"] == str(case) and "case `default` is reserved" in item["message"]
                                for item in report["findings"]), f"{contents}: {report['findings']}")

    def test_a_joint_without_nominal_is_reported_beside_an_authored_motion_case(self) -> None:
        self.edit_assembly(self.ELBOW, "    min: -120\n    max: 0\n")
        self.author_motion_case("reach-out", "{J-002: -60}")
        result, report = self.validate()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertTrue(any(item["message"].startswith("joints/1: ") for item in report["findings"]))


if __name__ == "__main__":
    unittest.main()
