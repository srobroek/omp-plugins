#!/usr/bin/env python3
"""Design rules: the clearance margin, retention, process feasibility and visibility bindings, through the
record validator on a copy of the lamp example and through design_rules.py's public functions."""

from __future__ import annotations

import importlib.util
import math
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Callable

import yaml

SKILL = Path(__file__).resolve().parents[1]
SCRIPTS = SKILL / "scripts"
LAMP = SKILL.parent.parent / "examples" / "lamp-arm" / "hw"


def load(name: str, path: Path) -> Any:
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, path)
        assert spec and spec.loader
        sys.modules[name] = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sys.modules[name])
    return sys.modules[name]


rules = load("cad_record_design_rules", SCRIPTS / "design_rules.py")
validate = load("cad_record_validate", SCRIPTS / "validate.py")


class LampRecord(unittest.TestCase):
    """A copy of the lamp example, edited one document at a time and validated in process."""

    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="cad-record-rules-")
        self.addCleanup(temporary.cleanup)
        self.hw = Path(temporary.name) / "project" / "hw"
        shutil.copytree(LAMP, self.hw)

    def edit(self, name: str, change: Callable[[Any], None]) -> None:
        path = self.hw / name
        document = yaml.safe_load(path.read_text(encoding="utf-8"))
        change(document)
        path.write_text(yaml.safe_dump(document, sort_keys=False), encoding="utf-8")

    def stage(self, stage: str) -> None:
        self.edit("product.yaml", lambda product: product["flow"].update(stage=stage))

    def joint(self, joint_id: str, **fields: Any) -> None:
        def change(assembly: dict[str, Any]) -> None:
            joint = next(joint for joint in assembly["joints"] if joint["id"] == joint_id)
            for key, value in fields.items():
                if value is None:
                    joint.pop(key, None)
                else:
                    joint[key] = value
        self.edit("assembly.yaml", change)

    def fit(self, interface: int, kind: str, **fields: Any) -> None:
        def change(document: dict[str, Any]) -> None:
            fit = document["interfaces"][interface]["limits"][kind]
            for key, value in fields.items():
                if value is None:
                    fit.pop(key, None)
                else:
                    fit[key] = value
        self.edit("interfaces.yaml", change)

    def part(self, pn: str, **fields: Any) -> None:
        self.edit(f"parts/{pn}/part.yaml", lambda part: part.update(fields))

    def findings(self) -> list[dict[str, Any]]:
        return validate.validate_project(self.hw.parent)

    def coded(self, prefix: str) -> dict[str, dict[str, Any]]:
        """Findings whose code starts with `prefix`, by their path below hw/."""
        return {item["path"][len(str(self.hw)) + 1:]: item for item in self.findings()
                if str(item.get("code", "")).startswith(prefix)}


