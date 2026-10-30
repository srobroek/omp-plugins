#!/usr/bin/env python3
"""Assembly drawings without a kernel: intent, reconciliation, balloons, parts list, notes and sheet checks.

Run: uv run --with pyyaml --with defusedxml --with jsonschema python -m unittest discover -s cad/skills/cad-drawings/tests
"""

from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))
import assembly_check  # noqa: E402
import assembly_sheet  # noqa: E402
from assembly_check import IntentError, PartsRow, check_acceptance, check_sheet, read_intent, reconcile  # noqa: E402
from assembly_geometry import AssemblyGeometry, Occurrence  # noqa: E402
from assembly_sheet import BalloonTarget, MeasuredView  # noqa: E402
from drawing_document import CompositionError, SheetMetadata, compose_page, sheet_specs  # noqa: E402
from freecad_views import ViewGeometry  # noqa: E402
from layout_check import check_layout  # noqa: E402

BASE, PIN = "TST-0101", "TST-0102"
IDENTITY_Q = (0.0, 0.0, 0.0, 1.0)
QUARTER_TURN_Z = (0.0, 0.0, math.sin(math.pi / 4), math.cos(math.pi / 4))


def occurrence(oid: str, pn: str, *, parent: str | None = None, rotation=IDENTITY_Q, groups=("main",)) -> Occurrence:
    return Occurrence(occurrence_id=oid, pn=pn, product=f"{pn} part", path=("fixture",), rotation=rotation,
                      translation=(0.0, 0.0, 0.0), groups=groups, parent=parent)


def geometry(base_rotation=IDENTITY_Q) -> AssemblyGeometry:
    occurrences = (occurrence(BASE, BASE, rotation=base_rotation), occurrence("pin-a", PIN, parent=BASE),
                   occurrence("pin-b", PIN, parent=BASE, groups=("main", "pins")))
    return AssemblyGeometry(
        occurrences=occurrences, definitions={},
        groups={"main": ("main", "Main", (BASE, "pin-a", "pin-b")), "pins": ("pins", "Pins", ("pin-a", "pin-b"))},
        joints={"J-001": {"id": "J-001", "type": "revolute", "parent": BASE, "child": "pin-a", "min": -5.0, "max": 30.0}})


def intent_record(**changes) -> dict:
    drawing = {
        "number": "TST-ASM", "rev": "A", "title": "Fixture assembly",
        "views": [{"id": "front", "kind": "assembled", "direction": "front"},
                  {"id": "exploded", "kind": "exploded", "direction": "iso"}],
        "explode": [{"ref": "@pin-a", "offset_mm": [0, 0, 30]}],
        "items": [{"item": 1, "PN": BASE}, {"item": 2, "PN": PIN, "occurrences": ["@pin-a", "@pin-b"]}],
        "subassembly_sheets": ["pins"],
        "operations": [{"id": "press_pin_a", "kind": "press_fit", "part": "@pin-a", "into": BASE, "interface": "IF-001",
                        "direction": [1, 0, 0], "acceptance": {"kind": "seated", "features": ["pin_end", "plate_top"]},
                        "verify_joint": "J-001"}],
    }
    drawing.update(changes)
    return {"drawing": drawing}


BOM = [{"level": "1", "PN": BASE, "rev": "X1", "qty": "1", "title": "Base plate", "material": "PETG"},
       {"level": "1", "PN": PIN, "rev": "X1", "qty": "2", "title": "Pin", "material": "Steel",
        "designation": "ISO 2338 3 m6 x 20"}]
INTERFACES = [{"id": "IF-001", "limits": {"press_fit": {"fit": "3 H7/p6", "pair": [BASE, "@pin-a"]}}}]


def codes(findings) -> list[str]:
    return [f["code"] for f in findings]


