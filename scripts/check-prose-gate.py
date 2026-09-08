#!/usr/bin/env python3
"""Run with: uvx --from slopvac==1.0.1 python scripts/check-prose-gate.py."""

from __future__ import annotations
from types import SimpleNamespace

import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from click.testing import CliRunner

spec = importlib.util.spec_from_file_location(
    "prose_gate", Path(__file__).with_name("prose-gate.py")
)
assert spec is not None and spec.loader is not None
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class ProseGateChecks(unittest.TestCase):
    def test_real_engine_ascii_and_emoji(self):
        with tempfile.TemporaryDirectory(prefix="prose-canary-") as directory:
            root = Path(directory)
            ascii_path = root / "ascii.md"
            emoji_path = root / "emoji.md"
            ascii_path.write_text(
                "# Plugin\n\n## Install\n\n## Guide\n\n## Notes\n\n## License\n",
                encoding="utf-8",
            )
            emoji_path.write_text(
                "# 🚀 Install\n\n- 🚀 Install the plugin\n", encoding="utf-8"
            )
            with gate.adapted() as cli:
                result = CliRunner().invoke(
                    cli.main,
                    [str(ascii_path), str(emoji_path), "--profile", "normal", "--format", "json"],
                )
            self.assertIn(result.exit_code, (0, 1), result.output + repr(result.exception))
            documents = json.loads(result.output)["documents"]
            by_path = {document["path"]: document for document in documents}
            self.assertEqual(set(by_path), {str(ascii_path), str(emoji_path)})
            for document in documents:
                self.assertEqual(document["unchecked"], [])
            self.assertFalse(
                [finding for finding in by_path[str(ascii_path)]["findings"]
                 if finding["rule_id"] in gate.PATTERNS]
            )
            emoji_findings = by_path[str(emoji_path)]["findings"]
            for rule_id in gate.PATTERNS:
                self.assertTrue(any(
                    finding["rule_id"] == rule_id and "🚀" in finding["matched_text"]
                    for finding in emoji_findings
                ), (rule_id, emoji_findings))

    def test_missing_vale_fails_cli(self):
        with tempfile.TemporaryDirectory(prefix="prose-canary-") as directory:
            path = Path(directory) / "clean.md"
            path.write_text("# Install\n", encoding="utf-8")
            with gate.adapted() as cli, patch.object(gate.shutil, "which", return_value=None):
                result = CliRunner().invoke(cli.main, [str(path), "--profile", "normal"])
            self.assertNotEqual(result.exit_code, 0)
            self.assertIsInstance(result.exception, gate.IncompleteRun)

    def test_unchecked_backend_fails_cli(self):
        from slopvac.vale import ValeResult

        with tempfile.TemporaryDirectory(prefix="prose-canary-") as directory:
            path = Path(directory) / "clean.md"
            path.write_text("# Install\n", encoding="utf-8")
            with gate.adapted() as cli, patch.object(
                cli, "run_compiled_vale",
                return_value=ValeResult(unchecked=["diagnostics could not be parsed"]),
            ):
                result = CliRunner().invoke(cli.main, [str(path), "--profile", "normal"])
            self.assertNotEqual(result.exit_code, 0)
            self.assertIsInstance(result.exception, gate.IncompleteRun)

    def test_invalid_backend_reports_fail(self):
        for stdout, stderr, code in (
            ("", "", 0),
            ("not JSON", "", 0),
            ("[]", "", 0),
            ('{"file.md": {}}', "", 0),
            ('{"file.md": [{}]}', "", 0),
            ("{}", "backend failed", 2),
            ("{}", "", 2),
            ("{}", "E201: error parsing regexp", 0),
        ):
            with self.subTest(stdout=stdout, stderr=stderr, code=code), patch.object(
                gate.subprocess, "run",
                return_value=subprocess.CompletedProcess([], code, stdout, stderr),
            ), self.assertRaises(gate.IncompleteRun):
                gate.checked_run(["vale", "--output=JSON"])

    def test_invalid_resolved_checks_fail(self):
        with patch.object(
            gate.subprocess, "run",
            return_value=subprocess.CompletedProcess([], 0, '{"Checks": null}', ""),
        ), self.assertRaises(gate.IncompleteRun):
            gate.checked_run(["vale", "ls-config"])

    def test_unclassified_rule_fails(self):
        from slopvac.config import Config, Severity, resolve_for
        from slopvac.engine import Engine
        from slopvac.model import RuleKind
        from slopvac.rules import load_ruleset

        ruleset = load_ruleset()
        resolved = resolve_for(Config(), Path("canary.md"))
        engine = Engine(ruleset.rules, resolved)
        active = {
            rule.qualified_id for rule in engine.rules
            if engine.severity_for(rule) is not Severity.OFF
        }
        judgement = {
            rule.qualified_id for rule in ruleset.rules if rule.kind is RuleKind.JUDGEMENT
        }
        omitted = next(iter(active))
        compiled = SimpleNamespace(
            native_rules=[SimpleNamespace(rule_id=rule) for rule in active - {omitted}],
            vale_rules=[], aliases={}, judgement_rules=list(judgement),
            disabled_rules=list(
                {rule.qualified_id for rule in ruleset.rules} - active - judgement
            ),
            notes=[],
        )
        with self.assertRaises(gate.IncompleteRun):
            gate.require_classification(ruleset, resolved, compiled)

    def test_incompatible_upstream_fails_before_patching(self):
        with patch.object(gate, "version", return_value="1.0.2"):
            with self.assertRaises(gate.IncompleteRun):
                with gate.adapted():
                    self.fail("an unreviewed upstream version was accepted")


if __name__ == "__main__":
    unittest.main()