class Retention(LampRecord):
    def test_the_lamp_example_is_clean_at_parts(self) -> None:
        self.stage("parts")
        self.assertEqual(validate.blocking(self.findings()), [])

    def test_a_fit_without_an_axial_retainer_is_an_error_from_parts_on(self) -> None:
        self.fit(1, "locating_fit", axial_retainer=None)
        self.assertEqual(self.coded("retention."), {}, "not reported before stage parts")
        self.stage("parts")
        found = self.coded("retention.")
        self.assertEqual(list(found), ["interfaces.yaml#/interfaces/1/limits/locating_fit"])
        item = found["interfaces.yaml#/interfaces/1/limits/locating_fit"]
        self.assertEqual((item["code"], item["severity"]), ("retention.axial_retainer", "error"))
        self.assertIn("IF-002 locating_fit 5 H7/f7 has no `axial_retainer`", item["message"])

    def test_a_running_fit_needs_no_axial_retainer(self) -> None:
        self.stage("parts")
        self.fit(0, "running_fit", axial_retainer={"type": "shoulder"})
        self.fit(1, "running_fit", axial_retainer=None)
        self.assertEqual(self.coded("retention."), {})

    def test_a_clearance_fit_cannot_be_held_by_its_own_press_fit(self) -> None:
        self.stage("parts")
        self.fit(2, "locating_fit", axial_retainer={"type": "press_fit"})
        self.assertEqual(list(self.coded("retention.axial_retainer")),
                         ["interfaces.yaml#/interfaces/2/limits/locating_fit/axial_retainer"])

    def test_a_hardware_retainer_names_modelled_occurrences(self) -> None:
        self.stage("parts")
        for retainer, why in (({"type": "circlip"}, "needs `parts`"),
                              ({"type": "circlip", "parts": ["@ring-gone"]}, "@ring-gone do not resolve"),
                              ({"type": "circlip", "parts": ["LMP-0011"]}, "LMP-0011 do not resolve")):
            with self.subTest(retainer=retainer):
                self.fit(1, "locating_fit", axial_retainer=retainer)
                found = self.coded("retention.axial_retainer")
                self.assertEqual(list(found), ["interfaces.yaml#/interfaces/1/limits/locating_fit/axial_retainer"])
                self.assertIn(why, next(iter(found.values()))["message"])
        self.fit(1, "locating_fit", axial_retainer={"type": "shoulder"})
        self.assertEqual(self.coded("retention."), {}, "a feature retainer names no hardware")

    def test_an_undeclared_revolute_and_the_fixed_joints_on_its_child_are_reported_in_one_run(self) -> None:
        for joint in ("J-001", "J-003"):
            self.joint(joint, torque=None)
        self.assertEqual(self.coded("retention."), {}, "not reported before stage parts")
        self.stage("parts")
        found = self.coded("retention.torque_path")
        # J-001 and J-003 themselves, the lower link's J-004, J-005, J-010 and J-011, and the head's J-008 and
        # J-009. J-002 is declared none, so the upper link's J-006 and J-012 stay quiet.
        self.assertEqual(sorted(found), [f"assembly.yaml#/joints/J-{n:03d}" for n in (1, 3, 4, 5, 8, 9, 10, 11)])
        self.assertIn("J-001 turns LMP-0002 but declares no torque", found["assembly.yaml#/joints/J-001"]["message"])

    def test_the_engine_crank_reports_its_web_and_flywheel_on_the_first_run(self) -> None:
        # The engine record before any declaration: crank J-009 (block -> web set), and the web set's shaft
        # J-014 and flywheel J-015 fixed to it, none with a torque or torque path.
        def fixed(joint_id: str, parent: str, child: str) -> dict[str, Any]:
            return {"id": joint_id, "type": "fixed", "parent": parent, "child": child, "nominal": 0}
        assembly = {"joints": [
            {"id": "J-009", "type": "revolute", "parent": "VSX-0011", "child": "VSX-0101", "nominal": 0},
            fixed("J-014", "VSX-0101", "VSX-0102"), fixed("J-015", "VSX-0101", "VSX-0110"),
            fixed("J-020", "VSX-0011", "VSX-0012")]}  # the block's own fixed joint does not rotate
        found = rules.torque_path_findings(assembly, lambda ref: ref)
        self.assertEqual([(item.code, item.location) for item in found],
                         [("retention.torque_path", "joints/J-009"), ("retention.torque_path", "joints/J-014"),
                          ("retention.torque_path", "joints/J-015")])

    def test_an_uncoupled_drive_shaft_flags_every_undeclared_fixed_joint_on_it(self) -> None:
        # The engine's crankshaft: an independent revolute (no coupling, drives none) that carries the drive
        # torque, with the web set, shaft and flywheel fixed to it.
        self.stage("parts")
        self.joint("J-001", torque="transmitted")
        found = self.coded("retention.torque_path")
        # J-001's child, the lower link, holds J-004 and J-005 and their rings J-010 and J-011. J-002 (torque:
        # none) starts no drive train, and the revolute itself needs no torque_path.
        self.assertEqual(sorted(found), [f"assembly.yaml#/joints/J-{n:03d}" for n in (4, 5, 10, 11)])
        self.assertTrue(all(item["severity"] == "error" for item in found.values()))
        self.assertIn("inside a drive train but declares no torque", found["assembly.yaml#/joints/J-004"]["message"])

    def test_a_transmitting_fixed_joint_names_its_torque_path(self) -> None:
        self.stage("parts")
        self.joint("J-001", torque="transmitted")
        for joint in ("J-005", "J-010", "J-011"):
            self.joint(joint, torque="none")
        cases = (
            ({"torque": "transmitted"}, "assembly.yaml#/joints/J-004", "without a `torque_path`"),
            ({"torque": "transmitted", "torque_path": {"type": "set_screw"}},
             "assembly.yaml#/joints/J-004/torque_path", "needs `parts`"),
            ({"torque": "transmitted", "torque_path": {"type": "key", "parts": ["@no-key"]}},
             "assembly.yaml#/joints/J-004/torque_path", "@no-key do not resolve"),
        )
        for fields, location, why in cases:
            with self.subTest(fields=fields):
                self.joint("J-004", **{"torque_path": None, **fields})
                found = self.coded("retention.torque_path")
                self.assertEqual(list(found), [location])
                self.assertIn(why, found[location]["message"])
        for fields in ({"torque": "transmitted", "torque_path": {"type": "press_fit", "decision": "DR-004"}},
                       {"torque": "transmitted", "torque_path": {"type": "pin", "parts": ["LMP-0005"]}},
                       {"torque": "none", "torque_path": None}):
            with self.subTest(fields=fields):
                self.joint("J-004", **fields)
                self.assertEqual(self.coded("retention."), {})

    def test_torque_and_retainer_decisions_exist(self) -> None:
        self.joint("J-004", torque="transmitted", torque_path={"type": "press_fit", "decision": "DR-099"})
        self.fit(0, "press_fit", axial_retainer={"type": "press_fit", "decision": "DR-098"})
        messages = [item["message"] for item in validate.blocking(self.findings())]
        self.assertIn("J-004 torque_path/decision DR-099 does not exist at decisions/DR-099.md", messages)
        self.assertIn("interfaces/0/limits/press_fit/axial_retainer/decision DR-098 does not exist at "
                      "decisions/DR-098.md", messages)

    def test_a_revolute_declared_transmitted_starts_a_drive_train(self) -> None:
        self.stage("parts")
        self.joint("J-003", torque="transmitted", torque_path={"type": "clamp"})
        self.assertEqual(sorted(self.coded("retention.torque_path")),
                         ["assembly.yaml#/joints/J-008", "assembly.yaml#/joints/J-009"])