class Intent(unittest.TestCase):
    def test_a_record_without_a_drawing_block_is_invalid_intent(self) -> None:
        with self.assertRaisesRegex(IntentError, "no drawing block"):
            read_intent({"subassemblies": [], "joints": []})

    def test_acceptance_names_the_features_its_kind_needs(self) -> None:
        op = dict(intent_record()["drawing"]["operations"][0], acceptance={"kind": "seated", "features": ["pin_end"]})
        with self.assertRaisesRegex(IntentError, "seated names 2 feature"):
            read_intent(intent_record(operations=[op]))

    def test_view_directions_are_named(self) -> None:
        with self.assertRaisesRegex(IntentError, "direction"):
            read_intent(intent_record(views=[{"id": "a", "kind": "assembled", "direction": "skew"}]))


class Reconcile(unittest.TestCase):
    def test_items_rows_and_quantities_come_from_occurrences_and_the_bom(self) -> None:
        plan, findings = reconcile(read_intent(intent_record()), geometry(), BOM, INTERFACES)
        self.assertEqual(findings, [])
        top, pins = plan.sheets
        self.assertEqual([r.cells() for r in top.rows],
                         [("1", BASE, "X1", "1", "Base plate", "PETG", ""),
                          ("2", PIN, "X1", "2", "Pin", "Steel", "ISO 2338 3 m6 x 20")])
        self.assertEqual(top.item_occurrences[2], ("pin-a", "pin-b"))
        # The subassembly sheet lists only its own occurrences, and only operations inside it.
        self.assertEqual([(r.item, r.qty) for r in pins.rows], [(2, 2)])
        self.assertEqual((pins.heading, pins.operations), ("Pins", ()))
        self.assertEqual([op.operation.id for op in top.operations], ["press_pin_a"])
        self.assertEqual(plan.explode, {"pin-a": (0.0, 0.0, 30.0)})

    def test_bom_quantity_must_equal_the_occurrence_count(self) -> None:
        bom = [BOM[0], dict(BOM[1], qty="3")]
        plan, findings = reconcile(read_intent(intent_record()), geometry(), bom, INTERFACES)
        self.assertIsNone(plan)
        self.assertEqual(codes(findings), ["bom_geometry_mismatch"])
        self.assertIn("bom.csv quantity 3, 2 occurrences", findings[0]["message"])

    def test_an_occurrence_outside_every_item_is_unidentified(self) -> None:
        items = [{"item": 1, "PN": BASE}, {"item": 2, "PN": PIN, "occurrences": ["@pin-a"]}]
        _, findings = reconcile(read_intent(intent_record(items=items)), geometry(), BOM, INTERFACES)
        self.assertIn("assembly_item_unidentified", codes(findings))
        self.assertTrue(any("@pin-b" in f["message"] for f in findings))

    def test_a_repeated_pn_needs_its_occurrences_named(self) -> None:
        items = [{"item": 1, "PN": BASE}, {"item": 2, "PN": PIN}]
        _, findings = reconcile(read_intent(intent_record(items=items)), geometry(), BOM, INTERFACES)
        self.assertTrue(any("placed 2 times" in f["message"] for f in findings))

    def test_one_item_row_per_pn(self) -> None:
        items = [{"item": 1, "PN": BASE}, {"item": 2, "PN": PIN, "occurrences": ["@pin-a"]},
                 {"item": 3, "PN": PIN, "occurrences": ["@pin-b"]}]
        _, findings = reconcile(read_intent(intent_record(items=items)), geometry(), BOM, INTERFACES)
        self.assertTrue(any("one row per PN" in f["message"] for f in findings))

    def test_an_operation_needs_the_interface_limit_that_joins_its_parts(self) -> None:
        interfaces = [{"id": "IF-001", "limits": {"press_fit": {"fit": "3 H7/p6", "pair": [BASE, "@pin-b"]}}}]
        _, findings = reconcile(read_intent(intent_record()), geometry(), BOM, interfaces)
        self.assertEqual(codes(findings), ["assembly_instruction_incomplete"])

    def test_the_direction_turns_with_the_receiving_part(self) -> None:
        plan, _ = reconcile(read_intent(intent_record()), geometry(QUARTER_TURN_Z), BOM, INTERFACES)
        direction = plan.sheets[0].operations[0].direction
        self.assertTrue(all(abs(a - b) < 1e-9 for a, b in zip(direction, (0.0, 1.0, 0.0))), direction)

    def test_bom_rollup_multiplies_parent_quantities(self) -> None:
        rows = [{"level": "0", "PN": "TST-1000", "rev": "A", "qty": "1", "title": "Top", "material": ""},
                {"level": "1", "PN": "TST-1100", "rev": "A", "qty": "2", "title": "Sub", "material": ""},
                {"level": "2", "PN": PIN, "rev": "A", "qty": "3", "title": "Pin", "material": "Steel"},
                {"level": "1", "PN": PIN, "rev": "A", "qty": "1", "title": "Pin", "material": "Steel"}]
        self.assertEqual(assembly_check.bom_rollup(rows)[PIN]["qty"], 7)

    def test_numbered_bom_assembly_row_is_not_compared_to_step_geometry(self) -> None:
        rows = [{"level": "0", "PN": "TST-1000", "rev": "A", "qty": "1", "title": "Top", "material": ""},
                {"level": "1", "PN": BASE, "rev": "A", "qty": "1", "title": "Base", "material": "PETG"},
                {"level": "2", "PN": PIN, "rev": "A", "qty": "2", "title": "Pin", "material": "Steel"}]
        intent = read_intent(intent_record(operations=[], items=[{"item": 1, "PN": BASE},
                                                                {"item": 2, "PN": PIN,
                                                                 "occurrences": ["@pin-a", "@pin-b"]}],
                                          subassembly_sheets=[]))
        plan, findings = reconcile(intent, geometry(), rows, [])
        self.assertIsNotNone(plan)
        self.assertNotIn("bom_geometry_mismatch", codes(findings))
    def test_rejected_package_sheet_lookup_uses_number_not_position(self) -> None:
        from pathlib import Path
        import json
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            package = Path(tmp)
            (package / "rejected.json").write_text(json.dumps({
                "coverage": {"rows": [{"kind": "assembly_sheet", "sheet": 2}]},
                "sheets": [],
            }), encoding="utf-8")
            result = assembly_check.check_package(package)
        self.assertEqual(result["status"], "fail")
        self.assertEqual(result["findings"][0]["sheet"], 2)

