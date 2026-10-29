#!/usr/bin/env python3
"""Focused tests for CAD setup planning and fail-fast tool requirements."""

from __future__ import annotations

import importlib.util
import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "setup.py"
spec = importlib.util.spec_from_file_location("cad_setup", SCRIPT)
assert spec is not None and spec.loader is not None
setup = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = setup
spec.loader.exec_module(setup)


def report(*failed: str):
    ids = ("uv", *setup.WARM_IDS, "freecad-command", "freecad-version", "techdraw-templates", "beads")
    checks = tuple(setup.preflight.Check(
        identifier, identifier, "fail" if identifier in failed else "pass", identifier != "beads", "detail", "fix")
        for identifier in ids)
    return setup.preflight.Report(checks)


class PlanTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.env = {"HOME": str(self.home)}

    def test_each_runtime_failure_uses_existing_warm_step(self) -> None:
        for identifier in setup.WARM_IDS:
            with self.subTest(check=identifier):
                items = setup.plan(report(identifier), self.root, self.home, self.env)
                warm = [item for item in items if item.id == f"warm-{identifier}"]
                self.assertEqual(len(warm), 1)
                self.assertIn(identifier, warm[0].command)

    def test_uv_and_runtime_failures_have_distinct_actions(self) -> None:
        items = setup.plan(report("uv", "cadquery"), self.root, self.home, self.env)
        identifiers = [item.id for item in items]
        self.assertEqual(identifiers[:2], ["uv", "warm-cadquery"])
        self.assertTrue(all(identifier in {"uv", "warm-cadquery", "manual-libraries"} for identifier in identifiers))
        self.assertIn("https://astral.sh/uv/install.sh", items[0].command)

    def test_formula_copy_is_idempotent(self) -> None:
        beads = self.root / "workspace" / ".beads"
        beads.mkdir(parents=True)
        env = {**self.env, "BEADS_DIR": str(beads)}
        planned = [item.id for item in setup.plan(report(), self.root, self.home, env)]
        self.assertIn("formulas", planned)
        self.assertTrue(all(identifier in {"formulas", "manual-libraries"} for identifier in planned))
        setup._copy_formulas(self.root, env)
        planned = [item.id for item in setup.plan(report(), self.root, self.home, env)]
        self.assertNotIn("formulas", planned)
        self.assertTrue(all(identifier == "manual-libraries" for identifier in planned))
        self.assertEqual({path.name for path in (beads / "formulas").glob("*.formula.toml")},
                         {path.name for path in setup.FORMULAS.glob("*.formula.toml")})

    def test_requested_harness_is_planned_but_not_implicit(self) -> None:
        with patch.object(setup, "_harness_needed", return_value=True):
            implicit = setup.plan(report(), self.root, self.home, self.env)
            requested = setup.plan(report(), self.root, self.home, self.env, "opencode")
        self.assertFalse(any(item.id.startswith("harness-") for item in implicit))
        self.assertIn("harness-opencode", [item.id for item in requested])

    def test_linux_browser_libraries_offer_playwright_deps_for_debian_and_ubuntu_derivatives(self) -> None:
        check = setup.preflight.Check(
            "playwright-chromium", "Playwright Chromium", "fail", True,
            "Could not launch Chromium", "install deps")
        for release in ({"ID": "ubuntu"}, {"ID": "linuxmint", "ID_LIKE": "ubuntu debian"}):
            with self.subTest(release=release), \
                    patch.object(setup.platform, "system", return_value="Linux"), \
                    patch.object(setup, "_release_info", return_value=release):
                items = setup.plan(setup.preflight.Report((check,)), self.root, self.home, self.env)
            browser = next(item for item in items if item.id == "browser-libraries")
            self.assertIn("playwright install-deps chromium", browser.command)

    def test_linux_browser_libraries_keep_manual_advice_outside_debian_family(self) -> None:
        check = setup.preflight.Check(
            "playwright-chromium", "Playwright Chromium", "fail", True,
            "Could not launch Chromium: libfoo.so.1", "install deps")
        with patch.object(setup.platform, "system", return_value="Linux"), \
                patch.object(setup, "_release_info", return_value={"ID": "amzn"}):
            items = setup.plan(setup.preflight.Report((check,)), self.root, self.home, self.env)
        browser = next(item for item in items if item.id == "browser-libraries-manual")
        self.assertIn("Debian/Ubuntu only", browser.command)
        self.assertIn("libfoo.so.1", browser.command)

    def test_linux_manual_plan_includes_ocp_shared_libraries(self) -> None:
        with patch.object(setup.platform, "system", return_value="Linux"):
            items = setup.plan(report(), self.root, self.home, self.env)
        manual = next(item for item in items if item.id == "manual-libraries")
        for library in ("libglvnd-glx", "libX11", "expat"):
            self.assertIn(library, manual.command)

    def test_setup_imports_subprocess_for_run_and_exception_path(self) -> None:
        self.assertIsNotNone(setup.subprocess)
        with patch.object(setup.subprocess, "run", side_effect=FileNotFoundError("missing")):
            with self.assertRaises(FileNotFoundError):
                setup._run(["missing-command"])

    def test_release_info_parses_id_like(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "os-release"
            path.write_text('ID="linuxmint"\nID_LIKE="ubuntu debian"\n', encoding="utf-8")
            self.assertTrue(setup._is_debian_family(setup._release_info(path)))
class MainTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.home = self.root / "home"
        self.home.mkdir()

    def test_missing_cad_tool_fails_before_other_actions(self) -> None:
        missing = setup.preflight.Check(
            "freecad-command", "FreeCAD command", "fail", True,
            "FreeCAD 1.1.4 freecadcmd was not found.",
            "Install FreeCAD 1.1.4 from https://github.com/FreeCAD/FreeCAD/releases/tag/1.1.4; "
            "lookup order: FREECADCMD, PATH, the macOS app bundle, ~/.local/bin/freecadcmd.")
        with patch.dict("os.environ", {"HOME": str(self.home), "FREECADCMD": "/nonexistent"}, clear=True), \
                patch.object(setup.preflight, "_timed_freecad_checks", return_value=[missing]), \
                patch.object(setup.preflight, "run_checks") as run_checks, \
                patch.object(setup, "plan") as plan, \
                redirect_stdout(io.StringIO()) as output:
            status = setup.main(["--yes"])
        self.assertNotEqual(status, 0)
        message = output.getvalue()
        self.assertIn("FreeCAD 1.1.4", message)
        self.assertIn("https://github.com/FreeCAD/FreeCAD/releases/tag/1.1.4", message)
        self.assertIn("FREECADCMD", message)
        self.assertIn("PATH", message)
        self.assertIn("macOS app bundle", message)
        self.assertIn("~/.local/bin/freecadcmd", message)
        run_checks.assert_not_called()
        plan.assert_not_called()

    def test_present_cad_tool_runs_normal_plan(self) -> None:
        checks = [
            setup.preflight.Check("freecad-command", "FreeCAD command", "pass", True, "present", ""),
            setup.preflight.Check("freecad-version", "FreeCAD version", "pass", True, "FreeCAD 1.1.4", ""),
            setup.preflight.Check("techdraw-templates", "TechDraw templates", "pass", True, "present", ""),
        ]
        expected = report()
        with patch.dict("os.environ", {"HOME": str(self.home)}, clear=True), \
                patch.object(setup.preflight, "_timed_freecad_checks", return_value=checks), \
                patch.object(setup.preflight, "run_checks", return_value=expected) as run_checks, \
                patch.object(setup, "plan", return_value=[]) as plan, \
                redirect_stdout(io.StringIO()) as output:
            status = setup.main([])
        self.assertEqual(status, 0)
        run_checks.assert_called_once()
        plan.assert_called_once()
        self.assertIn("Setup plan: nothing to do.", output.getvalue())
        self.assertIn("Dry run: no setup actions were executed.", output.getvalue())

    def test_cad_tool_failure_skips_action_even_with_yes(self) -> None:
        failed = setup.preflight.Check("freecad-command", "FreeCAD command", "fail", True, "missing", "install it")
        with patch.dict("os.environ", {"HOME": str(self.home)}, clear=True), \
                patch.object(setup.preflight, "_timed_freecad_checks", return_value=[failed]), \
                patch.object(setup.preflight, "run_checks") as run_checks, \
                redirect_stdout(io.StringIO()):
            status = setup.main(["--yes"])
        self.assertNotEqual(status, 0)
        run_checks.assert_not_called()

    def test_nonpassing_cad_check_prevents_all_other_setup_work(self) -> None:
        bad_templates = setup.preflight.Check(
            "techdraw-templates", "TechDraw templates", "fail", True, "missing templates", "install FreeCAD")
        with patch.dict("os.environ", {"HOME": str(self.home)}, clear=True), \
                patch.object(setup.preflight, "_timed_freecad_checks", return_value=[bad_templates]), \
                patch.object(setup.preflight, "run_checks") as run_checks, \
                patch.object(setup, "plan") as plan, redirect_stdout(io.StringIO()):
            status = setup.main(["--yes"])
        self.assertNotEqual(status, 0)
        run_checks.assert_not_called()
        plan.assert_not_called()


    def test_wrong_version_or_missing_templates_fail_before_setup(self) -> None:
        bad_version = setup.preflight.Check("freecad-version", "FreeCAD version", "fail", True,
                                            "FreeCAD 1.2.0", "Install FreeCAD 1.1.4")
        with patch.dict("os.environ", {"HOME": str(self.home)}, clear=True), \
                patch.object(setup.preflight, "_timed_freecad_checks", return_value=[
                    setup.preflight.Check("freecad-command", "FreeCAD command", "pass", True, "present", ""),
                    bad_version,
                ]), patch.object(setup.preflight, "run_checks") as run_checks, \
                patch.object(setup, "plan") as plan, redirect_stdout(io.StringIO()):
            status = setup.main([])
        self.assertNotEqual(status, 0)
        run_checks.assert_not_called()
        plan.assert_not_called()


if __name__ == "__main__":
    unittest.main()
