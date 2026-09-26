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