class Acceptance(unittest.TestCase):
    def resolved(self, kind: str) -> assembly_check.ResolvedOperation:
        plan, _ = reconcile(read_intent(intent_record()), geometry(), BOM, INTERFACES)
        op = plan.sheets[0].operations[0]
        features = ("ring_groove",) if kind == "engaged" else op.operation.features
        operation = assembly_check.Operation(**{**op.operation.__dict__, "acceptance": kind, "features": features})
        return assembly_check.ResolvedOperation(**{**op.__dict__, "operation": operation})

    def test_the_model_must_agree_with_the_declared_seating(self) -> None:
        self.assertEqual(check_acceptance(self.resolved("seated"), {"gap": 0.0, "flush": None, "contact": 0.0}), [])
        self.assertIn("0.300 mm gap", check_acceptance(self.resolved("seated"), {"gap": 0.3})[0]["message"])
        self.assertEqual(check_acceptance(self.resolved("standoff"), {"gap": 0.3}), [])
        self.assertIn("in contact", check_acceptance(self.resolved("standoff"), {"gap": 0.0})[0]["message"])
        self.assertEqual(check_acceptance(self.resolved("engaged"), {"contact": 0.005}), [])
        self.assertIn("0.200 mm apart", check_acceptance(self.resolved("engaged"), {"contact": 0.2})[0]["message"])
        self.assertIn("nearest +0.500", check_acceptance(self.resolved("flush"), {"flush": 0.5})[0]["message"])
        self.assertIn("not measured", check_acceptance(self.resolved("seated"), None)[0]["message"])

    def test_notes_state_direction_seat_and_fit_but_no_invented_process_values(self) -> None:
        op = self.resolved("standoff")
        iso = assembly_sheet.operation_note(op, {"gap": 0.3}, "iso")
        self.assertEqual(iso, "Press item 2 into item 1 along +X until its pin end stands 0.3 mm off the plate top, "
                              "as modelled; fit 3 H7/p6 (IF-001). Then check that item 2 moves freely on item 1 from "
                              "-5° to 30° (J-001).")
        asme = assembly_sheet.operation_note(op, {"gap": 0.3}, "asme")
        self.assertIn("FIT 3 H7/p6", asme)          # a fit designation keeps its case
        self.assertIn("0.3 mm OFF", asme)
        unknown = assembly_sheet.operation_note(op, {}, "iso")
        self.assertIn("stands off the plate top by the modelled gap; gap not measured", unknown)
        self.assertNotIn("not recorded mm", unknown)
        with_tools = assembly_check.Operation(**{**op.operation.__dict__, "tools": ("Arbor press",)})
        with_tools_op = assembly_check.ResolvedOperation(**{**op.__dict__, "operation": with_tools})
        self.assertNotIn("Arbor press", assembly_sheet.operation_note(with_tools_op, {"gap": 0.3}, "iso"))


