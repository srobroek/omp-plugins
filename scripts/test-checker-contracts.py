#!/usr/bin/env python3
"""Isolated CLI regressions: python3 scripts/test-checker-contracts.py."""

from __future__ import annotations

import json
import runpy
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


class CheckerContracts(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="omp-checker-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "scripts").mkdir()

    def copy_script(self, name: str) -> None:
        shutil.copy2(REPO / "scripts" / name, self.root / "scripts" / name)

    def run_script(self, name: str, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(self.root / "scripts" / name), *args],
            cwd=self.root, capture_output=True, text=True, timeout=60,
        )

    def snapshot(self) -> dict[str, bytes]:
        return {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}

    def test_missing_and_unsupported_extension_sources_fail_without_mutation(self) -> None:
        self.copy_script("build-extensions.py")
        plugin = self.root / "example"
        plugin.mkdir()
        sentinel = plugin / ".dist-check" / "unrelated"
        sentinel.parent.mkdir()
        sentinel.write_text("keep me", encoding="utf-8")
        for entry in ("./dist/missing.js", "./other/source.ts", "../extensions/source.ts", 42):
            with self.subTest(entry=entry):
                (plugin / "package.json").write_text(json.dumps({
                    "dependencies": {"example": "1.0.0"},
                    "omp": {"extensions": [entry]},
                }), encoding="utf-8")
                before = self.snapshot()
                result = self.run_script("build-extensions.py", "--check")
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn("FAIL", result.stderr)
                self.assertEqual(before, self.snapshot())

    def test_duplicate_check_rejects_drift_symlinks_and_missing_copies(self) -> None:
        """A symlinked copy reads back the canonical bytes, so bytes alone cannot judge it.

        The contract is two real copies, one per plugin, because each plugin bundles in
        isolation. A link across the boundary satisfies a byte comparison while breaking
        the contract, so it has to be rejected on file type rather than on content.
        """
        self.copy_script("check-shared-detector.py")
        # Every registered set must exist in the fixture, because the checker treats a
        # missing copy as a failure by design: a real tree that lost one has drifted.
        # Read the sets from the checker itself, so registering a new copy cannot
        # silently break this fixture.
        registered = runpy.run_path(str(REPO / "scripts" / "check-shared-detector.py"))["DUPLICATED"]
        for index, group in enumerate(registered):
            for name in group:
                path = self.root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(f"export const shared = {index};\n", encoding="utf-8")
        first = self.root / "dep-update" / "extensions" / "detect.ts"
        second = self.root / "whats-new" / "extensions" / "detect.ts"

        identical = self.run_script("check-shared-detector.py")
        self.assertEqual(identical.returncode, 0, identical.stdout)
        self.assertIn("PASS", identical.stdout)

        second.write_text("export const drifted = true;\n", encoding="utf-8")
        drifted = self.run_script("check-shared-detector.py")
        self.assertNotEqual(drifted.returncode, 0)
        self.assertIn("drifted", drifted.stdout)

        second.unlink()
        second.symlink_to(Path("..") / ".." / "dep-update" / "extensions" / "detect.ts")
        self.assertEqual(second.read_bytes(), first.read_bytes(), "premise: bytes match through the link")
        linked = self.run_script("check-shared-detector.py")
        self.assertNotEqual(linked.returncode, 0, "a symlinked copy must not pass on identical bytes")
        self.assertIn("symlinked", linked.stdout)

        second.unlink()
        absent = self.run_script("check-shared-detector.py")
        self.assertNotEqual(absent.returncode, 0)
        self.assertIn("incomplete", absent.stdout)

    def test_duplicate_check_rejects_an_unregistered_copy(self) -> None:
        """A copy nobody registered is invisible to a byte comparison of the registered ones.

        A fifth tokenizer copy that kept the old bytes passed the check for exactly that
        reason, so a same-named file in another plugin's extensions/ must be registered.
        """
        self.copy_script("check-shared-detector.py")
        registered = runpy.run_path(str(REPO / "scripts" / "check-shared-detector.py"))["DUPLICATED"]
        for index, group in enumerate(registered):
            for name in group:
                path = self.root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(f"export const shared = {index};\n", encoding="utf-8")
        canonical = self.root / registered[0][0]
        stray = self.root / "stray" / "extensions" / canonical.name
        stray.parent.mkdir(parents=True)
        stray.write_text("export const stale = true;\n", encoding="utf-8")
        # A same-named file outside a plugin's extensions/ directory is not a copy.
        unrelated = self.root / "stray" / "notes" / canonical.name
        unrelated.parent.mkdir(parents=True)
        unrelated.write_text("unrelated\n", encoding="utf-8")

        result = self.run_script("check-shared-detector.py")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn(f"stray/extensions/{canonical.name}: unregistered copy", result.stdout)
        self.assertNotIn("stray/notes", result.stdout)

        stray.unlink()
        clean = self.run_script("check-shared-detector.py")
        self.assertEqual(clean.returncode, 0, clean.stdout)

    def test_all_extension_packages_reject_uninstallable_entries(self) -> None:
        self.copy_script("build-extensions.py")
        plugin = self.root / "example"
        (plugin / "extensions").mkdir(parents=True)
        (plugin / "extensions" / "tool.ts").write_text("export default () => {};\n")
        cases = (
            ({}, ["./extensions/missing.ts"], "missing source"),
            ({}, ["./other/tool.ts"], "unsupported extension"),
            ({}, ["./dist/tool.js"], "missing bundle"),
            ({"dep": "1.0.0"}, ["./extensions/tool.ts"], "missing bundle"),
            ({"dep": "1.0.0"}, ["./dist/tool.js"], "missing bundle"),
            ({}, ["./extensions/tool.ts", "./extensions/tool.ts"], "duplicate"),
        )
        for dependencies, entries, diagnostic in cases:
            with self.subTest(entries=entries, dependencies=dependencies):
                (plugin / "package.json").write_text(json.dumps({
                    "dependencies": dependencies, "omp": {"extensions": entries},
                }))
                before = self.snapshot()
                result = self.run_script("build-extensions.py", "--check")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(diagnostic, result.stderr)
                self.assertNotIn("Traceback", result.stderr)
                self.assertEqual(before, self.snapshot())

    def test_mcp_rejects_malformed_configs_in_any_plugin(self) -> None:
        self.copy_script("check-mcp-servers.py")
        for name in ("aws", "design"):
            target = self.root / name / ".omp-plugin"
            target.mkdir(parents=True)
            shutil.copy2(REPO / name / ".omp-plugin" / "plugin.json", target / "plugin.json")
        extra = self.root / "extra" / ".omp-plugin" / "plugin.json"
        extra.parent.mkdir(parents=True)
        invalid = (
            [], {"server": []}, {"server": {"command": " "}},
            {"server": {"url": "file:///tmp/socket"}},
            {"server": {"url": "http://[invalid"}},
            {"server": {"command": "server", "args": [3]}},
            {"server": {"command": "server", "env": {"KEY": 3}}},
            {"server": {"url": "https://example.com", "command": "server"}},
        )
        for servers in invalid:
            with self.subTest(servers=servers):
                extra.write_text(json.dumps({"mcpServers": servers}))
                before = self.snapshot()
                result = self.run_script("check-mcp-servers.py")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("FAIL", result.stdout)
                self.assertIn("extra", result.stdout)
                self.assertNotIn("PASS", result.stdout)
                self.assertNotIn("Traceback", result.stderr)
                self.assertEqual(before, self.snapshot())
        extra.write_text(json.dumps({"mcpServers": {
            "stdio": {"command": "server", "args": ["--flag"], "env": {"KEY": "value"}},
            "remote": {"url": "https://example.com/mcp"},
        }}))
        result = self.run_script("check-mcp-servers.py")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_shipped_metadata_gate_rejects_invalid_yaml_and_triggers(self) -> None:
        rule = self.root / "example" / "rules" / "example-rule.md"
        agent = self.root / "example" / "agents" / "example-agent.md"
        skill = self.root / "example" / "skills" / "example-skill" / "SKILL.md"
        for path in (rule, agent, skill):
            path.parent.mkdir(parents=True, exist_ok=True)
        agent.write_text("---\nname: example-agent\ndescription: Use when checking an example agent\nmodel: '@task'\nthinking-level: medium\ntools: read, grep\n---\n# Output\nPASS|FAIL CAP 20w; paths only.\n")
        skill.write_text("---\nname: example-skill\ndescription: Use when checking an example skill\n---\nBody\n")

        def gate() -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                ["bun", str(REPO / "scripts/check-agentic-metadata.ts"), str(self.root)],
                capture_output=True, text=True, timeout=30,
            )

        rule.write_text('---\nname: example-rule\ndescription: "A --- separator remains YAML"\ncondition: "a---b"\n---\nBody\n')
        result = gate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("checked 1 rules, 1 agents, 1 skills", result.stdout)
        for fields in (
            "condition: [broken",
            "condition: 42",
            "condition: null",
            'condition: "("',
            'condition: "("\nx-lint:\n  allow: [E14]',
        ):
            with self.subTest(fields=fields):
                rule.write_text(f"---\nname: example-rule\ndescription: A described rule\n{fields}\n---\nBody\n")
                result = gate()
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn(str(rule), result.stderr)
                self.assertNotIn("every shipped asset passed", result.stdout)

        rule.write_text("---\nname: example-rule\ndescription: A described rule\n---\nBody\n")
        for path in (agent, skill):
            original = path.read_text()
            path.write_text("---\nname: [broken\ndescription: Use when validating metadata\n---\nBody\n")
            result = gate()
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertIn(str(path), result.stderr)
            path.write_text(original)

        valid_agent = agent.read_text()
        for field in ("model", "thinking-level", "tools"):
            with self.subTest(missing_agent_field=field):
                agent.write_text("\n".join(
                    line for line in valid_agent.splitlines()
                    if not line.startswith(f"{field}:")
                ) + "\n")
                result = gate()
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn(str(agent), result.stderr)
                self.assertIn(field, result.stderr)
                agent.write_text(valid_agent)

        agent.write_text(valid_agent.replace("tools: read, grep", "tools: [read, grep]"))
        result = gate()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn(str(agent), result.stderr)
        self.assertIn("tools", result.stderr)
        agent.write_text(valid_agent)

    def test_duplicate_names_detects_agents_in_temp_root(self) -> None:
        self.copy_script("check-duplicate-names.py")
        for plugin in ("first", "second"):
            agent = self.root / plugin / "agents" / "worker.md"
            agent.parent.mkdir(parents=True)
            agent.write_text("---\nname: shared-agent\n---\n", encoding="utf-8")
        result = self.run_script("check-duplicate-names.py", "--root", "first", "--root", "second")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("collision: agent 'shared-agent' declared 2 times", result.stdout)

    def test_duplicate_names_detects_tools_from_direct_root(self) -> None:
        self.copy_script("check-duplicate-names.py")
        for plugin in ("first", "second"):
            tools = self.root / plugin / "src" / "tools"
            tools.mkdir(parents=True)
            (tools / "first.ts").write_text('export const tool = { name: "shared_tool" };\n', encoding="utf-8")
        result = self.run_script("check-duplicate-names.py", "--root", str(self.root / "first"), "--root", str(self.root / "second"))
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("collision: tools 'shared_tool' declared 2 times", result.stdout)

    def contract_demo_agents(self) -> Path:
        self.copy_script("check-contract.py")
        plugin = self.root / "demo"
        (plugin / ".omp-plugin").mkdir(parents=True)
        (plugin / ".omp-plugin" / "plugin.json").write_text("{}", encoding="utf-8")
        (plugin / "README.md").write_text("# demo\n", encoding="utf-8")
        agents = plugin / "agents"
        agents.mkdir()
        return agents

    def assert_shadowing(self, agents: Path, cases: tuple[tuple[str, bool], ...]) -> list[str]:
        stderr = []
        for name, shadows in cases:
            with self.subTest(agent=name):
                agent = agents / f"{name}.md"
                agent.write_text(f"---\nname: {name}\ndescription: Demo agent.\n---\nBody\n", encoding="utf-8")
                result = self.run_script("check-contract.py")
                agent.unlink()
                stderr.append(result.stderr)
                if shadows:
                    self.assertNotEqual(result.returncode, 0, result.stdout)
                    self.assertIn(f"name {name!r} shadows a bundled agent", result.stdout)
                else:
                    self.assertEqual(result.returncode, 0, result.stdout)
        return stderr

    def test_contract_rejects_only_bundled_agent_names(self) -> None:
        """Without an installed host the literal set applies: OMP 18.8.4 bundles scout,
        reviewer, security-reviewer, task, and sonic, and nothing else, and says so.

        `designer` and `librarian` were once listed here, which would have refused a
        plugin agent of either name although neither shadows anything.
        """
        stderr = self.assert_shadowing(self.contract_demo_agents(), (
            ("scout", True), ("reviewer", True), ("security-reviewer", True), ("task", True), ("sonic", True),
            ("designer", False), ("librarian", False),
        ))
        for text in stderr:
            self.assertIn("WARN cannot read bundled agents", text)

    def test_contract_derives_bundled_agents_from_pinned_host(self) -> None:
        """The installed host is the authority: a name it adds shadows, a name it drops does not."""
        agents = self.contract_demo_agents()
        task = self.root / "node_modules/@oh-my-pi/pi-coding-agent/src/task"
        prompts = task.parent / "prompts/agents"
        task.mkdir(parents=True)
        prompts.mkdir(parents=True)
        (prompts / "scout.md").write_text("---\nname: scout\ndescription: x\n---\nBody\n", encoding="utf-8")
        (prompts / "task.md").write_text("Worker agent.\n", encoding="utf-8")
        (task / "agents.ts").write_text(
            'import scoutMd from "../prompts/agents/scout.md" with { type: "text" };\n'
            'import taskMd from "../prompts/agents/task.md" with { type: "text" };\n'
            "const EMBEDDED_AGENT_DEFS: EmbeddedAgentDef[] = [\n"
            '\t{ fileName: "scout.md", template: scoutMd },\n'
            '\t{\n\t\tfileName: "planner.md",\n\t\tfrontmatter: {\n\t\t\tname: "planner",\n'
            '\t\t\tdescription: "Plans",\n\t\t},\n\t\ttemplate: taskMd,\n\t},\n'
            "];\n",
            encoding="utf-8",
        )
        stderr = self.assert_shadowing(agents, (("scout", True), ("planner", True), ("sonic", False)))
        for text in stderr:
            self.assertNotIn("WARN", text)

if __name__ == "__main__":
    unittest.main()
