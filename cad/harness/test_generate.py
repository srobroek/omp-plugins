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
REVIEWERS = ("cad-mech-reviewer", "cad-dfm-reviewer")
AGENTS = sorted(path.stem for path in (CAD / "agents").glob("*.md"))


class HarnessGeneratorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="cad-harness-test-")
        self.addCleanup(self.temporary.cleanup)
        self.cad = Path(self.temporary.name) / "cad"
        shutil.copytree(CAD, self.cad, copy_function=shutil.copyfile)
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
        self.assertIn(f"PASS: {3 * len(AGENTS) + 2} harness files current", current.stdout)
        self.assertEqual(
            (self.cad / "harness" / "opencode" / "commands" / "cad-flow.md").read_text(encoding="utf-8"),
            """---
description: Prototype-to-CAD flow (cad plugin)
---

Load the `cad-flow` skill and follow it. With arguments, apply it to $ARGUMENTS. Without arguments, resume the existing `hw/` design record, or ask what to design when there is none.
""",
        )
        command_path = self.cad / "harness" / "opencode" / "commands" / "cad-flow.md"
        command_path.write_text(command_path.read_text(encoding="utf-8") + "\nmanual drift\n", encoding="utf-8")
        stale_command = self.run_generator("--check")
        self.assertNotEqual(stale_command.returncode, 0, stale_command.stdout)
        self.assertIn("stale harness/opencode/commands/cad-flow.md", stale_command.stderr)
        command_path.unlink()
        missing_command = self.run_generator("--check")
        self.assertNotEqual(missing_command.returncode, 0, missing_command.stdout)
        self.assertIn("missing harness/opencode/commands/cad-flow.md", missing_command.stderr)
        self.generate()
        target = self.cad / "harness" / "claude" / "agents" / "cad-mech-reviewer.md"
        target.write_text(target.read_text(encoding="utf-8") + "\nmanual drift\n", encoding="utf-8")
        stale = self.run_generator("--check")
        self.assertNotEqual(stale.returncode, 0, stale.stdout)
        self.assertIn("stale harness/claude/agents/cad-mech-reviewer.md", stale.stderr)
        missing_path = self.cad / "harness" / "kiro" / "agents" / "cad-mech-reviewer.json"
        missing_path.unlink()
        missing = self.run_generator("--check")
        self.assertNotEqual(missing.returncode, 0, missing.stdout)
        self.assertIn("missing harness/kiro/agents/cad-mech-reviewer.json", missing.stderr)
        self.generate()
        leftover = self.cad / "harness" / "opencode" / "agents" / "cad-retired-agent.md"
        leftover.write_text("---\ndescription: gone\n---\n", encoding="utf-8")
        extra = self.run_generator("--check")
        self.assertNotEqual(extra.returncode, 0, extra.stdout)
        self.assertIn("unexpected harness/opencode/agents/cad-retired-agent.md", extra.stderr)
        self.generate()
        self.assertFalse(leftover.exists())

    def test_generator_rejects_unknown_tools_skills_and_names(self) -> None:
        source = self.cad / "agents" / "cad-analyst.md"
        original = source.read_text(encoding="utf-8")
        for old, new, message in (("tools: read,", "tools: telepathy, read,", "tools must be distinct names"),
                                  ("autoloadSkills: cad-motion", "autoloadSkills: cad-missing", "skills cad does not ship"),
                                  ("name: cad-analyst", "name: cad-renamed", "must match the file name")):
            with self.subTest(field=old):
                source.write_text(original.replace(old, new, 1), encoding="utf-8")
                result = self.run_generator("--check")
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn(message, result.stderr)
        source.write_text(original, encoding="utf-8")

    def test_harness_formats_expose_only_read_capabilities(self) -> None:
        self.generate()
        for name in REVIEWERS:
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
                self.assertNotIn("webfetch", opencode)

    def test_workers_write_only_the_scratch_root_and_run_only_uv(self) -> None:
        self.generate()
        for name in ("cad-part-designer", "cad-concept-designer", "cad-analyst"):
            with self.subTest(agent=name):
                kiro = json.loads((self.cad / "harness" / "kiro" / "agents" / f"{name}.json").read_text(encoding="utf-8"))
                self.assertEqual(kiro["tools"], ["read", "write", "shell"])
                rules = kiro["permissions"]["rules"]
                self.assertIn({"capability": "fs_write", "match": [".cad-work/**"], "effect": "allow"}, rules)
                self.assertIn({"capability": "shell", "match": ["uv *"], "effect": "allow"}, rules)
                self.assertIn({"capability": "subagent", "match": ["*"], "effect": "deny"}, rules)
                self.assertFalse(any(r["effect"] == "allow" and r["capability"] in {"fs_write", "shell"}
                                     and r["match"] not in ([".cad-work/**"], ["uv *"]) for r in rules))
                opencode = (self.cad / "harness" / "opencode" / "agents" / f"{name}.md").read_text(encoding="utf-8")
                self.assertIn("  edit:\n    '*': deny\n    '*.cad-work/*': allow\n", opencode)
                self.assertIn("  bash:\n    '*': deny\n    'uv *': allow\n", opencode)
                self.assertIn("  task: deny\n", opencode)
                claude = (self.cad / "harness" / "claude" / "agents" / f"{name}.md").read_text(encoding="utf-8")
                self.assertIn("tools: Read, Grep, Glob, Edit, Write, Bash\n", claude)
        part = (self.cad / "harness" / "claude" / "agents" / "cad-part-designer.md").read_text(encoding="utf-8")
        self.assertIn("skills: [cad-model, cad-design]\n", part)
        self.assertIn("scratch.py deliver", part)

    def test_sourcing_researcher_reads_and_searches_the_web_but_never_writes(self) -> None:
        self.generate()
        kiro = json.loads((self.cad / "harness" / "kiro" / "agents" / "cad-sourcing-researcher.json").read_text(encoding="utf-8"))
        self.assertEqual(kiro["tools"], ["read", "web"])
        rules = kiro["permissions"]["rules"]
        for capability in ("fs_write", "shell", "subagent"):
            self.assertEqual([r["effect"] for r in rules if r["capability"] == capability], ["deny"])
        self.assertIn({"capability": "web_search", "match": ["*"], "effect": "allow"}, rules)
        opencode = (self.cad / "harness" / "opencode" / "agents" / "cad-sourcing-researcher.md").read_text(encoding="utf-8")
        for line in ("  edit: deny\n", "  bash: deny\n", "  webfetch: allow\n", "  websearch: allow\n"):
            self.assertIn(line, opencode)
        claude = (self.cad / "harness" / "claude" / "agents" / "cad-sourcing-researcher.md").read_text(encoding="utf-8")
        self.assertIn("tools: Read, Grep, Glob, WebSearch, WebFetch\n", claude)

    def test_claude_manifest_lists_every_generated_agent(self) -> None:
        self.generate()
        manifest = json.loads((self.cad / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["agents"], [f"./harness/claude/agents/{name}.md" for name in AGENTS])



if __name__ == "__main__":
    unittest.main()