VIEW = ViewGeometry(view_id="exploded", role="assembly", kind="part", centre_mm=(150.0, 120.0), scale=1.0,
                    rotation_deg=0.0, direction=(1.0, -1.0, 1.0), x_direction=(1.0, 1.0, 0.0),
                    visible=("M -40 -20 L 40 -20 L 40 20 L -40 20 Z",), hidden=(), circles=(),
                    bounds=(-40.0, -20.0, 40.0, 20.0))
ANCHORS = {BASE: (130.0, 110.0), "pin-a": (170.0, 125.0)}
ROWS = (PartsRow(1, BASE, "X1", 1, "Base plate", "PETG", ""),
        PartsRow(2, PIN, "X1", 2, "Pin", "Steel", "ISO 2338 3 m6 x 20"))


def evidence(anchors=ANCHORS) -> dict:
    return {"kind": "assembly_sheet", "sheet": 1, "scope": "top", "regime": "iso",
            "items": {"1": {"PN": BASE, "qty": 1, "occurrences": [BASE]},
                      "2": {"PN": PIN, "qty": 2, "occurrences": ["pin-a", "pin-b"]}},
            "bom": {row["PN"]: {**assembly_check.bom_rollup(BOM)[row["PN"]]} for row in BOM},
            "views": {"exploded": {"balloons": True, "bounds": list(VIEW.sheet_bounds()),
                                   "anchors": {k: list(v) for k, v in anchors.items()}}}}


def page(targets=None, rows=ROWS):
    targets = targets if targets is not None else [BalloonTarget(1, BASE, ANCHORS[BASE]),
                                                   BalloonTarget(2, "pin-a", ANCHORS["pin-a"])]
    spec = sheet_specs({"regime": "iso"}, ["A3"])[0]
    annotations = [*assembly_sheet.balloons(VIEW, targets), assembly_sheet.label(VIEW, "Exploded view", True)]
    metadata = SheetMetadata(drawing_number="TST-ASM", revision="A", title="Fixture assembly",
                             document_type="Assembly drawing", sheet_number=1, sheet_count=1, scale=1.0)
    return compose_page(spec, metadata, [VIEW], annotations, [assembly_sheet.parts_list("iso", rows)], [])


