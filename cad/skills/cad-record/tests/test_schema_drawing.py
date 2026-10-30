#!/usr/bin/env python3
"""Drawing-intent, procurement, fit-endpoint and heat-set record additions: valid and rejected examples."""

from __future__ import annotations

import copy
import csv
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Callable

import yaml

SKILL = Path(__file__).resolve().parents[1]
VALIDATOR = SKILL / "scripts" / "validate.py"
BASE_COLUMNS = ["level", "PN", "rev", "qty", "title", "material", "process", "make_buy", "supplier", "mass"]
PROCUREMENT_COLUMNS = ["unit", "designation", "manufacturer", "manufacturer_part_number", "supplier_part_number",
                       "specification_ref", "specification_rev"]
DATASHEET = b"%PDF-1.4 vendor datasheet stand-in\n"

PRODUCT = {
    "id": "test-fixture", "rigor": "pro", "units": "mm", "regime": "iso", "general_tolerance": "ISO 2768-m",
    "flow": {"stage": "detail", "recheck_from": "detail"},
    "drawing": {
        "definition": "model_and_drawing",
        "projection": "first_angle",
        "standards": {"dimensioning": "ISO 129-1:2018", "geometrical_tolerancing": "ISO 1101:2017",
                      "datums": "ISO 5459:2024", "gps_fundamentals": "ISO 8015:2011"},
        "default_sheet": {"sizes": ["A4", "A3", "A2"], "orientation": "landscape", "scale": "auto"},
        "tolerance_policies": {
            "machining": {"kind": "standard", "standard": "ISO 2768-1:1989", "class": "m", "applies_to": ["cnc"]},
            "fdm_supplier": {"kind": "limits", "linear_mm": 0.3, "angular_deg": 1.0, "applies_to": ["fdm"],
                             "reference": "Supplier FDM capability sheet rev 2"},
        },
        "general_tolerance_policy": "machining",
    },
}
BASE = {
    "PN": "TST-0001", "rev": "X1", "title": "Base plate", "material": "PETG", "process": "fdm", "finish": "as printed",
    "mass_target": 40, "make_buy": "make", "supplier": None,
    "procurement": {"mode": "made_to_drawing"},
    "drawing": {
        "type": "detail",
        "tolerance_policy": "fdm_supplier",
        "datum_features": {"A": {"feature": "bed_face", "role": "plane"}, "B": {"feature": "pivot_bore", "role": "axis"},
                           "C": {"feature": "mount_slot", "role": "clocking_feature"}},
        "coordinate_frame": {"origin": {"intersection": ["A", "B"]}, "z": {"normal_to": "A"}, "x": {"toward": "C"}},
        "views": [{"id": "plan", "kind": "orthographic", "normal_to": "A"},
                  {"id": "underside", "kind": "orthographic", "opposite": "plan"},
                  {"id": "section_aa", "kind": "section", "through": "B", "toward": "C"},
                  {"id": "slot_detail", "kind": "detail", "feature": "mount_slot", "scale": "2:1"}],
        "features": {"base_profile": {"profile": "controlled_model", "profile_tolerance_mm": 0.4},
                     "pivot_bore": {"size": "interface", "location": "datum_coordinates",
                                    "surface_texture": {"parameter": "Ra", "limit_um": 1.6, "process": "removal_required"},
                                    "edges": {"external": [-0.1, 0.0]}},
                     "mount_slot": {"size": "general", "location": "datum_coordinates", "presentation": "detail"},
                     "boss": {"size": "general", "axial_location_from": "A", "tolerance_policy": "fdm_supplier"}},
        "dimensions": [{"id": "boss_height", "operation": "distance", "features": ["boss", "bed_face"],
                        "datum_frame": ["A"], "tolerance": {"deviation_mm": [-0.2, 0.2]}},
                       {"id": "overall_height", "operation": "length", "features": ["base_profile"], "reference": True}],
        "edges": {"external": [-0.5, 0.0], "internal": [0.0, 0.5]},
        "surface_texture": {"open": "no published roughness for the bureau's as-printed PETG"},
        "notes": [{"kind": "finish", "text": "As printed; the pivot bore is reamed."}],
        "manufacturing": {"build_direction": {"normal_to": "A"}, "interface_condition": "as_printed"},
        "sheet": {"sizes": ["A4", "A3"], "scale": "auto", "multi_sheet": True},
    },
}
PIN = {
    "PN": "TST-0002", "rev": "X1", "title": "Dowel pin 5 x 20", "material": "Stainless steel A2", "process": "purchased",
    "finish": "none", "mass_target": 3, "make_buy": "buy", "supplier": "Acme Fasteners",
    "procurement": {"mode": "catalog", "manufacturer": "Acme", "manufacturer_part_number": "DP-5-20",
                    "supplier_part_number": "AF-1234", "designation": "ISO 2338 5 m6 x 20 A2",
                    "specification": {"reference": "Acme DP datasheet", "revision": "C", "artifact": "parts/TST-0002/sources/dp.pdf",
                                      "sha256": hashlib.sha256(DATASHEET).hexdigest()},
                    "approved_sources": [{"name": "Acme", "part_number": "DP-5-20"}],
                    "qualification_evidence": "decisions/DR-001.md", "certificates": ["EN 10204 3.1"]},
    "drawing": {"type": "vendor_specification"},
}
INTERFACES = {"interfaces": [{
    "id": "IF-001", "from": "base", "to": "pin", "type": "mounting", "description": "Pin pressed into the base bore.",
    "limits": {
        "press_fit": {"fit": "5 H7/p6", "hole": {"PN": "TST-0001", "feature": "pivot_bore", "region": "upper_span"},
                      "shaft": {"PN": "TST-0002", "feature": "press_band"}},
        "running_fit": {"fit": "5 H8/f7", "pair": ["TST-0001", "TST-0002"], "note": "kept as a part pair"},
        "heat_set": [{"pair": ["TST-0001", "TST-0002"], "hole_d": 4.0, "insert": "M3 x 5.7 brass insert",
                      "source": "https://example.com/inserts/m3"},
                     {"pair": ["TST-0001", "TST-0002"], "hole_d": 4.0, "insert": "M3 x 5.7 brass insert",
                      "source": "https://example.com/inserts/m3", "hole_tol": [0.0, 0.1], "depth_min": 6.0,
                      "note": "second boss"}],
    },
}]}
ASSEMBLY = {"subassemblies": [{"id": "main", "title": "Main", "parts": ["TST-0001", "TST-0002"]}], "joints": []}
REQUIREMENTS = {"requirements": [{"id": "REQ-001", "text": "Pin fits", "rationale": "Assembly", "source": "Test",
                                  "priority": "must", "verification": {"method": "I", "criteria": "Fits"}}]}


