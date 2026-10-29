#!/usr/bin/env python3
"""drawing_merge: a reviewed draft's drawing block into part.yaml, or a refusal that leaves part.yaml as it was.

Kernel-free: the project and its version folder are written by test_drawing_framework.write_project,
hashed as ``cad_model.py run`` writes them, with a ``bed_face`` drawing_features locator.
Run: uv run --with pyyaml --with defusedxml --with jsonschema python -m unittest discover -s cad/skills/cad-drawings/tests -p test_drawing_merge.py
"""

from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))
sys.path.insert(0, str(HERE))
import drawing_draft  # noqa: E402
import drawing_merge  # noqa: E402
from test_drawing_framework import PN, write_project  # noqa: E402

BLOCK = {"type": "detail",
         "datum_features": {"A": {"feature": "bed_face", "role": "plane"}},
         "views": [{"id": "plan", "kind": "orthographic", "normal_to": "A"}],
         "features": {"bed_face": {"size": "general"}},
         "notes": [{"kind": "finish", "text": "Anodised."}]}


class Merge(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)

    def project(self, *, features: bool = True, drawing: bool = True) -> Path:
        hw, _ = write_project(self.root, features=features)
        record = hw / "parts" / PN / "part.yaml"
        data = yaml.safe_load(record.read_text(encoding="utf-8"))
        if not drawing:
            del data["drawing"]
        # a hand-written record: comments and key order survive the merge
        body = yaml.safe_dump({k: v for k, v in data.items() if k != "drawing"}, sort_keys=False)
        tail = yaml.safe_dump({"drawing": data["drawing"]}, sort_keys=False) if drawing else ""
        record.write_text("# fixture plate, hand-written\n" + body + tail + "# end of record\n", encoding="utf-8")
        return hw

    def run_merge(self, hw: Path, block: object, *, part: str = PN) -> tuple[dict, int, str, str]:
        record = hw / "parts" / PN / "part.yaml"
        before = record.read_text(encoding="utf-8")
        draft = self.root / "draft.yaml"
        draft.write_text(yaml.safe_dump({"part": part, "recognized": [], "drawing": block}, sort_keys=False),
                         encoding="utf-8")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = drawing_merge.main([str(hw), "--version", "v1", "--part", PN, "--draft", str(draft)])
        return json.loads(out.getvalue()), code, before, record.read_text(encoding="utf-8")

    def test_reviewed_block_replaces_the_drawing_key_and_keeps_every_other_line(self) -> None:
        result, code, before, after = self.run_merge(self.project(), BLOCK)
        self.assertEqual((code, result["status"], result["features"]), (0, "pass", 1), result)
        self.assertEqual(yaml.safe_load(after)["drawing"], BLOCK)
        self.assertTrue(after.startswith("# fixture plate, hand-written\nPN: TST-0001\n"))
        self.assertTrue(after.endswith("# end of record\n"))
        kept = [line for line in before.splitlines() if not line.startswith((" ", "drawing:"))]
        self.assertEqual([line for line in after.splitlines() if not line.startswith((" ", "drawing:"))], kept)

    def test_a_record_without_a_drawing_key_gets_one_appended(self) -> None:
        result, code, before, after = self.run_merge(self.project(drawing=False), BLOCK)
        self.assertEqual(code, 0, result)
        self.assertTrue(after.startswith(before))
        self.assertEqual(yaml.safe_load(after)["drawing"], BLOCK)

    def test_a_review_placeholder_is_refused(self) -> None:
        block = {**BLOCK, "edges": "REVIEW: ISO 13715 limits", "notes": [{"kind": "finish", "text": "REVIEW"}]}
        result, code, before, after = self.run_merge(self.project(), block)
        self.assertEqual((code, after), (1, before))
        self.assertEqual(sorted(f["message"].split()[0] for f in result["findings"]), ["drawing.edges", "drawing.notes[0].text"])
        self.assertEqual({f["code"] for f in result["findings"]}, {"draft_unreviewed"})

    def test_a_feature_the_hook_does_not_return_is_refused(self) -> None:
        block = {**BLOCK, "features": {"bed_face": {"size": "general"}, "pocket_3_p1": {"size": "general"}},
                 "dimensions": [{"id": "floor", "operation": "thickness", "features": ["bed_face", "pocket_3_p1"]}]}
        result, code, before, after = self.run_merge(self.project(), block)
        self.assertEqual((code, after), (1, before))
        self.assertEqual([(f["code"], f["feature"]) for f in result["findings"]], [("feature_not_found", "pocket_3_p1")])
        self.assertIn("features, dimensions.floor", result["findings"][0]["message"])

    def test_a_version_without_the_hook_is_refused(self) -> None:
        result, code, before, after = self.run_merge(self.project(features=False), BLOCK)
        self.assertEqual((code, after, result["findings"][0]["code"]), (1, before, "drawing_intent_missing"))

    def test_a_block_the_record_schema_rejects_is_refused(self) -> None:
        result, code, before, after = self.run_merge(self.project(), {**BLOCK, "type": "sketch"})
        self.assertEqual((code, after, result["findings"][0]["code"]), (1, before, "invalid_drawing_intent"))

    def test_a_draft_for_another_part_is_invalid_input(self) -> None:
        result, code, before, after = self.run_merge(self.project(), BLOCK, part="TST-0002")
        self.assertEqual((code, after, result["findings"][0]["code"]), (2, before, "invalid_input"))


    def test_latest_selects_verified_built_version(self) -> None:
        hw, _ = write_project(self.root)
        (hw / "versions" / "latest.json").write_text('{"label": "v1"}\n', encoding="utf-8")
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = drawing_merge.main([str(hw), "--version", "latest", "--part", PN,
                                       "--draft", str(self.root / "absent.yaml")])
        result = json.loads(output.getvalue())
        self.assertEqual(code, 2)
        self.assertNotIn("AttributeError", result["findings"][0]["message"])
        self.assertIn("absent.yaml", result["findings"][0]["message"])

    def test_draft_output_must_be_in_project_scratch(self) -> None:
        hw, _ = write_project(self.root)
        (hw / "versions" / "latest.json").write_text('{"label": "v1"}\n', encoding="utf-8")
        out = hw / "parts" / PN
        self.assertEqual(drawing_draft.main([str(hw), "--version", "latest", "--part", PN,
                                             "--output-dir", str(out)]), 2)
if __name__ == "__main__":
    unittest.main()