class SheetCheck(unittest.TestCase):
    def test_a_complete_sheet_passes_the_assembly_and_layout_checks(self) -> None:
        composed = page()
        self.assertEqual(check_sheet(composed.svg, evidence()), [])
        self.assertEqual(check_layout(composed.svg, composed.regions, composed.placeholders), [])

    def test_a_removed_balloon_fails_the_one_to_one_check(self) -> None:
        findings = check_sheet(page([BalloonTarget(1, BASE, ANCHORS[BASE])]).svg, evidence())
        self.assertEqual(codes(findings), ["assembly_item_unidentified"])
        self.assertIn("item 2 has 0 balloons in view exploded", findings[0]["message"])

    def test_a_duplicate_balloon_fails(self) -> None:
        targets = [BalloonTarget(1, BASE, ANCHORS[BASE]), BalloonTarget(2, "pin-a", ANCHORS["pin-a"])]
        composed = page(targets)
        svg = composed.svg.replace('data-item="1"', 'data-item="2"', 1)
        self.assertTrue(any("item 2 has 2 balloons" in f["message"] for f in check_sheet(svg, evidence())))

    def test_a_balloon_must_target_an_occurrence_of_its_item(self) -> None:
        findings = check_sheet(page([BalloonTarget(1, BASE, ANCHORS[BASE]), BalloonTarget(2, BASE, ANCHORS[BASE])]).svg,
                               evidence())
        self.assertTrue(any("points at TST-0101, not an occurrence of item 2" in f["message"] for f in findings))

    def test_the_leader_must_end_on_its_occurrences_measured_point(self) -> None:
        moved = {**ANCHORS, "pin-a": (171.0, 125.0)}
        findings = check_sheet(page().svg, evidence(moved))
        self.assertEqual(len(findings), 1)
        self.assertIn("not on pin-a", findings[0]["message"])

    def test_parts_list_quantity_must_equal_the_occurrences(self) -> None:
        rows = (ROWS[0], PartsRow(2, PIN, "X1", 1, "Pin", "Steel", "ISO 2338 3 m6 x 20"))
        messages = [f["message"] for f in check_sheet(page(rows=rows).svg, evidence())]
        self.assertIn("item 2 lists quantity 1; the sheet places 2 occurrences", messages)
        self.assertIn("item 2 lists quantity 1; bom.csv rolls up 2", messages)

    def test_parts_list_fields_must_equal_the_bom(self) -> None:
        rows = (ROWS[0], PartsRow(2, PIN, "X1", 2, "Dowel", "Steel", "ISO 2338 3 m6 x 20"))
        messages = [f["message"] for f in check_sheet(page(rows=rows).svg, evidence())]
        self.assertEqual(messages, ["item 2 title 'Dowel' differs from bom.csv 'Pin'"])


class Layout(unittest.TestCase):
    def test_spread_keeps_order_and_spacing_on_the_loop(self) -> None:
        placed = assembly_sheet._spread([10.0, 10.0, 11.0, 12.0, 190.0], 10.0, 200.0)
        loop = sorted(placed)
        gaps = [(loop[(i + 1) % 5] - loop[i]) % 200.0 for i in range(5)]
        self.assertGreaterEqual(min(gaps), 10.0 - 1e-9)
        with self.assertRaises(CompositionError):
            assembly_sheet._spread([0.0] * 30, 10.0, 200.0)

    def test_crowded_balloons_do_not_overlap(self) -> None:
        targets = [BalloonTarget(i + 1, f"o{i}", (148.0 + 0.5 * i, 101.0)) for i in range(8)]
        circles = []
        for annotation in assembly_sheet.balloons(VIEW, targets):
            markup = annotation.markup
            balloon = markup.split('<circle ')[2]
            values = dict(part.split('="') for part in balloon.replace('"/>', '" ').split('" ') if '="' in part)
            circles.append((float(values["cx"]), float(values["cy"])))
        nearest = min(math.dist(a, b) for i, a in enumerate(circles) for b in circles[i + 1:])
        self.assertGreater(nearest, 2 * assembly_sheet.BALLOON_RADIUS)

    def test_sheet_choice_respects_the_legibility_floor(self) -> None:
        request = assembly_check.ViewRequest("exploded", "exploded", "iso")
        specs = sheet_specs({"regime": "iso"}, ["A4", "A3"])
        table = assembly_sheet.parts_list("iso", ROWS)
        roomy = MeasuredView(request, "Exploded", (-50.0, -30.0, 50.0, 30.0), {"pin-a": (0.0, 0.0)}, {"pin-a": 60.0})
        layout = assembly_sheet.plan_sheet(specs, [roomy], [table], [], None)
        self.assertEqual((layout.spec.size, layout.scale), ("A4", 1.0))
        tiny = MeasuredView(request, "Exploded", (-50.0, -30.0, 50.0, 30.0), {"pin-a": (0.0, 0.0)}, {"pin-a": 1.0})
        with self.assertRaisesRegex(CompositionError, "legibility floor"):
            assembly_sheet.plan_sheet(specs, [tiny], [table], [], None)


if __name__ == "__main__":
    unittest.main()
