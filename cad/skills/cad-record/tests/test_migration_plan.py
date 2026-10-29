#!/usr/bin/env python3
"""validate.py --migration-plan: every stray, legacy or damaged path with its destination; nothing changes."""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

SKILL = Path(__file__).resolve().parents[1]
VALIDATOR = SKILL / "scripts" / "validate.py"
LAMP = SKILL.parent.parent / "examples" / "lamp-arm" / "hw"


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path: Path, text: str = "x\n") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def tree(root: Path) -> dict[str, str]:
    return {p.relative_to(root).as_posix(): ("dir" if p.is_dir() else sha(p)) for p in sorted(root.rglob("*"))}


class MigrationPlan(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="cad-migration-test-")
        self.addCleanup(temporary.cleanup)
        self.project = Path(temporary.name) / "project"
        self.hw = self.project / "hw"
        shutil.copytree(LAMP, self.hw)
        # a demo-style record: a v1 built before manufacturing outputs, a version 1 release, loose files
        version = self.hw / "versions" / "v1"
        write(version / "assembly.step")
        write(version / "manifest.json", json.dumps({"label": "v1", "files": {"assembly.step": sha(version / "assembly.step")}}))
        write(self.hw / "releases" / "A" / "manifest.json", json.dumps(
            {"product_id": "lamp-arm", "rev": "A", "released_at": "2026-01-01T00:00:00Z", "files": ["hw/bom.csv"],
             "checks": {}}))
        for name in ("print/LMP-0004_flat.step", "print/LMP-0004_bent.step", "print/LMP-0004.stl",
                     "print/VXA-0004_flat.step", "print/export_flat_plug.py", "print/settings.ini",
                     "drawings/LMP-0001/sheet-1.svg", "renders/v1/iso.png", "notes.md", "docs/notes.md", "docs/.DS_Store"):
            write(self.hw / name, f"{name}\n")

    def plan(self, *extra: str) -> tuple[int, Any]:
        result = subprocess.run([sys.executable, str(VALIDATOR), str(self.project), "--migration-plan", *extra],
                                capture_output=True, text=True, timeout=120, check=False)
        return result.returncode, (json.loads(result.stdout) if result.stdout.strip() else result.stderr)

    def test_every_stray_gets_its_destination_and_nothing_changes(self) -> None:
        before = tree(self.project)
        code, plan = self.plan()
        self.assertEqual(code, 0, plan)
        self.assertEqual(tree(self.project), before, "the plan moves, deletes and writes nothing")
        items = {item["path"]: item for item in plan["items"]}
        self.assertEqual((plan["next_version"], plan["changed"]), ("v2", False))

        def row(path: str) -> tuple[Any, ...]:
            item = items[path]
            return (item["classification"], item["operation"], item["destination"], item["confidence"], item["rebuild"],
                    item["collisions"])

        model = "cad-model cad_model.py run"
        flat = "hw/versions/v2/manufacturing/LMP-0004/part.step"
        self.assertEqual(row("hw/print/LMP-0004_flat.step"),
                         ("geometry", "rebuild", flat, "medium", model, ["hw/print/LMP-0004_bent.step"]))
        self.assertEqual(row("hw/print/LMP-0004_bent.step"),
                         ("geometry", "rebuild", flat, "medium", model, ["hw/print/LMP-0004_flat.step"]))
        self.assertEqual(row("hw/print/LMP-0004.stl"),
                         ("geometry", "rebuild", "hw/versions/v2/manufacturing/LMP-0004/part.stl", "medium", model, []))
        self.assertEqual(row("hw/print/VXA-0004_flat.step"),
                         ("geometry", "rebuild", "hw/versions/v2/manufacturing/VXA-0004/part.step", "low", model, []))
        self.assertEqual(row("hw/print/export_flat_plug.py"),
                         ("script", "move", ".cad-work/migration/print/export_flat_plug.py", "high", None, []))
        self.assertEqual(row("hw/print/settings.ini"),
                         ("data", "move", ".cad-work/migration/print/settings.ini", "low", None, []))
        self.assertEqual(row("hw/drawings/LMP-0001/sheet-1.svg"),
                         ("legacy", "rebuild", "hw/drawings/<V>/LMP-0001/", "medium",
                          "cad-drawings drawing.py, assembly_drawing.py", []))
        self.assertEqual(row("hw/renders/v1/iso.png"),
                         ("legacy", "rebuild", "hw/renders/v1/<subject>/", "medium", "cad-render render.py", []))
        self.assertEqual(row("hw/notes.md"), ("document", "move", "hw/docs/notes.md", "high", None, []))
        self.assertTrue(items["hw/notes.md"]["destination_exists"], "hw/docs/notes.md already exists: a collision")
        self.assertEqual(row("hw/docs/.DS_Store")[:2], ("metadata", "remove"))
        self.assertEqual(row("hw/versions/v1"), ("legacy version", "keep", None, "high", model, []))
        self.assertIn("cannot be frozen or released", items["hw/versions/v1"]["action"])
        self.assertEqual(row("hw/releases/A")[:2], ("legacy release", "keep"))
        for item in plan["items"]:
            self.assertTrue(item["action"], item["path"])
        self.assertEqual(sum(plan["counts"].values()), len(plan["items"]))

    def test_the_report_goes_to_stdout_or_a_path_under_cad_work_only(self) -> None:
        before = tree(self.hw)
        code, answer = self.plan("--report", str(self.project / ".cad-work" / "migration" / "plan.json"))
        self.assertEqual((code, answer), (0, {"report": ".cad-work/migration/plan.json"}))
        written = json.loads((self.project / ".cad-work" / "migration" / "plan.json").read_text(encoding="utf-8"))
        self.assertEqual(written["plan"], "migration")
        self.assertEqual(tree(self.hw), before)
        code, answer = self.plan("--report", str(self.hw / "docs" / "plan.json"))
        self.assertEqual(code, 2)
        self.assertIn("--report must be under", answer["findings"][0]["message"])
        self.assertFalse((self.hw / "docs" / "plan.json").exists())
        result = subprocess.run([sys.executable, str(VALIDATOR), str(self.project), "--report", "x.json"],
                                capture_output=True, text=True, timeout=60, check=False)
        self.assertEqual(result.returncode, 2)
        self.assertIn("--report needs --migration-plan", result.stderr)


if __name__ == "__main__":
    unittest.main()
