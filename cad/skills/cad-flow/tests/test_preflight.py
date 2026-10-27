#!/usr/bin/env python3
"""Focused tests for CAD preflight: result semantics, runtime probes, warm-up plan and record, FreeCAD failures."""

from __future__ import annotations

import importlib.util
import os
import subprocess
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
scriptenv = preflight.scriptenv


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


def completed(args, stdout: str = "", returncode: int = 0):
    return subprocess.CompletedProcess(args, returncode, stdout, "")


def runtime(identifier: str):
    return next(item for item in preflight.RUNTIMES if item.id == identifier)


class RuntimeProbeTests(unittest.TestCase):
    SITE = "/cache/archive-v0/AbC/lib/python3.12/site-packages"

    def test_kernel_probe_imports_in_the_environment_shared_by_dependency_set(self) -> None:
        kernel = runtime("cadquery")
        calls = []

        def run(args, **kwargs):
            calls.append(args)
            return completed(args, 'CAD_PREFLIGHT:{"version": "2.8.0", "file": "%s/cadquery/__init__.py"}\n' % self.SITE)

        with patch.object(preflight.subprocess, "run", side_effect=run):
            check = preflight._runtime_check("uv", kernel)
        self.assertEqual(check.status, "pass", check.detail)
        self.assertEqual(len(calls), 1, "a shared environment needs no separate sync")
        self.assertEqual(calls[0][:-2], scriptenv.python_command(kernel.script, uv="uv"))
        self.assertEqual(calls[0][-2], "-c")
        self.assertIn("import cadquery", calls[0][-1])
        self.assertIn(f"{self.SITE} (environment shared by dependency set)", check.detail)

    def test_path_probe_syncs_its_script_and_imports_with_that_python(self) -> None:
        orchestrator = runtime("cad-model")
        calls = []

        def run(args, **kwargs):
            calls.append(args)
            if args[1:3] == ["python", "find"]:
                return completed(args, "/env/bin/python\n")
            return completed(args, 'CAD_PREFLIGHT:{"version": "8.0.1.1.0", "file": "%s/OCP/__init__.py"}\n' % self.SITE)

        with patch.object(preflight.subprocess, "run", side_effect=run):
            check = preflight._runtime_check("uv", orchestrator)
        self.assertEqual(check.status, "pass", check.detail)
        self.assertEqual(calls[0], ["uv", "sync", "--script", str(orchestrator.script)])
        self.assertEqual(calls[-1][:2], ["/env/bin/python", "-c"])
        self.assertIn("of cad_model.py's path", check.detail)

    def test_a_version_other_than_the_header_pin_fails(self) -> None:
        def run(args, **kwargs):
            return completed(args, 'CAD_PREFLIGHT:{"version": "0.12.0", "file": "%s/build123d/__init__.py"}\n' % self.SITE)

        with patch.object(preflight.subprocess, "run", side_effect=run):
            check = preflight._runtime_check("uv", runtime("build123d"))
        self.assertEqual(check.status, "fail")
        self.assertIn("run_build123d.py pins 0.13.0", check.detail)

    def test_a_failed_import_reports_uv_last_error_line(self) -> None:
        def run(args, **kwargs):
            return subprocess.CompletedProcess(args, 1, "", "resolving\nerror: no wheel for cadquery-ocp\n")

        with patch.object(preflight.subprocess, "run", side_effect=run):
            check = preflight._runtime_check("uv", runtime("cadquery"))
        self.assertEqual(check.status, "fail")
        self.assertIn("error: no wheel for cadquery-ocp", check.detail)

    def test_chromium_install_runs_playwright_in_the_render_environment(self) -> None:
        calls = []

        def run(args, **kwargs):
            calls.append(args)
            if args[1:3] == ["python", "find"]:
                return completed(args, "/render-env/bin/python\n")
            return completed(args, 'CAD_PREFLIGHT:{"version": "1.64.1", "chromium": "150.0", "path": "/c/chrome"}\n')

        with patch.object(preflight.subprocess, "run", side_effect=run):
            check = preflight._chromium_check("uv", install=True)
        self.assertEqual(check.status, "pass", check.detail)
        self.assertEqual(calls[0], ["uv", "sync", "--script", str(preflight.CHROMIUM.script)])
        self.assertIn(["/render-env/bin/python", "-m", "playwright", "install", "chromium"], calls)
        self.assertIn("p.chromium.launch(headless=True)", calls[-1][-1])


