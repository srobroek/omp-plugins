#!/usr/bin/env python3
"""Regression tests for CAD harness output generation."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

CAD = Path(__file__).resolve().parents[1]


class HarnessGeneratorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="cad-harness-test-")
        self.addCleanup(self.temporary.cleanup)
        self.cad = Path(self.temporary.name) / "cad"
        shutil.copytree(CAD, self.cad)
        self.generator = self.cad / "harness" / "generate.py"

    def run_generator(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(self.generator), *args],
            cwd=self.cad,
            capture_output=True,
            text=True,
            timeout=30,
        )

    def generate(self) -> None:
        result = self.run_generator()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_check_accepts_generated_files_and_rejects_modified_output(self) -> None:
        self.generate()
        current = self.run_generator("--check")
        self.assertEqual(current.returncode, 0, current.stdout + current.stderr)
        self.assertIn("PASS: 6 harness agents current and read-only", current.stdout)

        target = self.cad / "harness" / "claude" / "agents" / "cad-mech-reviewer.md"
        target.chmod(0o644)
        target.write_text(target.read_text(encoding="utf-8") + "\nmanual drift\n", encoding="utf-8")
        stale = self.run_generator("--check")
        self.assertNotEqual(stale.returncode, 0, stale.stdout)
        self.assertIn("stale harness/claude/agents/cad-mech-reviewer.md", stale.stderr)
        target.chmod(0o444)
        target.chmod(0o644)
        writable = self.run_generator("--check")
        self.assertNotEqual(writable.returncode, 0, writable.stdout)
        self.assertIn("writable generated file harness/claude/agents/cad-mech-reviewer.md", writable.stderr)
    def test_harness_formats_expose_only_read_capabilities(self) -> None:
        self.generate()
        for name in ("cad-mech-reviewer", "cad-dfm-reviewer"):
            with self.subTest(agent=name):
                kiro = json.loads((self.cad / "harness" / "kiro" / "agents" / f"{name}.json").read_text(encoding="utf-8"))
                self.assertEqual(set(kiro), {"name", "description", "prompt", "tools", "permissions", "resources"})
                self.assertEqual(kiro["tools"], ["read"])
                skill = "cad-review-mech" if name == "cad-mech-reviewer" else "cad-review-dfm"
                self.assertEqual(kiro["resources"], [f"skill://cad/skills/{skill}/SKILL.md"])
                rules = kiro["permissions"]["rules"]
                self.assertIn({"capability": "fs_write", "match": ["**/*"], "effect": "deny"}, rules)
                self.assertIn({"capability": "shell", "match": ["*"], "effect": "deny"}, rules)
                claude = (self.cad / "harness" / "claude" / "agents" / f"{name}.md").read_text(encoding="utf-8")
                self.assertIn("tools: Read, Grep, Glob", claude)
                self.assertIn(f"skills: [{skill}]", claude)
                self.assertIn("model: inherit", claude)
                opencode = (self.cad / "harness" / "opencode" / "agents" / f"{name}.md").read_text(encoding="utf-8")
                self.assertIn("mode: subagent", opencode)
                self.assertIn("'*': deny", opencode)
                self.assertIn("edit: deny", opencode)
                self.assertIn("bash: deny", opencode)

    def test_every_generated_agent_has_read_only_permissions(self) -> None:
        self.generate()
        files = sorted((self.cad / "harness").glob("*/agents/*"))
        self.assertEqual(len(files), 6)
        for path in files:
            with self.subTest(path=path.relative_to(self.cad)):
                self.assertEqual(path.stat().st_mode & 0o222, 0, f"{path} is writable")
                text = path.read_text(encoding="utf-8")
                if path.suffix == ".json":
                    self.assertIn('"fs_write"', text)
                    self.assertIn('"shell"', text)
                    self.assertIn('"deny"', text)
                elif "opencode" in path.parts:
                    self.assertIn("edit: deny", text)
                    self.assertIn("bash: deny", text)
                else:
                    self.assertIn("tools: Read, Grep, Glob", text)


if __name__ == "__main__":
    unittest.main()