def bom_rows(parts: list[dict[str, Any]], procurement: bool) -> list[dict[str, str]]:
    rows = []
    for part in parts:
        row = {"level": "1", "PN": part["PN"], "rev": part["rev"], "qty": "1", "title": part["title"],
               "material": part["material"], "process": part["process"], "make_buy": part["make_buy"],
               "supplier": part["supplier"] or "", "mass": str(part["mass_target"])}
        if procurement:
            source = part.get("procurement", {})
            specification = source.get("specification", {})
            row.update({"unit": "pcs", "designation": source.get("designation", ""),
                        "manufacturer": source.get("manufacturer", ""),
                        "manufacturer_part_number": source.get("manufacturer_part_number", ""),
                        "supplier_part_number": source.get("supplier_part_number", ""),
                        "specification_ref": specification.get("reference", ""),
                        "specification_rev": specification.get("revision", "")})
        rows.append(row)
    return rows


class DrawingRecordAdditions(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="cad-record-drawing-")
        self.addCleanup(temporary.cleanup)
        self.hw = Path(temporary.name) / "project" / "hw"
        self.docs = {"product.yaml": copy.deepcopy(PRODUCT), "interfaces.yaml": copy.deepcopy(INTERFACES),
                     "assembly.yaml": copy.deepcopy(ASSEMBLY), "requirements.yaml": copy.deepcopy(REQUIREMENTS)}
        self.parts = {"TST-0001": copy.deepcopy(BASE), "TST-0002": copy.deepcopy(PIN)}
        self.procurement_columns = True
        self.bom_edit: Callable[[list[dict[str, str]]], None] = lambda rows: None

    def write(self) -> None:
        (self.hw / "decisions").mkdir(parents=True, exist_ok=True)
        (self.hw / "decisions" / "DR-001.md").write_text("# DR-001\n", encoding="utf-8")
        (self.hw / "parts" / "TST-0002" / "sources").mkdir(parents=True, exist_ok=True)
        (self.hw / "parts" / "TST-0002" / "sources" / "dp.pdf").write_bytes(DATASHEET)
        for name, document in self.docs.items():
            (self.hw / name).write_text(yaml.safe_dump(document, sort_keys=False), encoding="utf-8")
        for pn, part in self.parts.items():
            (self.hw / "parts" / pn).mkdir(parents=True, exist_ok=True)
            (self.hw / "parts" / pn / "part.yaml").write_text(yaml.safe_dump(part, sort_keys=False), encoding="utf-8")
        rows = bom_rows(list(self.parts.values()), self.procurement_columns)
        self.bom_edit(rows)
        columns = BASE_COLUMNS + (PROCUREMENT_COLUMNS if self.procurement_columns else [])
        with (self.hw / "bom.csv").open("w", newline="", encoding="utf-8") as stream:
            writer = csv.DictWriter(stream, fieldnames=list(rows[0]) if rows else columns, lineterminator="\n")
            writer.writeheader()
            writer.writerows(rows)
        (self.hw / "verification.csv").write_text("requirement_id,method,criteria,result,evidence\nREQ-001,I,Fits,planned,\n",
                                                  encoding="utf-8")

    def validate(self) -> tuple[int, list[str]]:
        self.write()
        result = subprocess.run([sys.executable, str(VALIDATOR), str(self.hw.parent)], capture_output=True, text=True,
                                timeout=60, check=False)
        report = json.loads(result.stdout)
        return result.returncode, [f"{item['path']}: {item['message']}" for item in report["findings"]]

    def assert_valid(self) -> None:
        code, findings = self.validate()
        self.assertEqual((code, findings), (0, []))

    def assert_rejected(self, expected: str) -> None:
        code, findings = self.validate()
        self.assertEqual(code, 1, findings)
        self.assertTrue(any(expected in finding for finding in findings), findings)

    def test_complete_drawing_intent_record_validates(self) -> None:
        self.assert_valid()

    def test_records_without_the_additions_stay_valid(self) -> None:
        del self.docs["product.yaml"]["drawing"]
        for part in self.parts.values():
            del part["drawing"], part["procurement"]
        self.docs["interfaces.yaml"]["interfaces"][0]["limits"] = {"press_fit": {"fit": "5 H7/p6", "pair": ["TST-0001", "TST-0002"]}}
        self.procurement_columns = False
        self.assert_valid()

    def test_product_drawing_policy_rejections(self) -> None:
        cases: dict[str, tuple[Callable[[dict], None], str]] = {
            "general tolerance disagrees": (lambda p: p.update(general_tolerance="ISO 2768-f"),
                                            "does not state the machining policy; expected 'ISO 2768-m'"),
            "free text tolerance": (lambda p: p.update(general_tolerance="medium"), "does not state the machining policy"),
            "unknown general policy": (lambda p: p["drawing"].update(general_tolerance_policy="casting"),
                                       "'casting' is not in drawing/tolerance_policies"),
            "limits policy states its number": (lambda p: p["drawing"].update(general_tolerance_policy="fdm_supplier"),
                                                "expected 0.3"),
            "ASME standard under ISO regime": (lambda p: p["drawing"]["standards"].update(dimensioning="ASME Y14.5-2018"),
                                               "does not belong to the iso regime"),
            "unknown projection": (lambda p: p["drawing"].update(projection="isometric"), "drawing/projection"),
            "withdrawn ISO 2768-2": (lambda p: p["drawing"]["tolerance_policies"]["machining"].update(standard="ISO 2768-2:1989"),
                                     "drawing/tolerance_policies/machining"),
            "limits policy without its source": (lambda p: p["drawing"]["tolerance_policies"]["fdm_supplier"].pop("reference"),
                                                 "drawing/tolerance_policies/fdm_supplier"),
            "policy without applies_to": (lambda p: p["drawing"]["tolerance_policies"]["machining"].pop("applies_to"),
                                          "drawing/tolerance_policies/machining"),
            "missing standards": (lambda p: p["drawing"].pop("standards"), "'standards' is a required property"),
            "unknown sheet size": (lambda p: p["drawing"]["default_sheet"].update(sizes=["B5"]), "drawing/default_sheet/sizes/0"),
        }
        self.run_cases(cases, lambda: self.docs["product.yaml"])

    def test_asme_regime_accepts_asme_standards_and_limits_policy(self) -> None:
        product = self.docs["product.yaml"]
        product.update(regime="asme", general_tolerance=0.3)
        product["drawing"].update(projection="third_angle", general_tolerance_policy="fdm_supplier",
                                  standards={"dimensioning": "ASME Y14.5-2018", "drawing_practices": "ASME Y14.100-2017"})
        product["drawing"]["default_sheet"]["sizes"] = ["ANSI A", "ANSI B"]
        self.assert_valid()

    def test_part_drawing_intent_rejections(self) -> None:
        cases: dict[str, tuple[Callable[[dict], None], str]] = {
            "unknown drawing type": (lambda d: d.update(type="assembly"), "drawing/type"),
            "section without plane": (lambda d: d["views"][2].pop("through"), "drawing/views/2"),
            "orthographic without direction": (lambda d: d["views"][0].pop("normal_to"), "drawing/views/0"),
            "dimension carrying a value": (lambda d: d["dimensions"][0].update(value=12.5), "drawing/dimensions/0"),
            "undeclared datum": (lambda d: d["views"][0].update(normal_to="D"), "datum D is not declared"),
            "undeclared datum in a frame": (lambda d: d["dimensions"][0].update(datum_frame=["A", "E"]), "datum E is not declared"),
            "machining policy on FDM": (lambda d: d.update(tolerance_policy="machining"),
                                        "policy machining applies to cnc, not to process fdm"),
            "unknown feature policy": (lambda d: d["features"]["boss"].update(tolerance_policy="casting"),
                                       "'casting' is not a product.yaml drawing/tolerance_policies entry"),
            "duplicate view id": (lambda d: d["views"].append({"id": "plan", "kind": "orthographic", "normal_to": "B"}),
                                  "view id plan is used more than once"),
            "opposite of unknown view": (lambda d: d["views"][1].update(opposite="elevation"), "'elevation' is not another view"),
            "inverted deviation": (lambda d: d["dimensions"][0]["tolerance"].update(deviation_mm=[0.2, -0.2]),
                                   "lower 0.2 must be below upper -0.2"),
            "conflicting axis": (lambda d: d["coordinate_frame"]["z"].update(parallel_to="B"), "drawing/coordinate_frame/z"),
            "frame without axis": (lambda d: d["coordinate_frame"].pop("z") and d["coordinate_frame"].pop("x"),
                                   "drawing/coordinate_frame"),
            "free-form feature intent": (lambda d: d["features"]["boss"].update(diameter=12), "drawing/features/boss"),
            "camel-case feature id": (lambda d: d["features"].update(BossTop={"size": "general"}), "drawing/features"),
            "reserved datum letter": (lambda d: d["datum_features"].update(I={"feature": "boss", "role": "axis"}),
                                      "drawing/datum_features"),
            "edge note kind": (lambda d: d["notes"].append({"kind": "edge", "text": "Break sharp edges."}),
                               "drawing/notes/1/kind"),
            "inverted edge limits": (lambda d: d["edges"].update(external=[-0.1, -0.3]),
                                     "drawing/edges/external: lower -0.1 must be below upper -0.3"),
            "general edges without internal": (lambda d: d["edges"].pop("internal"), "drawing/edges"),
            "feature edge limits inverted": (lambda d: d["features"]["pivot_bore"]["edges"].update(internal=[0.3, 0.0]),
                                             "drawing/features/pivot_bore/edges/internal: lower 0.3 must be below upper 0.0"),
            "texture without process": (lambda d: d["features"]["pivot_bore"]["surface_texture"].pop("process"),
                                        "drawing/features/pivot_bore/surface_texture"),
            "open feature texture": (lambda d: d["features"]["pivot_bore"].update(surface_texture={"open": "later"}),
                                     "drawing/features/pivot_bore/surface_texture"),
            "texture both open and set": (lambda d: d["surface_texture"].update(parameter="Ra", limit_um=6.3,
                                                                                process="any"), "drawing/surface_texture"),
        }
        self.run_cases(cases, lambda: self.parts["TST-0001"]["drawing"])

    def test_part_policy_needs_the_product_policy(self) -> None:
        del self.docs["product.yaml"]["drawing"]
        self.assert_rejected("'fdm_supplier' is not a product.yaml drawing/tolerance_policies entry")

    def test_procurement_rejections(self) -> None:
        cases: dict[str, tuple[Callable[[dict], None], str]] = {
            "catalogue part made in house": (lambda p: p.update(make_buy="make"), "procurement/mode catalog requires make_buy: buy"),
            "made-to-drawing with a vendor sheet": (lambda p: p["procurement"].update(mode="made_to_drawing"),
                                                    "procurement/mode made_to_drawing contradicts drawing/type vendor_specification"),
            "specification hash mismatch": (lambda p: p["procurement"]["specification"].update(sha256="0" * 64),
                                            "procurement/specification/sha256 does not match parts/TST-0002/sources/dp.pdf"),
            "specification outside hw": (lambda p: p["procurement"]["specification"].update(artifact="../dp.pdf"),
                                         "procurement/specification/artifact"),
            "specification missing": (lambda p: p["procurement"]["specification"].update(
                artifact="parts/TST-0002/sources/none.pdf"), "'parts/TST-0002/sources/none.pdf' is not a file in hw/"),
            "specification without revision": (lambda p: p["procurement"]["specification"].pop("revision"),
                                               "procurement/specification"),
            "no mode": (lambda p: p["procurement"].pop("mode"), "'mode' is a required property"),
            "unknown mode": (lambda p: p["procurement"].update(mode="cots"), "procurement/mode"),
            "empty approved sources": (lambda p: p["procurement"].update(approved_sources=[]), "procurement/approved_sources"),
            "specification without artifact or url": (lambda p: p["procurement"]["specification"].pop("artifact"),
                                                      "procurement/specification"),
            "specification url not https": (lambda p: p["procurement"]["specification"].update(url="ftp://acme/dp.pdf"),
                                            "procurement/specification/url"),
            "open field that is also set": (lambda p: p["procurement"].update(open={"manufacturer": "to be chosen"}),
                                            "procurement/open/manufacturer: manufacturer is both set and declared open"),
            "open field outside the identity": (lambda p: p["procurement"].update(open={"designation": "later"}),
                                                "procurement/open"),
            "standard not stated in the designation": (lambda p: p["procurement"].update(standard="ISO 2338"),
                                                       "procurement/designation does not state the ISO 2338 designation"),
            "standard of no recognised body": (lambda p: p["procurement"].update(standard="ACME 12"),
                                               "procurement/standard"),
            "standard on a made-to-drawing part": (lambda p: p["procurement"].update(
                mode="made_to_drawing", standard="ISO 2338", designation="Parallel pin ISO 2338 - 5 m6 x 20 - A2"),
                "procurement/standard: only a catalogue item is ordered by its standard designation"),
            "texture on a vendor sheet": (lambda p: p["drawing"].update(
                surface_texture={"parameter": "Ra", "limit_um": 0.8, "process": "any"}),
                "drawing/surface_texture: only a detail drawing specifies surface_texture"),
        }
        self.run_cases(cases, lambda: self.parts["TST-0002"])

    def test_specification_copy_outside_its_sources_folder_is_misplaced(self) -> None:
        self.parts["TST-0002"]["procurement"]["specification"]["artifact"] = "specs/dp.pdf"
        (self.hw / "specs").mkdir(parents=True)
        (self.hw / "specs" / "dp.pdf").write_bytes(DATASHEET)
        code, findings = self.validate()
        self.assertEqual(code, 0, findings)  # a layout finding is a warning before design_freeze
        self.assertIn(f"{self.hw / 'specs' / 'dp.pdf'}: hw/specs/dp.pdf is procurement evidence for TST-0002 "
                      "outside its sources/ folder", findings)

    def test_url_specification_without_a_frozen_copy_validates(self) -> None:
        procurement = self.parts["TST-0002"]["procurement"]
        procurement["specification"].pop("artifact")
        procurement["specification"]["url"] = "https://acme.example/dp-datasheet.pdf"
        procurement.pop("supplier_part_number")
        procurement["open"] = {"supplier_part_number": "no distributor selected"}
        self.assert_valid()

    def test_standard_part_ordered_by_its_designation_validates(self) -> None:
        procurement = self.parts["TST-0002"]["procurement"]
        for field in ("manufacturer", "manufacturer_part_number", "supplier_part_number"):
            procurement.pop(field)
        procurement.update(standard="ISO 2338", designation="Parallel pin ISO 2338 - 5 m6 x 20 - A2")
        self.assert_valid()

    def test_made_to_drawing_needs_a_detail_drawing(self) -> None:
        self.parts["TST-0001"]["drawing"]["type"] = "source_control"
        self.assert_rejected("procurement/mode made_to_drawing contradicts drawing/type source_control")

    def test_interface_endpoint_and_heat_set_rejections(self) -> None:
        cases: dict[str, tuple[Callable[[dict], None], str]] = {
            "pair and endpoints": (lambda l: l["press_fit"].update(pair=["TST-0001", "TST-0002"]), "limits/press_fit"),
            "hole without shaft": (lambda l: l["press_fit"].pop("shaft"), "limits/press_fit"),
            "endpoint without feature": (lambda l: l["press_fit"]["hole"].pop("feature"), "limits/press_fit"),
            "unknown endpoint part": (lambda l: l["press_fit"]["shaft"].update(PN="TST-0009"),
                                      "limits/press_fit: part TST-0009 does not exist"),
            "both endpoints on one part": (lambda l: l["press_fit"]["shaft"].update(PN="TST-0001"),
                                           "limits/press_fit: hole and shaft are both on TST-0001"),
            "unknown running-fit part": (lambda l: l["running_fit"].update(pair=["TST-0001", "TST-0008"]),
                                         "limits/running_fit: part TST-0008 does not exist"),
            "heat set without source": (lambda l: l["heat_set"][0].pop("source"), "limits/heat_set/0"),
            "heat set source not a URL": (lambda l: l["heat_set"][0].update(source="datasheet"), "limits/heat_set/0/source"),
            "heat set unknown key": (lambda l: l["heat_set"][0].update(torque_nm=0.5), "limits/heat_set/0"),
            "heat set single part": (lambda l: l["heat_set"][0].update(pair=["TST-0001"]), "limits/heat_set/0/pair"),
            "heat set not a list": (lambda l: l.update(heat_set=l["heat_set"][0]), "limits/heat_set"),
            "heat set unknown part": (lambda l: l["heat_set"][1].update(pair=["TST-0001", "TST-0007"]),
                                      "limits/heat_set/1: part TST-0007 does not exist"),
            "inverted hole tolerance": (lambda l: l["heat_set"][1].update(hole_tol=[0.1, 0.0]),
                                        "heat_set/1/hole_tol: lower deviation 0.1 exceeds upper 0.0"),
            "non-positive hole": (lambda l: l["heat_set"][0].update(hole_d=0), "limits/heat_set/0/hole_d"),
        }
        self.run_cases(cases, lambda: self.docs["interfaces.yaml"]["interfaces"][0]["limits"])

    def test_bom_procurement_columns(self) -> None:
        def designation(rows: list[dict[str, str]]) -> None:
            rows[1]["designation"] = "ISO 2338 5 x 20"

        def unit(rows: list[dict[str, str]]) -> None:
            rows[0]["unit"] = "kg"

        def partial(rows: list[dict[str, str]]) -> None:
            for row in rows:
                for column in PROCUREMENT_COLUMNS[1:]:
                    del row[column]

        for name, edit, expected in (
                ("designation differs from part.yaml", designation, "designation 'ISO 2338 5 x 20' does not match"),
                ("unit other than pcs", unit, "bom.csv:2: unit: 'kg' is not one of ['pcs']"),
                ("only some procurement columns", partial, "expected CSV columns in order")):
            with self.subTest(name):
                self.bom_edit = edit
                self.assert_rejected(expected)

    def run_cases(self, cases: dict[str, tuple[Callable[[dict], None], str]], target: Callable[[], dict]) -> None:
        """Apply each edit to a fresh copy of the valid record; the BOM is regenerated from the edited parts."""
        pristine = copy.deepcopy((self.docs, self.parts))
        for name, (edit, expected) in cases.items():
            with self.subTest(name):
                self.docs, self.parts = copy.deepcopy(pristine)
                edit(target())
                self.assert_rejected(expected)


if __name__ == "__main__":
    unittest.main()
