#!/usr/bin/env python3
"""cad-flow scratch workspace tests: a worker's copy, build, and delivery never touch the lead's records.

Run: python3 -m unittest discover -s cad/skills/cad-flow/tests -v
The init and deliver tests are stdlib-only. The build test needs `uv`; it builds a copy of the
checkout's lamp example (seven CadQuery parts) in a scratch workspace, so a cold uv cache adds minutes.
"""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRATCH = HERE.parent / "scripts" / "scratch.py"
sys.path.insert(0, str(HERE.parents[1] / "cad-drawings" / "scripts"))
import freecad_runtime  # noqa: E402
FREECADCMD = freecad_runtime.find_freecadcmd()
FREECAD_PRESENT = FREECADCMD is not None and FREECADCMD.is_file()

TEMPLATE = HERE.parents[1] / "cad-record" / "assets" / "project-template" / "hw"
VALIDATOR = HERE.parents[1] / "cad-record" / "scripts" / "validate.py"
LAMP_EXAMPLE = HERE.parents[2] / "examples" / "lamp-arm" / "hw"


def tree(root: Path) -> dict[str, str]:
    """Every file below `root` with its sha256, so a test can prove nothing changed."""
    return {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(root.rglob("*")) if path.is_file()}


def load_scratch():
    """A fresh scratch.py module, so a test can replace its tool runner."""
    spec = importlib.util.spec_from_file_location("cad_flow_scratch", SCRATCH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ScratchCase(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="cad-scratch-test-")
        self.addCleanup(temporary.cleanup)
        self.project = Path(temporary.name)
        self.hw = self.project / "hw"

    def use_generic_template(self) -> None:
        shutil.copytree(TEMPLATE, self.hw)
        part = self.hw / "parts" / "PRT-0001"
        part.mkdir(parents=True)
        (part / "part.yaml").write_text(
            "PN: PRT-0001\nrev: X1\ntitle: Placeholder part\nmaterial: Placeholder material\n"
            "process: cnc\nfinish: As machined\nmass_target: null\nmake_buy: make\n", encoding="utf-8")
        result = subprocess.run([sys.executable, str(VALIDATOR), str(self.project)],
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout), {"ok": True, "findings": []})

    def use_lamp_example(self) -> None:
        shutil.copytree(LAMP_EXAMPLE, self.hw)

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
    def setUp(self) -> None:
        super().setUp()
        self.use_generic_template()

    def test_init_copies_the_generic_record_without_versions_or_renders(self) -> None:
        report = self.init("part-base_sub", "PRT-0001")
        scratch_hw = Path(report["scratch_hw"])
        self.assertEqual(scratch_hw, (self.project / ".cad-work" / "part-base_sub" / "hw").resolve())
        self.assertFalse((scratch_hw / "versions").exists())
        self.assertFalse((scratch_hw / "renders").exists())
        self.assertEqual((self.project / ".cad-work" / ".gitignore").read_text(encoding="utf-8"), "*\n")
        baseline = json.loads((scratch_hw.parent / "baseline.json").read_text(encoding="utf-8"))
        self.assertEqual(baseline["parts"], ["PRT-0001"])
        self.assertEqual(sorted(baseline["files"]), sorted(tree(self.hw)))

    def test_init_rejects_unsafe_units_and_malformed_part_numbers(self) -> None:
        for args in (("--unit", "../escape", "--part", "PRT-0001"), ("--unit", "ok", "--part", "bad"),
                     ("--unit", "ok")):
            with self.subTest(args=args):
                code, report = self.scratch("init", "--hw", "hw", *args)
                self.assertEqual((code, report["status"]), (2, "error"))
        self.assertFalse((self.project / ".cad-work").exists())


    def test_deliver_refuses_a_hidden_generated_subtree_without_writing(self) -> None:
        scratch_hw = Path(self.init("part-base_sub", "PRT-0001")["scratch_hw"])
        generated = scratch_hw / "parts" / "PRT-0001" / ".generated" / "mesh.step"
        generated.parent.mkdir()
        generated.write_bytes(b"not a record source")
        before = tree(self.hw)
        code, report = self.scratch("deliver", "--hw", "hw", "--unit", "part-base_sub")
        self.assertEqual((code, report["status"]), (2, "error"), report)
        self.assertIn("non-record or non-canonical", report["error"])
        self.assertEqual(tree(self.hw), before)

    def test_deliver_refuses_an_unauthorized_new_part_without_writing(self) -> None:
        scratch_hw = Path(self.init("part-base_sub", "PRT-0001")["scratch_hw"])
        unauthorized = scratch_hw / "parts" / "PRT-0002"
        unauthorized.mkdir()
        (unauthorized / "part.yaml").write_text("PN: PRT-0002\n", encoding="utf-8")
        before = tree(self.hw)
        code, report = self.scratch("deliver", "--hw", "hw", "--unit", "part-base_sub")
        self.assertEqual((code, report["status"]), (2, "error"), report)
        self.assertIn("not authorized for new part PRT-0002", report["error"])
        self.assertEqual(tree(self.hw), before)

    def test_deliver_adds_an_authorized_new_part_under_parts(self) -> None:
        scratch_hw = Path(self.init("part-base_sub", "PRT-0002")["scratch_hw"])
        part = scratch_hw / "parts" / "PRT-0002"
        self.assertTrue(part.is_dir())
        (part / "part.yaml").write_text(
            "PN: PRT-0002\nrev: X1\ntitle: New placeholder\nmaterial: Placeholder material\n"
            "process: cnc\nfinish: As machined\nmass_target: null\nmake_buy: make\n", encoding="utf-8")
        before = tree(self.hw)
        code, report = self.scratch("deliver", "--hw", "hw", "--unit", "part-base_sub")
        self.assertEqual((code, report["status"]), (0, "delivered"), report)
        self.assertIn(str((self.hw / "parts" / "PRT-0002" / "part.yaml").resolve()), report["delivered"])
        self.assertEqual((self.hw / "parts" / "PRT-0002" / "part.yaml").read_text(encoding="utf-8"),
                         (part / "part.yaml").read_text(encoding="utf-8"))
        self.assertEqual(tree(self.hw)["parts/PRT-0001/part.yaml"], before["parts/PRT-0001/part.yaml"])
    def test_deliver_writes_only_the_units_parts_and_lists_the_rest_as_proposals(self) -> None:
        before = tree(self.hw)
        scratch_hw = Path(self.init("part-base_sub", "PRT-0001")["scratch_hw"])
        (scratch_hw / "parts" / "PRT-0001" / "model.py").write_text("def build(params):\n    return None\n", encoding="utf-8")
        with (scratch_hw / "interfaces.yaml").open("a", encoding="utf-8") as stream:
            stream.write("# proposed: widen IF-004 slot\n")
        code, report = self.scratch("deliver", "--hw", "hw", "--unit", "part-base_sub")
        self.assertEqual((code, report["status"]), (0, "delivered"), report)
        self.assertEqual(tree(self.hw), {**before, "parts/PRT-0001/model.py": hashlib.sha256(
            b"def build(params):\n    return None\n").hexdigest()})
        (scratch_hw / "parts" / "PRT-0001" / "notes.txt").write_text("work in progress\n", encoding="utf-8")
        again = self.init("part-base_sub", "PRT-0001")
        self.assertEqual(again["status"], "exists")
        self.assertTrue((scratch_hw / "parts" / "PRT-0001" / "notes.txt").is_file())
        code, reset = self.scratch("init", "--hw", "hw", "--unit", "part-base_sub", "--part", "PRT-0001", "--reset")
        self.assertEqual((code, reset["status"]), (0, "created"))
        self.assertFalse((scratch_hw / "parts" / "PRT-0001" / "notes.txt").exists())

    def test_deliver_refuses_a_part_changed_since_init_and_writes_nothing(self) -> None:
        scratch_hw = Path(self.init("part-base_sub", "PRT-0001")["scratch_hw"])
        (scratch_hw / "parts" / "PRT-0001" / "model.py").write_text("# scratch rewrite\n", encoding="utf-8")
        record = self.hw / "parts" / "PRT-0001" / "part.yaml"
        record.write_text(record.read_text(encoding="utf-8").replace("mass_target: null", "mass_target: 10"), encoding="utf-8")
        before = tree(self.hw)
        code, report = self.scratch("deliver", "--hw", "hw", "--unit", "part-base_sub")
        self.assertEqual((code, report["status"]), (1, "conflict"), report)
        self.assertEqual(report["changed_since_init"], [str(self.hw.resolve() / "parts" / "PRT-0001")])
        self.assertEqual(tree(self.hw), before)

    def test_deliver_ignores_python_bytecode_caches_and_never_copies_them(self) -> None:
        scratch_hw = Path(self.init("part-base_sub", "PRT-0001")["scratch_hw"])
        part = scratch_hw / "parts" / "PRT-0001"
        (part / "model.py").write_text("def build(params):\n    return None\n", encoding="utf-8")
        for cache in (part / "__pycache__", scratch_hw / "__pycache__"):
            cache.mkdir()
            (cache / "model.cpython-312.pyc").write_bytes(b"generated bytecode")
        code, report = self.scratch("deliver", "--hw", "hw", "--unit", "part-base_sub")
        self.assertEqual((code, report["status"]), (0, "delivered"), report)
        self.assertEqual(report["proposals"], [])
        self.assertTrue((self.hw / "parts" / "PRT-0001" / "model.py").is_file())
        self.assertFalse((self.hw / "parts" / "PRT-0001" / "__pycache__").exists())
        self.assertFalse((self.hw / "__pycache__").exists())

    def test_build_passes_each_attach_to_cad_model_run_and_reports_it(self) -> None:
        scratch_module = load_scratch()
        self.init("part-base_sub", "PRT-0001")
        calls = []

        def run_tool(argv: list[str], _log: Path) -> tuple[int, dict]:
            calls.append(argv)
            if argv[1] == "run":
                version = Path(argv[2]) / "versions" / argv[argv.index("--label") + 1]
                version.mkdir(parents=True)
                (version / "manifest.json").write_text("{}\n", encoding="utf-8")
                return 0, {"findings": []}
            if argv[1] == "check":
                return 0, {"blocking_failures": [], "warnings": []}
            return 0, {"findings": []}

        stdout = io.StringIO()
        with mock.patch.object(scratch_module, "run_tool", side_effect=run_tool), redirect_stdout(stdout):
            code = scratch_module.main(["build", "--hw", str(self.hw), "--unit", "part-base_sub", "--fidelity", "F2",
                                        "--attach", "PRT-0002=PRT-0001", "--attach", "@foot-1=PRT-0001"])
        report = json.loads(stdout.getvalue())
        self.assertEqual((code, report["status"]), (0, "pass"), report)
        self.assertEqual(report["attach"], ["PRT-0002=PRT-0001", "@foot-1=PRT-0001"])
        run = next(argv for argv in calls if argv[1] == "run")
        self.assertEqual(run[run.index("--attach"):], ["--attach", "PRT-0002=PRT-0001", "--attach", "@foot-1=PRT-0001"])

    def test_build_then_deliver_ignores_generated_version_output(self) -> None:
        scratch_module = load_scratch()

        unit = "part-base_sub"
        code, initialized = scratch_module.init(self.hw, unit, ["PRT-0001"], reset=False)
        self.assertEqual(code, 0, initialized)
        scratch_hw = Path(initialized["scratch_hw"])
        model = scratch_hw / "parts" / "PRT-0001" / "model.py"
        model.write_text("def build(params):\n    return None\n", encoding="utf-8")

        def run_tool(argv: list[str], _log: Path) -> tuple[int, dict]:
            if argv[1] == "run":
                versions = Path(argv[2]) / "versions"
                label = argv[argv.index("--label") + 1]
                (versions / label).mkdir(parents=True)
                (versions / label / "manifest.json").write_text("{}\n", encoding="utf-8")
                (versions / "latest.json").write_text('{"version":"v1"}\n', encoding="utf-8")
                return 0, {"findings": []}
            if argv[1] == "check":
                return 0, {"blocking_failures": [], "warnings": []}
            return 0, {"findings": []}

        with mock.patch.object(scratch_module, "run_tool", side_effect=run_tool):
            build_code, build_report = scratch_module.build(self.hw, unit, "cadquery", "F2")
        self.assertEqual((build_code, build_report["status"]), (0, "pass"), build_report)
        self.assertTrue((scratch_hw / "versions" / "latest.json").is_file())

        deliver_code, deliver_report = scratch_module.deliver(self.hw, unit)
        self.assertEqual((deliver_code, deliver_report["status"]), (0, "delivered"), deliver_report)
        self.assertIn(str(self.hw / "parts" / "PRT-0001" / "model.py"), deliver_report["delivered"])
        self.assertTrue((self.hw / "parts" / "PRT-0001" / "model.py").is_file())