class Schemas(LampRecord):
    """The schemas accept the final contract fields and reject malformed values."""

    def accept_everything(self) -> None:
        self.edit("product.yaml", lambda product: product.update(
            design={"clearance_margin_mm": 0.2},
            manufacturing={"processes": ["fdm", "cnc", "purchased"], "min_wall_mm": {"fdm": 1.2, "cnc": 0.8}},
            storage={"results_in_git": False}))
        self.part("LMP-0001", form_class="frame", transparency="opaque")
        self.edit("interfaces.yaml", lambda document: document["interfaces"].append({
            "id": "IF-006", "from": "base", "to": "head", "type": "clearance", "description": "Head clears the base",
            "pair": ["LMP-0001", "LMP-0004"], "min_clearance_mm": 0.5, "margin_mm": 0.0}))
        self.joint("J-004", torque="transmitted", torque_path={"type": "press_fit", "decision": "DR-004"})
        self.edit("requirements.yaml", lambda document: document["requirements"][0].update(visibility=[
            {"view": "dir-p1-m1d5-p0", "window": ["LMP-0004"], "targets": ["LMP-0009"], "min_visible_fraction": 1},
            {"view": "front", "window": ["@ring-head"], "targets": ["LMP-0007", "LMP-0003"]}]))

    def test_the_final_fields_validate(self) -> None:
        self.accept_everything()
        self.stage("parts")
        self.assertEqual(validate.blocking(self.findings()), [])

    def test_malformed_values_are_rejected(self) -> None:
        def requirement(binding: dict[str, Any]) -> Callable[[], None]:
            return lambda: self.edit("requirements.yaml", lambda document: document["requirements"][0].update(
                visibility=[{"view": "iso", "window": ["LMP-0004"], "targets": ["LMP-0009"], **binding}]))

        cases: dict[str, tuple[Callable[[], None], str]] = {
            "unknown form class": (lambda: self.part("LMP-0001", form_class="block"), "form_class"),
            "unknown transparency": (lambda: self.part("LMP-0001", transparency="clear"), "transparency"),
            "negative global margin": (lambda: self.edit("product.yaml", lambda p: p.update(
                design={"clearance_margin_mm": -0.1})), "design/clearance_margin_mm"),
            "minimum wall for a bought part": (lambda: self.edit("product.yaml", lambda p: p.update(
                manufacturing={"min_wall_mm": {"purchased": 1.0}})), "manufacturing/min_wall_mm"),
            "zero minimum wall": (lambda: self.edit("product.yaml", lambda p: p.update(
                manufacturing={"min_wall_mm": {"fdm": 0}})), "manufacturing/min_wall_mm/fdm"),
            "unknown planned process": (lambda: self.edit("product.yaml", lambda p: p.update(
                manufacturing={"processes": ["sla"]})), "manufacturing/processes/0"),
            "storage answer as text": (lambda: self.edit("product.yaml", lambda p: p.update(
                storage={"results_in_git": "yes"})), "storage/results_in_git"),
            "interface margin without a requirement": (lambda: self.edit("interfaces.yaml", lambda d: d["interfaces"][3]
                                                                         .update(margin_mm=0.1)), "interfaces/3"),
            "torque on a prismatic joint": (lambda: self.edit("assembly.yaml", lambda a: a["joints"][0].update(
                type="prismatic", torque="none")), "joints/0"),
            "torque path without transmitted torque": (lambda: self.joint(
                "J-004", torque="none", torque_path={"type": "key"}), "joints/3"),
            "integral torque path": (lambda: self.joint(
                "J-004", torque="transmitted", torque_path={"type": "integral"}), "joints/3/torque_path/type"),
            "unknown axial retainer": (lambda: self.fit(0, "press_fit", axial_retainer={"type": "glue"}),
                                       "interfaces/0/limits/press_fit"),
            "exploded visibility view": (requirement({"view": "exploded"}), "requirements/0/visibility/0/view"),
            "all-zero view direction": (requirement({"view": "dir-p0-m0-p0"}), "requirements/0/visibility/0/view"),
            "zero visible fraction": (requirement({"min_visible_fraction": 0}),
                                      "requirements/0/visibility/0/min_visible_fraction"),
            "empty window": (requirement({"window": []}), "requirements/0/visibility/0/window"),
        }
        for name, (change, location) in cases.items():
            with self.subTest(name), tempfile.TemporaryDirectory() as tmp:
                self.hw = Path(tmp) / "project" / "hw"
                shutil.copytree(LAMP, self.hw)
                change()
                messages = [item["message"] for item in validate.blocking(self.findings())]
                self.assertTrue(any(message.startswith(location) for message in messages), messages)