class WarmPlanTests(unittest.TestCase):
    def plan(self, warm: bool) -> tuple[list[str], dict[str, object]]:
        order: list[str] = []
        seen: dict[str, object] = {}

        def passing(identifier: str) -> preflight.Check:
            order.append(identifier)
            return preflight.Check(identifier, identifier, "pass", True, "", "")

        def chromium(uv, install=False):
            seen["install"] = install
            return passing("playwright-chromium")

        def vendor(environ, fill=False):
            seen["fill"] = fill
            return passing("three-vendor-cache")

        with patch.object(preflight, "_uv_check", return_value=(passing("uv"), "uv")), \
                patch.object(preflight, "_runtime_check", side_effect=lambda uv, item: passing(item.id)), \
                patch.object(preflight, "_chromium_check", side_effect=chromium), \
                patch.object(preflight, "_vendor_check", side_effect=vendor), \
                patch.object(preflight, "_timed_freecad_checks", side_effect=lambda env, home: [passing("freecad-command")]), \
                patch.object(preflight, "_beads_check", side_effect=lambda cwd, env: passing("beads")), \
                patch.object(preflight, "_harness_check", side_effect=lambda name, *a: passing(f"harness-{name}")), \
                patch("sys.stderr"):
            report = preflight.run_checks({"HOME": "/nowhere"}, Path("/p"), Path("/nowhere"), "omp", warm=warm)
        self.assertEqual([check.id for check in report.checks], order)
        return order, seen

    def test_warm_first_loads_every_runtime_before_freecad_and_fetches_what_checks_need(self) -> None:
        order, seen = self.plan(warm=True)
        self.assertEqual(order[:6], ["uv", "cadquery", "build123d", "cad-model", "ocp-viewer", "playwright-chromium"])
        self.assertLess(order.index("three-vendor-cache"), order.index("freecad-command"))
        self.assertEqual(seen, {"install": True, "fill": True})

    def test_plain_preflight_installs_and_fetches_nothing(self) -> None:
        self.assertEqual(self.plan(warm=False)[1], {"install": False, "fill": False})


class WarmRecordTests(unittest.TestCase):
    def setUp(self) -> None:
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.environ = {"XDG_CACHE_HOME": folder.name, "HOME": folder.name}
        self.path = preflight.warm_record_path(self.environ)

    def report(self, status: str) -> dict:
        return preflight.Report((preflight.Check("cadquery", "cadquery", status, True, "d", "fix it"),)).as_json()

    def test_the_record_is_keyed_by_this_plugin_copy_under_the_cache_home(self) -> None:
        self.assertTrue(self.path.is_relative_to(Path(self.environ["XDG_CACHE_HOME"]) / "cad-flow" / "warm"))

    def test_warm_records_running_then_its_report(self) -> None:
        states = []

        def checks(*args, warm=False):
            states.append((preflight._read_record(self.path)["state"], warm))
            return preflight.Report((preflight.Check("uv", "uv", "pass", True, "", ""),))

        with patch.object(preflight, "run_checks", side_effect=checks):
            preflight.warm(self.environ)
        record = preflight._read_record(self.path)
        self.assertEqual(states, [("running", True)])
        self.assertEqual((record["state"], record["pid"], record["report"]["exit_code"]), ("finished", os.getpid(), 0))

    def test_status_distinguishes_missing_running_stopped_and_finished(self) -> None:
        self.assertEqual(preflight.warm_status(self.environ)[0], preflight.EXIT_NO_WARM)
        preflight._write_record(self.path, {"state": "running", "pid": os.getpid(), "started_at": "t0"})
        self.assertEqual(preflight.warm_status(self.environ)[0], preflight.EXIT_RUNNING)
        gone = subprocess.Popen([sys.executable, "-c", "pass"])
        gone.wait()
        preflight._write_record(self.path, {"state": "running", "pid": gone.pid, "started_at": "t0"})
        code, text = preflight.warm_status(self.environ)
        self.assertEqual(code, preflight.EXIT_NO_WARM)
        self.assertIn("stopped without a report", text)
        for status, expected in (("pass", 0), ("fail", 1)):
            preflight._write_record(self.path, {"state": "finished", "pid": 1, "started_at": "t0",
                                                "finished_at": "t1", "report": self.report(status)})
            code, text = preflight.warm_status(self.environ)
            with self.subTest(status=status):
                self.assertEqual(code, expected)
                self.assertIn("Warm-up finished at t1", text)

    def test_background_start_detaches_the_warm_up_and_returns_once_it_runs(self) -> None:
        spawned = []

        class Child:
            pid = 424242

            def __init__(self, command, **kwargs):
                spawned.append((command, kwargs))
                preflight._write_record(self_path, {"state": "running", "pid": self.pid, "started_at": "t0"})

            def poll(self):
                return None

        self_path = self.path
        with patch.object(preflight.subprocess, "Popen", Child):
            started = preflight.start_background(self.environ, harness="omp")
        self.assertTrue(started["started"], started)
        command, kwargs = spawned[0]
        self.assertEqual(command[1:], [str(SCRIPT), "--warm", "--harness", "omp"])
        self.assertTrue(kwargs["start_new_session"])
        self.assertIs(kwargs["stdin"], subprocess.DEVNULL)
        self.assertEqual(started["log"], str(self.path.with_suffix(".log")))

    def test_a_running_warm_up_is_reused_instead_of_started_twice(self) -> None:
        preflight._write_record(self.path, {"state": "running", "pid": os.getpid(), "started_at": "t0"})
        with patch.object(preflight.subprocess, "Popen") as popen:
            started = preflight.start_background(self.environ)
        popen.assert_not_called()
        self.assertEqual((started["started"], started["pid"]), (False, os.getpid()))


class MainTests(unittest.TestCase):
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
        self.assertIn("FreeCAD 1.1.4 freecadcmd was not found", command.detail)
        self.assertIn("Install FreeCAD 1.1.4", command.fix)
        self.assertIn("FREECADCMD", command.fix)
        self.assertEqual(checks[1].status, "fail")
        self.assertEqual(checks[2].status, "fail")

if __name__ == "__main__":
    unittest.main()
