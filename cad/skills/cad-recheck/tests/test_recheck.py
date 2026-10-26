#!/usr/bin/env python3
"""Integration tests for the staged CAD recheck stamp and git hook."""

from __future__ import annotations

import hashlib
import json
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
        self.git("init", "-q")
        self.git("config", "user.name", "CAD Recheck Test")
        self.git("config", "user.email", "cad-recheck@example.invalid")
        self.write_product("specify", "layout")
        (self.root / "hw" / "parts").mkdir(parents=True)
        (self.root / "hw" / "parts" / "part.txt").write_text("dimension=10\n", encoding="utf-8")
        self.git("add", "hw")
        self.git("commit", "-qm", "initial design")
        installed = self.run_python(INSTALLER, "--project", str(self.root))
        self.assertEqual(installed.returncode, 0, installed.stderr)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def git(self, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", *args], cwd=self.root, text=True, capture_output=True, check=check
        )

    @staticmethod
    def run_python(script: Path, *args: str, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(script), *args],
            cwd=cwd,
            text=True,
            capture_output=True,
            check=False,
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

    def test_before_threshold_commits_without_stamp(self) -> None:
        self.stage_product("specify", threshold="")
        self.git("add", "hw")
        result = self.commit()
        self.assertEqual(result.returncode, 0, result.stderr)

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