class LampExample(ScratchCase):
    def setUp(self) -> None:
        super().setUp()
        self.use_lamp_example()

    def test_lamp_example_copies_as_a_separate_scratch_project(self) -> None:
        report = self.init("part-base_sub", "LMP-0001")
        scratch_hw = Path(report["scratch_hw"])
        self.assertTrue((scratch_hw / "parts" / "LMP-0001" / "model.py").is_file())
        self.assertEqual(json.loads((scratch_hw.parent / "baseline.json").read_text(encoding="utf-8"))["parts"],
                         ["LMP-0001"])
        self.assertEqual(sorted(path.name for path in (scratch_hw / "parts").iterdir()),
                         [f"LMP-{number:04d}" for number in range(1, 12)])


    @unittest.skipUnless(FREECAD_PRESENT, "lamp build needs FreeCAD 1.1.4 bundled Osifont")
    def test_build_checks_the_scratch_copy_and_never_touches_hw_versions(self) -> None:
        before = tree(self.hw)
        self.init("part-base_sub", "LMP-0001")
        code, report = self.scratch("build", "--hw", "hw", "--unit", "part-base_sub", "--fidelity", "F2",
                                    "--kernel", "cadquery", python=False, timeout=1800)
        self.assertEqual((code, report["status"]), (0, "pass"), json.dumps(report, indent=2))
        self.assertEqual(report["label"], "v1")
        scratch_hw = (self.project / ".cad-work" / "part-base_sub" / "hw").resolve()
        self.assertEqual(Path(report["version_dir"]), scratch_hw / "versions" / "v1")
        self.assertTrue((scratch_hw / "versions" / "v1" / "parts" / "LMP-0001.step").is_file())
        self.assertEqual(report["check"]["exit"], 0)
        self.assertTrue(Path(report["check"]["json"]).is_file() and Path(report["form"]["json"]).is_file())
        for tool in ("run", "check", "form"):
            self.assertTrue(Path(report[tool]["log"]).is_file(), tool)
        self.assertEqual(report["form"]["own_findings"], [])
        self.assertEqual(tree(self.hw), before)


if __name__ == "__main__":
    unittest.main()
