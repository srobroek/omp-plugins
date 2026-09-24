#!/usr/bin/env python3
"""Focused regression tests for the Worktrunk preflight helpers."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("preflight.py")
SPEC = importlib.util.spec_from_file_location("worktrunk_preflight", MODULE_PATH)
assert SPEC and SPEC.loader
preflight = importlib.util.module_from_spec(SPEC)
sys.modules["worktrunk_preflight"] = preflight
SPEC.loader.exec_module(preflight)


class FakeContext:
    def __init__(
        self,
        root: Path,
        remote: str | None = None,
        ignored: tuple[str, ...] = ("node_modules",),
    ) -> None:
        self.cwd = root
        self.git_root = root
        self.git_root_error = None
        self.ignored_config_keys: list[str] = []
        self.remote = remote
        self.ignored = set(ignored)

    def require_git_root(self) -> Path:
        return self.git_root

    def run(self, *args: str, **kwargs: object) -> preflight.CommandResult:
        if args[:3] == ("git", "check-ignore", "-q"):
            return preflight.CommandResult(0 if args[3] in self.ignored else 1)
        if args == ("git", "config", "--get", "remote.origin.url"):
            return preflight.CommandResult(0, f"{self.remote or ''}\n")
        raise AssertionError(f"unexpected command: {args}")


class PreflightRegressionTests(unittest.TestCase):
    def test_empty_or_unrelated_include_warns_and_matching_include_passes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            include = root / ".worktreeinclude"
            context = FakeContext(root)

            include.write_text("# only unrelated state\n.cache/\n", encoding="utf-8")
            self.assertEqual(preflight.check_provisioning_include(context).status, "warn")

            include.write_text("node_modules/\n", encoding="utf-8")
            result = preflight.check_provisioning_include(context)
            self.assertEqual(result.status, "pass")
            self.assertIn("node_modules", result.detail)

    def test_skeleton_bun_types_warns_with_repair(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "node_modules" / "@types" / "bun").mkdir(parents=True)
            result = preflight.check_node_modules_integrity(FakeContext(root))
            self.assertEqual(result.status, "warn")
            self.assertIn("TS2688", result.detail)
            self.assertIn("bun install --frozen-lockfile", result.fix)

    def test_invalid_git_metadata_is_a_failure(self) -> None:
        class BrokenContext(FakeContext):
            def run(self, *args: str, **kwargs: object) -> preflight.CommandResult:
                return preflight.CommandResult(128, stderr="not a git repository")

        result = preflight.check_cwd_is_worktree(BrokenContext(Path.cwd()))
        self.assertEqual(result.status, "fail")
        self.assertIn("not a git repository", result.detail)

    def test_only_warn_exits_nonzero(self) -> None:
        original_checks = preflight.CHECKS
        preflight.CHECKS = [("selected", lambda _ctx: preflight.Result("warn", "needs attention"))]
        output = io.StringIO()
        try:
            with contextlib.redirect_stdout(output):
                exit_code = preflight.main(["--only", "selected", "--json"])
        finally:
            preflight.CHECKS = original_checks
        report = json.loads(output.getvalue())
        self.assertEqual(exit_code, 1)
        self.assertFalse(report["ok"])

    def test_matching_project_merge_settings_pass(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            config = home / ".config" / "worktrunk" / "config.toml"
            config.parent.mkdir(parents=True)
            config.write_text(
                '[projects."github.com/user/repo"]\nmerge.squash = false\nmerge.ff = false\n',
                encoding="utf-8",
            )
            context = FakeContext(Path(directory), "git@github.com:user/repo.git")
            with patch.object(Path, "home", return_value=home):
                result = preflight.check_merge_evidence(context)
            self.assertEqual(result.status, "pass")
            self.assertIn("github.com/user/repo", result.detail)

    def test_nonmatching_project_merge_settings_warn(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            config = home / ".config" / "worktrunk" / "config.toml"
            config.parent.mkdir(parents=True)
            config.write_text(
                '[projects."github.com/other/repo"]\nmerge.squash = false\nmerge.ff = false\n',
                encoding="utf-8",
            )
            context = FakeContext(Path(directory), "git@github.com:user/repo.git")
            with patch.object(Path, "home", return_value=home):
                result = preflight.check_merge_evidence(context)
            self.assertEqual(result.status, "warn")


if __name__ == "__main__":
    unittest.main()
