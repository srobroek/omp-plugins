#!/usr/bin/env python3
"""Focused tests for setup planning, idempotence, and system-install consent."""

from __future__ import annotations

import importlib.util
import io
import os
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
                warm = [item for item in items if item.id == f"warm-{identifier}"]
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

    def test_freecad_resolution_prefers_configured_path_then_path_then_user_link_then_bundle(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            executable = home / "configured"
            executable.write_text("configured")
            executable.chmod(0o755)
            bin_dir = home / ".local" / "bin"
            bin_dir.mkdir(parents=True)
            user_executable = bin_dir / "freecadcmd"
            user_executable.write_text("user")
            user_executable.chmod(0o755)
            managed = home / "opt" / "freecad-1.1.4" / "squashfs-root" / "usr" / "bin" / "freecadcmd"
            managed.parent.mkdir(parents=True)
            managed.write_text("managed")
            managed.chmod(0o755)
            resolver = setup.preflight.find_freecadcmd
            self.assertEqual(resolver({"FREECADCMD": str(executable), "HOME": str(home)}, home), executable)
            with patch.object(setup.preflight.shutil, "which", return_value="/path/freecadcmd"):
                self.assertEqual(resolver({"PATH": "/path", "HOME": str(home)}, home), Path("/path/freecadcmd"))
            self.assertEqual(resolver({"HOME": str(home)}, home), user_executable)
            user_executable.unlink()
            self.assertEqual(resolver({"HOME": str(home)}, home), managed)

    def test_preflight_resolves_setup_install_without_path_changes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            command = home / "opt" / "freecad-1.1.4" / "squashfs-root" / "usr" / "bin" / "freecadcmd"
            command.parent.mkdir(parents=True)
            command.write_text("#!/bin/sh\necho 'FreeCAD 1.1.4'\n", encoding="utf-8")
            command.chmod(0o755)
            with patch.object(setup.preflight.shutil, "which", return_value=None):
                resolved = setup.preflight.find_freecadcmd({"HOME": str(home), "PATH": ""}, home)
            self.assertEqual(resolved, command)


    def test_linux_browser_deps_plan_only_for_failing_chromium(self) -> None:
        failing = report("playwright-chromium")
        with patch.object(setup.platform, "system", return_value="Linux"), \
                patch.object(setup, "_release_info", return_value={"ID": "ubuntu"}):
            failed_plan = setup.plan(failing, self.root, self.home, self.env)
            passed_plan = setup.plan(report(), self.root, self.home, self.env)
        self.assertIn("browser-libraries-manual", [item.id for item in failed_plan])
        self.assertNotIn("browser-libraries-manual", [item.id for item in passed_plan])

    def test_unsupported_linux_lists_missing_browser_libraries_without_system_install(self) -> None:
        check = setup.preflight.Check("playwright-chromium", "Playwright Chromium", "fail", True,
                                      "error: libfoo.so.1: cannot open shared object file", "retry")
        failing = setup.preflight.Report((check,))
        with patch.object(setup.platform, "system", return_value="Linux"), \
                patch.object(setup, "_release_info", return_value={"ID": "amzn"}):
            items = setup.plan(failing, self.root, self.home, self.env)
        browser = next(item for item in items if item.id == "browser-libraries-manual")
        self.assertIn("Debian/Ubuntu only", browser.command)
        self.assertIn("libfoo.so.1", browser.command)
        self.assertFalse(browser.system)


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


class FreeCADInstallTests(unittest.TestCase):
    def test_appimage_copy_preserves_internal_symlinks_for_app_run(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            extracted = root / "squashfs-root"
            usr = extracted / "usr"
            executable = usr / "bin" / "freecadcmd"
            executable.parent.mkdir(parents=True)
            executable.write_text("#!/bin/sh\n", encoding="utf-8")
            target = usr / "x86_64-conda-linux-gnu" / "bin" / "ld"
            target.parent.mkdir(parents=True)
            target.write_text("link target\n", encoding="utf-8")
            (usr / "compiler_compat").mkdir()
            (usr / "compiler_compat" / "ld").symlink_to(target)
            copied = root / "copy"
            setup.shutil.copytree(extracted, copied, symlinks=True)
            copied_link = copied / "usr" / "compiler_compat" / "ld"
            self.assertTrue(copied_link.is_symlink())
            self.assertEqual(os.readlink(copied_link), os.readlink(extracted / "usr" / "compiler_compat" / "ld"))
            self.assertTrue((copied / "usr" / "bin" / "freecadcmd").is_file())



class TransactionalFreeCADTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        self.prefix = self.home / "opt" / "freecad-1.1.4"
        self.command = self.home / ".local" / "bin" / "freecadcmd"
        self.prefix.mkdir(parents=True)
        old_command = self.prefix / "squashfs-root" / "usr" / "bin" / "freecadcmd"
        old_command.parent.mkdir(parents=True)
        old_command.write_text("old valid command\n", encoding="utf-8")
        self.command.parent.mkdir(parents=True)
        self.command.symlink_to(old_command)
        self.archive = self.home / "FreeCAD.AppImage"
        self.archive.write_text("verified archive\n", encoding="utf-8")
        self.env = {"HOME": str(self.home)}
        self.keep = setup.platform.system, setup.platform.machine
        setup.platform.system = lambda: "Linux"
        setup.platform.machine = lambda: "x86_64"
        self.addCleanup(setattr, setup.platform, "system", self.keep[0])
        self.addCleanup(setattr, setup.platform, "machine", self.keep[1])
        self.run = patch.object(setup, "_run")
        self.run.start()
        self.addCleanup(self.run.stop)
        self.download = patch.object(setup, "_download")
        self.download.start()
        self.addCleanup(self.download.stop)
        self.digest = patch.object(setup, "_sha256", return_value=setup.FREECAD_ASSETS[("Linux", "x86_64")][1])
        self.digest.start()
        self.addCleanup(self.digest.stop)

    def prepare(self, archive: Path, staging: Path) -> Path:
        command = staging / "squashfs-root" / "usr" / "bin" / "freecadcmd"
        command.parent.mkdir(parents=True)
        command.write_text("#!/bin/sh\necho 'FreeCAD 1.1.4 test'\n", encoding="utf-8")
        command.chmod(0o755)
        target = staging / "squashfs-root" / "usr" / "x86_64-conda-linux-gnu" / "bin" / "ld"
        target.parent.mkdir(parents=True)
        target.write_text("ld\n", encoding="utf-8")
        (staging / "squashfs-root" / "usr" / "compiler_compat").mkdir()
        (staging / "squashfs-root" / "usr" / "compiler_compat" / "ld").symlink_to(
            "../x86_64-conda-linux-gnu/bin/ld")
        return command

    def assert_old_install(self) -> None:
        self.assertEqual((self.prefix / "squashfs-root" / "usr" / "bin" / "freecadcmd").read_text(),
                         "old valid command\n")
        self.assertEqual(os.readlink(self.command), str(self.prefix / "squashfs-root" / "usr" / "bin" / "freecadcmd"))

    def test_staged_verification_failure_keeps_old_bundle_and_link(self) -> None:
        with patch.object(setup, "_stage_freecad_appimage", side_effect=self.prepare), \
                patch.object(setup, "_verify_freecadcmd", side_effect=RuntimeError("staged version failed")):
            with self.assertRaisesRegex(RuntimeError, "staged version failed"):
                setup._install_freecad(self.env)
        self.assert_old_install()

    def test_swap_failure_rolls_back_old_bundle_and_link(self) -> None:
        replace = setup._replace_path
        calls = 0

        def fail_new_swap(source: Path, destination: Path) -> None:
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("injected staging swap failure")
            replace(source, destination)

        with patch.object(setup, "_stage_freecad_appimage", side_effect=self.prepare), \
                patch.object(setup, "_verify_freecadcmd"), \
                patch.object(setup, "_replace_path", side_effect=fail_new_swap):
            with self.assertRaisesRegex(OSError, "staging swap failure"):
                setup._install_freecad(self.env)
        self.assert_old_install()

    def test_link_verification_failure_rolls_back_old_bundle_and_link(self) -> None:
        def verify(command: Path, environ: Mapping[str, str]) -> None:
            if command == self.command:
                raise RuntimeError("installed link verification failed")

        with patch.object(setup, "_stage_freecad_appimage", side_effect=self.prepare), \
                patch.object(setup, "_verify_freecadcmd", side_effect=verify):
            with self.assertRaisesRegex(RuntimeError, "installed link verification failed"):
                setup._install_freecad(self.env)
        self.assert_old_install()

    def test_corrupt_staged_binary_does_not_replace_previous_bundle(self) -> None:
        def corrupt(archive: Path, staging: Path) -> Path:
            command = self.prepare(archive, staging)
            command.write_text("not an executable\n", encoding="utf-8")
            return command

        with patch.object(setup, "_stage_freecad_appimage", side_effect=corrupt):
            with self.assertRaises(RuntimeError):
                setup._install_freecad(self.env)
        self.assert_old_install()

    def test_success_installs_and_verifies_link_before_removing_backup(self) -> None:
        events = []
        verify = setup._verify_freecadcmd

        def record_verification(command: Path, environ: Mapping[str, str]) -> None:
            events.append(("verify", command))
            verify(command, environ)

        def record_remove(path: Path, **kwargs) -> None:
            if Path(path).name.startswith(".freecad-1.1.4.previous"):
                events.append(("remove-backup", Path(path)))

        with patch.object(setup, "_stage_freecad_appimage", side_effect=self.prepare), \
                patch.object(setup, "_verify_freecadcmd", side_effect=record_verification), \
                patch.object(setup.shutil, "rmtree", side_effect=record_remove):
            setup._install_freecad(self.env)
        self.assertTrue(events[0][0] == "verify" and events[0][1].name == "freecadcmd")
        self.assertEqual(events[1], ("verify", self.command))
        self.assertEqual((self.prefix / "squashfs-root" / "usr" / "bin" / "freecadcmd").read_text(),
                         "#!/bin/sh\necho 'FreeCAD 1.1.4 test'\n")

if __name__ == "__main__":
    unittest.main()