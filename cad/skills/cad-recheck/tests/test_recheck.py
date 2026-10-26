#!/usr/bin/env python3
"""Integration tests for the staged CAD recheck stamp and git hook."""

from __future__ import annotations

import os
import json
import hashlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SKILL = Path(__file__).resolve().parents[1]
STAMP = SKILL / "scripts" / "stamp.py"
INSTALLER = SKILL / "scripts" / "install-hook.py"


class RecheckHookTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "project"
        self.root.mkdir()
        self.git("-c", "init.templateDir=", "init", "-q")
        self.git("config", "user.name", "CAD Recheck Test")
        self.git("config", "user.email", "cad-recheck@example.invalid")
        self.write_product("specify", "layout")
        (self.root / "hw" / "parts").mkdir(parents=True)
        (self.root / "hw" / "parts" / "part.txt").write_text("dimension=10\n", encoding="utf-8")
        self.git("add", "hw")
        self.git("commit", "-qm", "initial design")
        hooks_dir = self.root / ".git" / "hooks"
        if hooks_dir.is_dir():
            for hook in hooks_dir.iterdir():
                if not hook.name.endswith(".sample"):
                    hook.unlink()
        installed = self.install_hook()
        self.assertEqual(installed.returncode, 0, installed.stderr)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def git(self, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["GIT_CONFIG_NOSYSTEM"] = "1"
        env["GIT_CONFIG_GLOBAL"] = os.devnull
        return subprocess.run(
            ["git", *args], cwd=self.root, text=True, capture_output=True, check=check, env=env
        )

    @staticmethod
    def run_python(script: Path, *args: str, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["GIT_CONFIG_NOSYSTEM"] = "1"
        env["GIT_CONFIG_GLOBAL"] = os.devnull
        return subprocess.run(
            [sys.executable, str(script), *args],
            cwd=cwd,
            text=True,
            capture_output=True,
            check=False,
            env=env,
        )

    def write_product(self, stage: str, threshold: str) -> None:
        product = self.root / "hw" / "product.yaml"
        product.parent.mkdir(parents=True, exist_ok=True)
        product.write_text(
            f"id: test-project\nflow:\n  stage: {stage}\n  recheck_from: {threshold}\n" if threshold else f"id: test-project\nflow:\n  stage: {stage}\n",
            encoding="utf-8",
        )

    def stage_product(self, stage: str, threshold: str = "layout") -> None:
        self.write_product(stage, threshold)
        self.git("add", "hw/product.yaml")

    def install_hook(self, *args: str) -> subprocess.CompletedProcess[str]:
        return self.run_python(INSTALLER, "--project", str(self.root), *args)

    def commit(self) -> subprocess.CompletedProcess[str]:
        return self.git("commit", "-m", "design batch", check=False)

    def stamp(self, *, passed: bool, stage: str) -> dict[str, object]:
        checks = self.root / ".checks.json"
        checks.write_text(json.dumps({"all_passed": passed, "checks": []}), encoding="utf-8")
        args = ["--stage", stage, "--checks", str(checks)]
        if passed:
            args.append("--passed")
        result = self.run_python(STAMP, *args, cwd=self.root)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.git("add", "hw/.cad/recheck.json")
        return json.loads(result.stdout)

    def test_staged_release_requires_stamp_even_when_worktree_is_below_threshold(self) -> None:
        self.write_product("release", "layout")
        self.git("add", "hw/product.yaml")
        self.write_product("specify", "layout")
        result = self.commit()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no staged hw/.cad/recheck.json", result.stderr)

    def test_staged_pre_threshold_does_not_require_stamp_even_when_worktree_is_at_threshold(self) -> None:
        self.write_product("specify", "layout")
        self.git("add", "hw/product.yaml")
        self.write_product("release", "layout")
        part = self.root / "hw" / "parts" / "part.txt"
        part.write_text("dimension=11\n", encoding="utf-8")
        self.git("add", "hw/parts/part.txt")
        result = self.commit()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_missing_recheck_threshold_is_refused(self) -> None:
        product = self.root / "hw" / "product.yaml"
        product.write_text("id: test-project\nflow:\n  stage: release\n", encoding="utf-8")
        self.git("add", "hw/product.yaml")
        result = self.commit()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing or unknown flow.recheck_from", result.stderr)

    def test_unparsable_staged_product_is_refused(self) -> None:
        product = self.root / "hw" / "product.yaml"
        product.write_text("id: test-project\nflow: [\n", encoding="utf-8")
        self.git("add", "hw/product.yaml")
        result = self.commit()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("cannot parse staged hw/product.yaml", result.stderr)

    def test_existing_hooks_path_is_refused_without_force(self) -> None:
        self.git("config", "core.hooksPath", ".husky")
        before = self.git("config", "--local", "--get", "core.hooksPath").stdout
        result = self.install_hook()
        self.assertEqual(result.returncode, 2)
        self.assertIn("core.hooksPath is set elsewhere", result.stderr)
        self.assertEqual(self.git("config", "--local", "--get", "core.hooksPath").stdout, before)

    def test_existing_hooks_path_is_replaced_with_force(self) -> None:
        self.git("config", "core.hooksPath", ".husky")
        result = self.install_hook("--force")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git("config", "--get", "core.hooksPath").stdout.strip(), ".githooks")

    def test_existing_git_hook_is_refused_without_force(self) -> None:
        hooks_path = self.git("rev-parse", "--git-path", "hooks").stdout.strip()
        hooks_dir = self.root / hooks_path
        hook = hooks_dir / "pre-commit"
        hook.parent.mkdir(parents=True, exist_ok=True)
        hook.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        result = self.install_hook()
        self.assertEqual(result.returncode, 2)
        self.assertIn("existing non-sample hooks", result.stderr)
        self.assertEqual(self.git("config", "--local", "--get", "core.hooksPath").stdout.strip(), ".githooks")

    def test_existing_git_hook_is_ignored_with_force(self) -> None:
        hooks_path = self.git("rev-parse", "--git-path", "hooks").stdout.strip()
        hooks_dir = self.root / hooks_path
        hook = hooks_dir / "pre-commit"
        hook.parent.mkdir(parents=True, exist_ok=True)
        hook.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        result = self.install_hook("--force")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git("config", "--get", "core.hooksPath").stdout.strip(), ".githooks")


    def test_at_or_after_threshold_refuses_missing_stamp(self) -> None:
        self.stage_product("layout")
        self.git("add", "hw/product.yaml")
        result = self.commit()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no staged hw/.cad/recheck.json", result.stderr)
        self.assertIn("uv run --script", result.stderr)

    def test_matching_passing_stamp_is_accepted(self) -> None:
        self.stage_product("detail")
        stamp = self.stamp(passed=True, stage="detail")
        self.assertTrue(stamp["passed"])
        self.assertEqual(stamp["tree_hash"], self.staged_hash())
        result = self.commit()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_editing_staged_file_makes_stamp_stale(self) -> None:
        self.stage_product("detail")
        self.stamp(passed=True, stage="detail")
        part = self.root / "hw" / "parts" / "part.txt"
        part.write_text("dimension=12\n", encoding="utf-8")
        self.git("add", "hw/parts/part.txt")
        result = self.commit()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("stamp is stale", result.stderr)

    def test_passed_false_is_refused(self) -> None:
        self.stage_product("detail")
        stamp = self.stamp(passed=False, stage="detail")
        self.assertFalse(stamp["passed"])
        self.assertEqual(stamp["tree_hash"], self.staged_hash())
        result = self.commit()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not say passed: true", result.stderr)

    def staged_hash(self) -> str:
        entries = subprocess.run(
            ["git", "ls-files", "-s", "--", "hw/"],
            cwd=self.root,
            capture_output=True,
            check=True,
        ).stdout.splitlines(keepends=True)
        digest = hashlib.sha256()
        for entry in entries:
            _, separator, path = entry.partition(b"\t")
            if separator and not path.startswith(b"hw/.cad/"):
                digest.update(entry)
        return digest.hexdigest()


if __name__ == "__main__":
    unittest.main()
