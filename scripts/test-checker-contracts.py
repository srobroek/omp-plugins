#!/usr/bin/env python3
"""Isolated CLI regressions: python3 scripts/test-checker-contracts.py."""

from __future__ import annotations

import json
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

    def test_manifest_check_detects_missing_stale_and_invalid_packages(self) -> None:
        self.copy_script("sync-plugin-manifests.py")
        result = self.run_script("sync-plugin-manifests.py")
        self.assertEqual(result.returncode, 0, result.stderr)
        package = self.root / "go" / "package.json"
        original = package.read_bytes()
        cases = (None, b'{"name":"stale"}\n', b'[]\n', b'{broken')
        for contents in cases:
            with self.subTest(contents=contents):
                if contents is None:
                    package.unlink()
                else:
                    package.write_bytes(contents)
                before = self.snapshot()
                result = self.run_script("sync-plugin-manifests.py", "--check")
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn("go/package.json", result.stderr)
                self.assertEqual(before, self.snapshot())
                package.write_bytes(original)
        manifest = self.root / "go" / ".omp-plugin" / "plugin.json"
        manifest.unlink()
        before = self.snapshot()
        result = self.run_script("sync-plugin-manifests.py", "--check")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(before, self.snapshot())

    def test_generation_preserves_plugin_owned_metadata(self) -> None:
        self.copy_script("sync-plugin-manifests.py")
        self.assertEqual(self.run_script("sync-plugin-manifests.py").returncode, 0)
        manifest = self.root / "go" / ".omp-plugin" / "plugin.json"
        package = self.root / "go" / "package.json"
        custom = {"author": {"name": "Maintainer"}, "license": "MIT", "mcpServers": {"local": {"command": "local-server"}}}
        data = json.loads(manifest.read_text())
        data.update(custom, name="stale", version="2.3.4", publish=False)
        manifest.write_text(json.dumps(data))
        pkg = json.loads(package.read_text())
        pkg.update(omp={"extensions": ["./extensions/tool.ts"]}, dependencies={"example": "1.0.0"})
        package.write_text(json.dumps(pkg))
        result = self.run_script("sync-plugin-manifests.py")
        self.assertEqual(result.returncode, 0, result.stderr)
        generated = json.loads(manifest.read_text())
        for key, value in custom.items():
            self.assertEqual(generated[key], value)
        self.assertEqual(generated["name"], "go")
        self.assertNotIn("publish", generated)
        generated_package = json.loads(package.read_text())
        self.assertEqual(generated_package["version"], "2.3.4")
        self.assertEqual(generated_package["omp"], pkg["omp"])
        self.assertEqual(generated_package["dependencies"], pkg["dependencies"])
        result = self.run_script("sync-plugin-manifests.py", "--check")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_failed_catalog_generator_cannot_pass_or_mutate_inputs(self) -> None:
        self.copy_script("check-design-structure.py")
        self.copy_script("sync-plugin-manifests.py")
        shutil.copytree(REPO / "design", self.root / "design")
        for manifest in REPO.glob("*/.omp-plugin/plugin.json"):
            target = self.root / manifest.relative_to(REPO)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(manifest, target)
        shutil.copytree(REPO / ".omp-plugin", self.root / ".omp-plugin")
        shutil.copy2(REPO / "scripts" / "third-party-plugins.json", self.root / "scripts" / "third-party-plugins.json")
        (self.root / "scripts" / "build-catalog.py").write_text("raise SystemExit(17)\n")
        before = self.snapshot()
        result = self.run_script("check-design-structure.py")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("FAIL catalog builds without third-party entries -- exit 17", result.stdout)
        self.assertIn("FAIL catalog builds with third-party entries -- exit 17", result.stdout)
        self.assertEqual(before, self.snapshot())

    def test_all_extension_packages_reject_uninstallable_entries(self) -> None:
        self.copy_script("build-extensions.py")
        plugin = self.root / "example"
        (plugin / "extensions").mkdir(parents=True)
        (plugin / "extensions" / "tool.ts").write_text("export default () => {};\n")
        cases = (
            ({}, ["./extensions/missing.ts"], "missing source"),
            ({}, ["./other/tool.ts"], "unsupported extension"),
            ({}, ["./dist/tool.js"], "missing bundle"),
            ({"dep": "1.0.0"}, ["./extensions/tool.ts"], "packaged dist"),
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

    def test_catalog_and_release_reject_invalid_local_inventory(self) -> None:
        for script in ("sync-plugin-manifests.py", "build-catalog.py", "build-release-config.py"):
            self.copy_script(script)
        self.assertEqual(self.run_script("sync-plugin-manifests.py").returncode, 0)
        manifest = self.root / "go" / ".omp-plugin" / "plugin.json"
        original = manifest.read_bytes()
        valid = json.loads(original)
        cases = (
            (None, "missing"),
            ([], "object"),
            ({**valid, "name": "python"}, "directory"),
            ({**valid, "name": 7}, "name"),
            ({**valid, "name": "find-tools"}, "duplicate"),
            ({**valid, "version": 7}, "version"),
            ({**valid, "publish": "false"}, "publish"),
            ("{broken", "cannot read manifest"),
        )
        for payload, diagnostic in cases:
            with self.subTest(payload=payload):
                if payload is None:
                    manifest.unlink()
                else:
                    manifest.write_text(payload if isinstance(payload, str) else json.dumps(payload))
                for script in ("build-catalog.py", "build-release-config.py"):
                    before = self.snapshot()
                    result = self.run_script(script, "--check")
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(diagnostic, result.stderr)
                    self.assertNotIn("Traceback", result.stderr)
                    self.assertEqual(before, self.snapshot())
                manifest.write_bytes(original)
        extra = self.root / "extra" / ".omp-plugin" / "plugin.json"
        extra.parent.mkdir(parents=True)
        extra.write_text(json.dumps({**valid, "name": "extra"}))
        for script in ("sync-plugin-manifests.py", "build-catalog.py", "build-release-config.py"):
            before = self.snapshot()
            result = self.run_script(script, "--check")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("unregistered", result.stderr)
            self.assertEqual(before, self.snapshot())

    def test_mcp_rejects_malformed_configs_in_any_plugin(self) -> None:
        self.copy_script("check-mcp-servers.py")
        for name in ("design", "browser-tools", "diagram"):
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

    def test_linked_mcp_config_tracks_inline_authority_without_mutating_checks(self) -> None:
        self.copy_script("sync-plugin-manifests.py")
        self.assertEqual(self.run_script("sync-plugin-manifests.py").returncode, 0)
        manifest = self.root / "design" / ".omp-plugin" / "plugin.json"
        data = json.loads(manifest.read_text())
        servers = {"remote": {"url": "https://example.com/mcp"}}
        data["mcpServers"] = servers
        manifest.write_text(json.dumps(data))
        unrelated = self.root / "go" / ".mcp.json"
        unrelated.write_text('{"mcpServers":{"owned":{"command":"keep-me"}}}\n')
        original_unrelated = unrelated.read_bytes()
        result = self.run_script("sync-plugin-manifests.py")
        self.assertEqual(result.returncode, 0, result.stderr)
        linked = self.root / "design" / ".mcp.json"
        self.assertEqual(json.loads(linked.read_text()), {"mcpServers": servers})
        self.assertEqual(unrelated.read_bytes(), original_unrelated)
        original = linked.read_bytes()
        for contents in (None, '{"mcpServers":{}}\n', '{broken'):
            with self.subTest(contents=contents):
                if contents is None:
                    linked.unlink()
                else:
                    linked.write_text(contents)
                before = self.snapshot()
                result = self.run_script("sync-plugin-manifests.py", "--check")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("design/.mcp.json", result.stderr)
                self.assertEqual(before, self.snapshot())
                linked.write_bytes(original)
        servers["remote"]["url"] = "https://example.com/updated"
        data["mcpServers"] = servers
        manifest.write_text(json.dumps(data))
        result = self.run_script("sync-plugin-manifests.py")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(linked.read_text()), {"mcpServers": servers})
        self.assertEqual(unrelated.read_bytes(), original_unrelated)
        result = self.run_script("sync-plugin-manifests.py", "--check")
        self.assertEqual(result.returncode, 0, result.stderr)

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

if __name__ == "__main__":
    unittest.main()
