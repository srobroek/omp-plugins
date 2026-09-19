#!/usr/bin/env python3
"""Contract tests for the pinned slopvac prose gate."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
GATE = HERE / "prose-gate.py"


class ProseGateChecks(unittest.TestCase):
    def run_gate(
        self, path: Path, *, env: dict[str, str] | None = None
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(GATE), str(path), "--profile", "normal", "--format", "json"],
            cwd=path.parent,
            env=env,
            text=True,
            capture_output=True,
            timeout=120,
            check=False,
        )

    def test_version_mismatch_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="prose-version-") as directory:
            path = Path(directory) / "clean.md"
            path.write_text("# Install\n", encoding="utf-8")
            code = (
                "import importlib.metadata, runpy, sys; "
                "importlib.metadata.version = lambda _: '1.0.1'; "
                "runpy.run_path(sys.argv[1], run_name='__main__')"
            )
            result = subprocess.run(
                [sys.executable, "-c", code, str(GATE), str(path)],
                text=True,
                capture_output=True,
                timeout=120,
                check=False,
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("slopvac==2.3.2", result.stderr)

    def test_emoji_heading_is_flagged_by_real_engine(self) -> None:
        with tempfile.TemporaryDirectory(prefix="prose-emoji-") as directory:
            path = Path(directory) / "emoji.md"
            path.write_text("# Reference\n\n## 🚀 Install\n", encoding="utf-8")
            result = self.run_gate(path)
        self.assertEqual(result.returncode, 1, (result.stdout, result.stderr))
        report = json.loads(result.stdout)
        findings = [finding for document in report["documents"] for finding in document["findings"]]
        self.assertTrue(
            any(
                finding["rule_id"] == "prose-format.emoji-heading"
                and "🚀" in finding["matched_text"]
                for finding in findings
            ),
            findings,
        )

    def test_clean_ascii_text_passes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="prose-clean-") as directory:
            path = Path(directory) / "clean.md"
            path.write_text("# Reference\n\n## Install\n", encoding="utf-8")
            result = self.run_gate(path)
        self.assertEqual(result.returncode, 0, (result.stdout, result.stderr))
        report = json.loads(result.stdout)
        self.assertEqual(report["documents"][0]["findings"], [])
        self.assertEqual(report["documents"][0]["unchecked"], [])

    def test_missing_vale_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="prose-no-vale-") as directory:
            root = Path(directory)
            path = root / "clean.md"
            path.write_text("# Install\n", encoding="utf-8")
            env = os.environ.copy()
            env["PATH"] = str(root / "empty-bin")
            result = self.run_gate(path, env=env)
        self.assertNotEqual(result.returncode, 0, (result.stdout, result.stderr))


if __name__ == "__main__":
    unittest.main()
