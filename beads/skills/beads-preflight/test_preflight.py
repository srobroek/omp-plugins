#!/usr/bin/env python3
"""Focused regression tests for the Beads preflight helpers."""

from __future__ import annotations

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("preflight.py")
SPEC = importlib.util.spec_from_file_location("beads_preflight", MODULE_PATH)
assert SPEC and SPEC.loader
preflight = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preflight)


class BeadsPreflightRegressionTests(unittest.TestCase):
    def test_invalid_utf8_command_output_is_replaced(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            stub = Path(directory) / "bd"
            stub.write_text("#!/usr/bin/env python3\nimport os; os.write(1, b'\\xff\\xfe')", encoding="utf-8")
            stub.chmod(0o700)
            with patch.dict(os.environ, {"PATH": f"{directory}{os.pathsep}{os.environ.get('PATH', '')}"}):
                result = preflight.run_bd(["--version"], timeout_seconds=1)
        self.assertEqual(result.returncode, 0)
        self.assertIn("\ufffd", result.stdout)

    def test_missing_database_uses_bootstrap_when_origin_has_dolt_data(self) -> None:
        info = preflight.CommandResult(1, "", "no beads database found", command=("bd", "info", "--json"))
        origin = preflight.CommandResult(
            0,
            "abc123\trefs/dolt/data\n",
            "",
            command=("git", "ls-remote", "origin", "refs/dolt/data"),
        )
        with patch.object(preflight, "run_bd", return_value=info), patch.object(preflight, "run_git", return_value=origin):
            result = preflight.check_store_reachable({"timeout_seconds": 1})
        self.assertEqual(result["fix"], "bd bootstrap --yes")
        self.assertIn("rule://beads-setup", result["detail"])

    def test_missing_database_uses_init_when_origin_has_no_dolt_data(self) -> None:
        info = preflight.CommandResult(1, "", "no beads database found", command=("bd", "info", "--json"))
        origin = preflight.CommandResult(2, "", "fatal: No such remote 'origin'", command=("git", "ls-remote", "origin", "refs/dolt/data"))
        with patch.object(preflight, "run_bd", return_value=info), patch.object(preflight, "run_git", return_value=origin):
            result = preflight.check_store_reachable({"timeout_seconds": 1})
        self.assertEqual(result["fix"], "bd init --init-if-missing --skip-hooks --skip-agents")
        self.assertIn("confirm the git origin first", result["detail"])
        self.assertIn("rule://beads-setup", result["detail"])

    def test_missing_database_ready_failure_points_to_store_remedy(self) -> None:
        command = preflight.CommandResult(1, "", "no beads database found", command=("bd", "ready", "--json"))
        with patch.object(preflight, "run_bd", return_value=command):
            result = preflight.check_ready_work({"timeout_seconds": 1})
        self.assertNotEqual(result["fix"], "bd ready --json")
        self.assertIn("store-reachable", result["fix"])

    def test_no_remote_warns_with_add_remedy(self) -> None:
        command = preflight.CommandResult(0, "No remotes configured.\n", "")
        with patch.object(preflight, "run_bd", return_value=command):
            result = preflight.check_remote_sync({"timeout_seconds": 1})
        self.assertEqual(result["status"], "warn")
        self.assertEqual(result["fix"], "bd dolt remote add origin git+ssh://git@github.com/OWNER/REPO.git")
        self.assertIn("bd dolt push exits 0 without pushing", result["detail"])

    def test_git_ssh_remote_passes(self) -> None:
        command = preflight.CommandResult(0, "origin git+ssh://git@github.com/srobroek/omp-plugins.git\n", "")
        with patch.object(preflight, "run_bd", return_value=command):
            result = preflight.check_remote_sync({"timeout_seconds": 1})
        self.assertEqual(result["status"], "pass")

    def test_multiple_valid_remotes_pass(self) -> None:
        command = preflight.CommandResult(
            0,
            "origin git+ssh://git@github.com/srobroek/omp-plugins.git\nbackup git+https://example.test/ledger.git\n",
            "",
        )
        with patch.object(preflight, "run_bd", return_value=command):
            result = preflight.check_remote_sync({"timeout_seconds": 1})
        self.assertEqual(result["status"], "pass")

    def test_garbage_remote_line_skips(self) -> None:
        command = preflight.CommandResult(0, "this is garbage\n", "")
        with patch.object(preflight, "run_bd", return_value=command):
            result = preflight.check_remote_sync({"timeout_seconds": 1})
        self.assertEqual(result["status"], "skip")

    def test_non_text_ready_output_fails_without_traceback(self) -> None:
        command = preflight.CommandResult(0, {"ready": True}, "", command=("bd", "ready", "--json"))  # type: ignore[arg-type]
        with patch.object(preflight, "run_bd", return_value=command):
            result = preflight.check_ready_work({"timeout_seconds": 1})
        self.assertEqual(result["status"], "fail")
        self.assertIn("unparseable JSON", result["detail"])

    def test_non_text_error_output_is_bounded(self) -> None:
        command = preflight.CommandResult(1, {"stdout": True}, ["stderr"], command=("bd", "ready", "--json"))  # type: ignore[arg-type]
        with patch.object(preflight, "run_bd", return_value=command):
            result = preflight.check_ready_work({"timeout_seconds": 1})
        self.assertEqual(result["status"], "fail")
        self.assertIn("command exited 1", result["detail"])

    def test_arbitrary_successful_remote_output_does_not_pass(self) -> None:
        command = preflight.CommandResult(0, "NOT A DOLT REMOTE LIST", "")
        with patch.object(preflight, "run_bd", return_value=command):
            result = preflight.check_remote_sync({"timeout_seconds": 1})
        self.assertNotEqual(result["status"], "pass")

    def test_successful_version_without_semantic_version_fails(self) -> None:
        command = preflight.CommandResult(0, "bd development build", "")
        with patch.object(preflight.shutil, "which", return_value="/usr/bin/bd"), patch.object(
            preflight, "run_bd", return_value=command
        ):
            result = preflight.check_bd_available({"timeout_seconds": 1})
        self.assertEqual(result["status"], "fail")
        self.assertIn("parseable semantic version", result["detail"])


if __name__ == "__main__":
    unittest.main()
