#!/usr/bin/env python3
"""Focused tests for setup planning, idempotence, and system-install consent."""

from __future__ import annotations

import importlib.util
import io
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "setup.py"
spec = importlib.util.spec_from_file_location("cad_setup", SCRIPT)
assert spec is not None and spec.loader is not None
setup = importlib.util.module_from_spec(spec)
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

    def test_each_runtime_failure_uses_the_existing_warm_step(self) -> None:
        for identifier in setup.WARM_IDS:
            with self.subTest(check=identifier):
                items = setup.plan(report(identifier), self.root, self.home, self.env)
                warm = [item for item in items if item.id == "warm"]
                self.assertEqual(len(warm), 1)
                self.assertIn(identifier, warm[0].command)

    def test_uv_and_freecad_failures_get_distinct_actions(self) -> None:
        items = setup.plan(report("uv", "freecad-version"), self.root, self.home, self.env)
        self.assertEqual([item.id for item in items], ["uv", "freecad"])
        self.assertTrue(items[0].system)
        self.assertTrue(items[1].system)
        self.assertIn("https://astral.sh/uv/install.sh", items[0].command)
        self.assertIn("SHA-256", items[1].command)

    def test_formula_copy_is_idempotent(self) -> None:
        beads = self.root / ".beads"
        beads.mkdir()
        env = {**self.env, "BEADS_DIR": str(beads)}
        initial = setup.plan(report(), self.root, self.home, env)
        self.assertEqual([item.id for item in initial], ["formulas"])
        setup._copy_formulas(self.root, env)
        self.assertEqual(setup.plan(report(), self.root, self.home, env), [])
        self.assertEqual({path.name for path in (beads / "formulas").glob("*.formula.toml")},
                         {path.name for path in setup.FORMULAS.glob("*.formula.toml")})

    def test_requested_harness_is_planned_but_not_implicit(self) -> None:
        with patch.object(setup, "_harness_needed", return_value=True):
            implicit = setup.plan(report(), self.root, self.home, self.env)
            requested = setup.plan(report(), self.root, self.home, self.env, "opencode")
        self.assertFalse(any(item.id.startswith("harness-") for item in implicit))
        self.assertIn("harness-opencode", [item.id for item in requested])


class ConsentTests(unittest.TestCase):
    def test_system_installs_are_not_run_without_system_consent(self) -> None:
        failing = report("freecad-command", "playwright-chromium")
        with patch.object(setup.preflight, "run_checks", side_effect=(failing, failing)), \
                patch.object(setup.preflight, "warm", return_value=failing), \
                patch.object(setup.shutil, "which", return_value="/usr/bin/uv"), \
                patch.object(setup, "_install_freecad") as install_freecad, \
                patch.object(setup.preflight, "install_chromium_system_deps") as install_browser_deps, \
                redirect_stdout(io.StringIO()):
            status = setup.main(["--yes"])
        self.assertEqual(status, 1)
        install_freecad.assert_not_called()
        install_browser_deps.assert_not_called()

    def test_dry_run_never_invokes_any_install_action(self) -> None:
        failing = report("freecad-command", "playwright-chromium")
        with patch.object(setup.preflight, "run_checks", side_effect=(failing,)), \
                patch.object(setup.shutil, "which", return_value="/usr/bin/uv"), \
                patch.object(setup, "_install_freecad") as install_freecad, \
                patch.object(setup.preflight, "install_chromium_system_deps") as install_browser_deps, \
                redirect_stdout(io.StringIO()):
            status = setup.main([])
        self.assertEqual(status, 0)
        install_freecad.assert_not_called()
        install_browser_deps.assert_not_called()

    def test_uv_requires_system_consent_even_with_yes(self) -> None:
        failing = report("uv")
        with patch.object(setup.preflight, "run_checks", side_effect=(failing, failing)), \
                patch.object(setup, "_install_uv") as install_uv, \
                patch.object(setup.shutil, "which", return_value=None), \
                redirect_stdout(io.StringIO()):
            status = setup.main(["--yes"])
        self.assertEqual(status, 1)
        install_uv.assert_not_called()

    def test_system_flag_requires_yes(self) -> None:
        with self.assertRaises(SystemExit) as raised:
            setup.main(["--system"])
        self.assertEqual(raised.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
