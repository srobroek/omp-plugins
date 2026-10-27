#!/usr/bin/env python3
"""cad-flow scratch workspace tests: a worker's copy, build, and delivery never touch the lead's records.

Run: python3 -m unittest discover -s cad/skills/cad-flow/tests -v
The init and deliver tests are stdlib-only. The build test needs `uv`; it builds the cad-record
lamp template (seven CadQuery parts) in a scratch copy, so a cold uv cache adds minutes.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRATCH = HERE.parent / "scripts" / "scratch.py"
TEMPLATE = HERE.parents[1] / "cad-record" / "assets" / "project-template" / "hw"


def tree(root: Path) -> dict[str, str]:
    """Every file below `root` with its sha256, so a test can prove nothing changed."""
    return {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(root.rglob("*")) if path.is_file()}


class ScratchCase(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="cad-scratch-test-")
        self.addCleanup(temporary.cleanup)
        self.project = Path(temporary.name)
        self.hw = self.project / "hw"
        shutil.copytree(TEMPLATE, self.hw)
        # A lead-built version and render the worker must never see or change.
        (self.hw / "versions" / "v7").mkdir(parents=True)
        (self.hw / "versions" / "v7" / "manifest.json").write_text('{"label": "v7"}\n', encoding="utf-8")
        (self.hw / "versions" / "latest.json").write_text('{"label": "v7"}\n', encoding="utf-8")
        (self.hw / "renders" / "v7").mkdir(parents=True)
        (self.hw / "renders" / "v7" / "iso.png").write_bytes(b"png")

    def scratch(self, *args: str, python: bool = True, timeout: int = 60) -> tuple[int, dict]:
        argv = [sys.executable, str(SCRATCH)] if python else ["uv", "run", "--quiet", "--script", str(SCRATCH)]
        done = subprocess.run([*argv, *args], cwd=self.project, capture_output=True, text=True, timeout=timeout)
        try:
            return done.returncode, json.loads(done.stdout)
        except ValueError:
            self.fail(f"no JSON on stdout (exit {done.returncode}):\n{done.stdout}\n{done.stderr[-4000:]}")

    def init(self, unit: str, *parts: str) -> dict:
        code, report = self.scratch("init", "--hw", "hw", "--unit", unit, *(f"--part={pn}" for pn in parts))
        self.assertEqual(code, 0, report)
        return report


class InitAndDeliver(ScratchCase):
    def test_init_copies_the_record_without_versions_or_renders(self) -> None:
        report = self.init("part-base_sub", "LMP-0001")
        scratch_hw = Path(report["scratch_hw"])
        self.assertEqual(scratch_hw, (self.project / ".cad-work" / "part-base_sub" / "hw").resolve())
        self.assertTrue((scratch_hw / "parts" / "LMP-0001" / "model.py").is_file())
        self.assertFalse((scratch_hw / "versions").exists())
        self.assertFalse((scratch_hw / "renders").exists())
        self.assertEqual((self.project / ".cad-work" / ".gitignore").read_text(encoding="utf-8"), "*\n")
        baseline = json.loads((scratch_hw.parent / "baseline.json").read_text(encoding="utf-8"))
        self.assertEqual(baseline["parts"], ["LMP-0001"])
        self.assertIn("parts/LMP-0001/model.py", baseline["files"])
        self.assertFalse(any(path.startswith(("versions/", "renders/")) for path in baseline["files"]))

        (scratch_hw / "parts" / "LMP-0001" / "notes.txt").write_text("work in progress\n", encoding="utf-8")
        again = self.init("part-base_sub", "LMP-0001")
        self.assertEqual(again["status"], "exists")
        self.assertTrue((scratch_hw / "parts" / "LMP-0001" / "notes.txt").is_file())
        code, reset = self.scratch("init", "--hw", "hw", "--unit", "part-base_sub", "--part", "LMP-0001", "--reset")
        self.assertEqual((code, reset["status"]), (0, "created"))
        self.assertFalse((scratch_hw / "parts" / "LMP-0001" / "notes.txt").exists())

    def test_init_rejects_unsafe_units_and_malformed_part_numbers(self) -> None:
        for args in (("--unit", "../escape", "--part", "LMP-0001"), ("--unit", "ok", "--part", "lmp-1"),
                     ("--unit", "ok")):
            with self.subTest(args=args):
                code, report = self.scratch("init", "--hw", "hw", *args)
                self.assertEqual((code, report["status"]), (2, "error"))
        self.assertFalse((self.project / ".cad-work").exists())

    def test_deliver_writes_only_the_units_parts_and_lists_the_rest_as_proposals(self) -> None:
        before = tree(self.hw)
        scratch_hw = Path(self.init("part-base_sub", "LMP-0001")["scratch_hw"])
        model = scratch_hw / "parts" / "LMP-0001" / "model.py"
        model.write_text(model.read_text(encoding="utf-8").replace('"radius": 80.0', '"radius": 82.0'), encoding="utf-8")
        (scratch_hw / "parts" / "LMP-0001" / "__pycache__").mkdir()
        (scratch_hw / "parts" / "LMP-0001" / "__pycache__" / "model.pyc").write_bytes(b"cache")
        with (scratch_hw / "interfaces.yaml").open("a", encoding="utf-8") as stream:
            stream.write("# proposed: widen IF-004 slot\n")
        sibling = scratch_hw / "parts" / "LMP-0002" / "part.yaml"
        sibling.write_text(sibling.read_text(encoding="utf-8").replace("rev: X1", "rev: X2"), encoding="utf-8")

        code, report = self.scratch("deliver", "--hw", "hw", "--unit", "part-base_sub")
        self.assertEqual((code, report["status"]), (0, "delivered"), report)
        after = tree(self.hw)
        changed = {path for path in before.keys() | after.keys() if before.get(path) != after.get(path)}
        self.assertEqual(changed, {"parts/LMP-0001/model.py"})
        self.assertIn('"radius": 82.0', (self.hw / "parts" / "LMP-0001" / "model.py").read_text(encoding="utf-8"))
        self.assertEqual(sorted(report["delivered"]), sorted(str(p) for p in (self.hw.resolve() / "parts" / "LMP-0001").iterdir()))
        proposals = {(Path(p["path"]).relative_to(self.hw.resolve()).as_posix(), p["change"]) for p in report["proposals"]}
        self.assertEqual(proposals, {("interfaces.yaml", "modified"), ("parts/LMP-0002/part.yaml", "modified")})
        self.assertTrue(all(Path(p["path"]).is_absolute() and Path(p["scratch"]).is_file() for p in report["proposals"]))

        model.write_text(model.read_text(encoding="utf-8").replace('"radius": 82.0', '"radius": 84.0'), encoding="utf-8")
        code, again = self.scratch("deliver", "--hw", "hw", "--unit", "part-base_sub")
        self.assertEqual((code, again["status"]), (0, "delivered"), again)
        self.assertIn('"radius": 84.0', (self.hw / "parts" / "LMP-0001" / "model.py").read_text(encoding="utf-8"))

    def test_deliver_refuses_a_part_changed_since_init_and_writes_nothing(self) -> None:
        scratch_hw = Path(self.init("part-base_sub", "LMP-0001")["scratch_hw"])
        (scratch_hw / "parts" / "LMP-0001" / "model.py").write_text("# scratch rewrite\n", encoding="utf-8")
        record = self.hw / "parts" / "LMP-0001" / "part.yaml"
        record.write_text(record.read_text(encoding="utf-8").replace("mass_target: 313", "mass_target: 300"), encoding="utf-8")
        before = tree(self.hw)
        code, report = self.scratch("deliver", "--hw", "hw", "--unit", "part-base_sub")
        self.assertEqual((code, report["status"]), (1, "conflict"), report)
        self.assertEqual(report["changed_since_init"], [str(self.hw.resolve() / "parts" / "LMP-0001")])
        self.assertEqual(tree(self.hw), before)


@unittest.skipIf(shutil.which("uv") is None, "uv is not on PATH")
class Build(ScratchCase):
    def test_build_checks_the_scratch_copy_and_never_touches_hw_versions(self) -> None:
        before = tree(self.hw)
        self.init("part-base_sub", "LMP-0001")
        code, report = self.scratch("build", "--hw", "hw", "--unit", "part-base_sub", "--fidelity", "F2",
                                    "--kernel", "cadquery", python=False, timeout=1800)
        self.assertEqual((code, report["status"]), (0, "pass"), json.dumps(report, indent=2))
        self.assertEqual(report["label"], "v1")  # the scratch copy starts without the lead's versions
        scratch_hw = (self.project / ".cad-work" / "part-base_sub" / "hw").resolve()
        self.assertEqual(Path(report["version_dir"]), scratch_hw / "versions" / "v1")
        self.assertTrue((scratch_hw / "versions" / "v1" / "parts" / "LMP-0001.step").is_file())
        self.assertEqual(report["check"]["exit"], 0)
        self.assertTrue(Path(report["check"]["json"]).is_file() and Path(report["form"]["json"]).is_file())
        self.assertEqual(report["form"]["own_findings"], [])
        self.assertEqual(tree(self.hw), before)  # hw/versions, hw/renders, and every record unchanged


if __name__ == "__main__":
    unittest.main()
