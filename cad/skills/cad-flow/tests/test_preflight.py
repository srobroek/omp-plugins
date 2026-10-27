#!/usr/bin/env python3
"""Focused tests for CAD preflight result semantics and FreeCAD failure reporting."""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "preflight.py"
spec = importlib.util.spec_from_file_location("cad_preflight", SCRIPT)
assert spec is not None and spec.loader is not None
preflight = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = preflight
spec.loader.exec_module(preflight)


class ReportTests(unittest.TestCase):
    def test_required_failure_sets_exit_code_and_summary(self) -> None:
        report = preflight.Report((
            preflight.Check("uv", "uv", "pass", True, "uv 1.0", ""),
            preflight.Check("freecad", "FreeCAD", "fail", True, "missing", "install it"),
        ))
        self.assertEqual(report.exit_code, 1)
        self.assertEqual(report.counts, {"pass": 1, "fail": 1, "warn": 0})

    def test_report_json_includes_elapsed_time(self) -> None:
        report = preflight.Report((preflight.Check("uv", "uv", "pass", True, "uv", "", 1.25),))
        self.assertEqual(report.as_json()["checks"][0]["elapsed_s"], 1.25)
        self.assertIn("uv 1.2s", report.summary)

    def test_required_failure_keeps_json_fix_and_text_hint(self) -> None:
        report = preflight.Report((preflight.Check("freecad", "FreeCAD", "fail", True, "missing", "install it"),))
        self.assertEqual(report.exit_code, 1)
        self.assertEqual(report.as_json()["checks"][0]["fix"], "install it")
        self.assertIn("Fix: install it", preflight.render_text(report))

    def test_optional_warning_does_not_fail_report(self) -> None:
        report = preflight.Report((
            preflight.Check("beads", "Beads", "warn", False, "not installed", "install bd"),
        ))
        self.assertEqual(report.exit_code, 0)
        self.assertEqual(report.counts["warn"], 1)


    def test_kernel_probe_syncs_runner_and_uses_its_python(self) -> None:
        runner = SCRIPT.parents[1] / "cad-model" / "scripts" / "run_cadquery.py"
        calls = []

        class Result:
            returncode = 0
            stdout = "CAD_PREFLIGHT:\"2.8.0\"\n"
            stderr = ""

        def run(args, **kwargs):
            calls.append(args)
            if args[1:3] == ["python", "find"]:
                return type("Found", (), {"returncode": 0, "stdout": "/resolved/uv/python\n", "stderr": ""})()
            return Result()

        with patch.object(preflight.subprocess, "run", side_effect=run):
            check = preflight._script_probe("uv", "cadquery", runner, "cadquery", "2.8.0")
        self.assertEqual(check.status, "pass")
        self.assertEqual(calls[0][1:3], ["sync", "--script"])
        self.assertEqual(calls[0][-1], str(runner))
        self.assertEqual(calls[-1][:2], ["/resolved/uv/python", "-c"])
    def test_main_returns_report_exit_code_and_json(self) -> None:
        report = preflight.Report((preflight.Check("uv", "uv", "fail", True, "missing", "install"),))
        with patch.object(preflight, "run_checks", return_value=report), patch("sys.stdout") as stdout:
            result = preflight.main(["--json", "--harness", "omp"])
        self.assertEqual(result, 1)
        output = "".join(call.args[0] for call in stdout.write.call_args_list)
        self.assertIn('"exit_code": 1', output)

    def test_invalid_status_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            preflight.Check("bad", "bad", "unknown", True, "", "")


class FreeCADTests(unittest.TestCase):
    def test_missing_configured_freecad_fails_with_install_hint(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cad-preflight-missing-freecad-") as directory:
            root = Path(directory)
            path = root / "empty-path"
            path.mkdir()
            missing = root / "missing" / "freecadcmd"
            checks = preflight._timed_freecad_checks({"FREECADCMD": str(missing), "PATH": str(path)})
        command = checks[0]
        self.assertEqual(command.status, "fail")
        self.assertIn("Configured FreeCAD command is missing", command.detail)
        self.assertIn("Install FreeCAD 1.1.4", command.fix)
        self.assertIn("FREECADCMD", command.fix)
        self.assertEqual(checks[1].status, "fail")
        self.assertEqual(checks[2].status, "fail")

if __name__ == "__main__":
    unittest.main()