class ClearanceMargin(unittest.TestCase):
    def test_the_global_default_is_a_tenth_of_a_millimetre(self) -> None:
        margins = rules.clearance_margins({"id": "x"}, None)
        self.assertEqual((margins.default_mm, margins.for_interface(None)), (0.1, 0.1))

    def test_an_interface_override_beats_the_product_margin(self) -> None:
        interfaces = {"interfaces": [
            {"id": "IF-001", "pair": ["A-0001", "B-0001"], "min_clearance_mm": 0.5, "margin_mm": 0},
            {"id": "IF-002", "pair": ["A-0001", "C-0001"], "min_clearance_mm": 0.5},
            {"id": "IF-003", "type": "mounting"}]}
        margins = rules.clearance_margins({"design": {"clearance_margin_mm": 0.25}}, interfaces)
        self.assertEqual(dict(margins.by_interface), {"IF-001": 0.0, "IF-002": 0.25})
        self.assertEqual((margins.for_interface("IF-001"), margins.for_interface("IF-002"),
                          margins.for_interface(None)), (0.0, 0.25, 0.25))
        with self.assertRaises(KeyError):
            margins.for_interface("IF-003")  # not a clearance requirement

    def test_malformed_margins_raise_instead_of_defaulting(self) -> None:
        for value in (-0.1, True, "0.2", math.nan, math.inf):
            with self.subTest(value=value), self.assertRaises(ValueError):
                rules.clearance_margins({"design": {"clearance_margin_mm": value}}, None)
        with self.assertRaisesRegex(ValueError, "margin_mm needs min_clearance_mm"):
            rules.clearance_margins(None, {"interfaces": [{"id": "IF-001", "margin_mm": 0.1}]})
        with self.assertRaises(ValueError):
            rules.clearance_margins(["not", "a", "product"], None)

    def test_the_loader_reads_a_version_record_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            record = Path(tmp) / "versions" / "v3" / "record"
            self.assertEqual(rules.load_clearance_margins(record).default_mm, 0.1, "no files: the default")
            record.mkdir(parents=True)
            (record / "product.yaml").write_text("design:\n  clearance_margin_mm: 0.15\n", encoding="utf-8")
            (record / "interfaces.yaml").write_text(
                "interfaces:\n  - {id: IF-007, pair: [A-0001, B-0001], min_clearance_mm: 0.5, margin_mm: 0.3}\n",
                encoding="utf-8")
            margins = rules.load_clearance_margins(record)
            self.assertEqual((margins.for_interface(None), margins.for_interface("IF-007")), (0.15, 0.3))
            (record / "product.yaml").write_text("design: [\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "cannot read"):
                rules.load_clearance_margins(record)


class ProcessFeasibility(LampRecord):
    SEE_THROUGH = ("As printed, clear PETG; 0.2 mm layers", "Transparent PETG", "The cam covers are clear",
                   "Pistons visible through the bore window", "Glass cover over the dial", "clear-material parts",
                   "PETG (clear)")
    NOT_SEE_THROUGH = ("Not transparent; black PETG", "Non-transparent smoke PETG", "never see-through",
                       "Keep 3 mm clear of the hinge", "The cover is clear of the belt", "Clear coat over black PETG",
                       "A clear window for the cable", "Bond the lens with clear silicone",
                       "Glass-filled nylon")

    def test_prose_that_reads_as_see_through_is_recognised(self) -> None:
        for text in self.SEE_THROUGH:
            with self.subTest(text):
                self.assertTrue(rules.transparency_claimed(text))
        for text in self.NOT_SEE_THROUGH:
            with self.subTest(text):
                self.assertFalse(rules.transparency_claimed(text))

    def test_clear_fdm_prose_only_ever_warns(self) -> None:
        # The engine's rev A cam cover: "As printed, clear PETG" on an FDM part.
        self.part("LMP-0001", finish="As printed, clear PETG; 0.2 mm layers")
        location = "parts/LMP-0001/part.yaml#/finish"
        for stage in ("layout", "parts", "release"):
            with self.subTest(stage):
                self.stage(stage)
                self.assertEqual({path: (item["code"], item["severity"])
                                  for path, item in self.coded("feasibility.").items()},
                                 {location: ("feasibility.transparency_claim", "warning")})
        self.part("LMP-0001", transparency="translucent")
        self.assertEqual(self.coded("feasibility."), {}, "a declared transparency resolves it")

    def test_a_transparent_fdm_part_warns_before_parts_and_fails_from_parts_on(self) -> None:
        self.part("LMP-0001", transparency="transparent")
        location = "parts/LMP-0001/part.yaml#/transparency"
        self.assertEqual({path: (item["code"], item["severity"]) for path, item in self.coded("feasibility.").items()},
                         {location: ("feasibility.transparent_fdm", "warning")})
        self.stage("parts")
        self.assertEqual({path: (item["code"], item["severity"]) for path, item in self.coded("feasibility.").items()},
                         {location: ("feasibility.transparent_fdm", "error")})

    def test_non_fdm_parts_are_never_flagged(self) -> None:
        self.stage("parts")
        self.part("LMP-0002", material="Clear acrylic (PMMA)", transparency="transparent")
        self.part("LMP-0008", finish="Clear PETG sleeve, as supplied")
        self.assertEqual(self.coded("feasibility."), {})

    def test_a_see_through_requirement_warns_until_a_non_fdm_part_is_transparent(self) -> None:
        self.edit("requirements.yaml", lambda document: document["requirements"][1].update(
            text="The head carries a transparent window over the bulb."))
        self.stage("parts")
        self.assertEqual({path: (item["code"], item["severity"]) for path, item in self.coded("feasibility.").items()},
                         {"requirements.yaml#/requirements/1": ("feasibility.transparency_claim", "warning")})
        self.part("LMP-0004", transparency="transparent")
        self.assertEqual(self.coded("feasibility.")["parts/LMP-0004/part.yaml#/transparency"]["severity"], "error",
                         "an FDM part cannot be that transparent part")
        self.part("LMP-0004", transparency="translucent")
        self.part("LMP-0010", transparency="transparent")
        self.assertEqual(self.coded("feasibility."), {})

    def test_feasibility_flags_at_intent_from_the_planned_processes(self) -> None:
        # The engine's rev A REQ-010: the covers "are clear", verified as "clear-material parts".
        requirements = {"requirements": [{
            "id": "REQ-010", "text": "The cam covers and front timing cover are clear and removable by M3 screws.",
            "verification": {"method": "I", "criteria": "The cam covers and timing cover are clear-material parts."}}]}
        flagged = rules.requirement_feasibility_findings(
            requirements, {"manufacturing": {"processes": ["fdm", "purchased"]}}, [])
        self.assertEqual([(item.code, item.location) for item in flagged],
                         [("feasibility.transparency_claim", "requirements/0")])
        self.assertEqual(rules.requirement_feasibility_findings(
            requirements, {"manufacturing": {"processes": ["cnc", "purchased"]}}, []), [])
        self.assertEqual(rules.requirement_feasibility_findings(requirements, {}, []), [],
                         "no planned process and no part: nothing to contradict yet")


class VisibilityBindings(LampRecord):
    def bind(self, **binding: Any) -> None:
        self.edit("requirements.yaml", lambda document: document["requirements"][2].update(
            visibility=[{"view": "iso", "window": ["LMP-0004"], "targets": ["LMP-0009"], **binding}]))

    def test_bindings_resolve_and_carry_their_defaults(self) -> None:
        self.bind()
        self.assertEqual(self.coded("visibility."), {})
        requirements = yaml.safe_load((self.hw / "requirements.yaml").read_text(encoding="utf-8"))
        self.assertEqual(rules.visibility_bindings(requirements), [
            rules.VisibilityBinding("REQ-003", 0, "iso", ("LMP-0004",), ("LMP-0009",), 0.5)])

    def test_unresolved_and_overlapping_parts_are_errors_at_every_stage(self) -> None:
        cases = {
            "unknown target": ({"targets": ["LMP-0099"]}, "requirements.yaml#/requirements/2/visibility/0/targets"),
            "ambiguous PN": ({"window": ["LMP-0011"]}, "requirements.yaml#/requirements/2/visibility/0/window"),
            "window is a target": ({"targets": ["LMP-0009", "LMP-0004"]}, "requirements.yaml#/requirements/2/visibility/0"),
        }
        for name, (binding, location) in cases.items():
            with self.subTest(name):
                self.bind(**binding)
                found = self.coded("visibility.")
                self.assertEqual(list(found), [location])
                self.assertEqual((found[location]["code"], found[location]["severity"]), ("visibility.binding", "error"))


if __name__ == "__main__":
    unittest.main()
