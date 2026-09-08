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


if __name__ == "__main__":
    unittest.main()
