#!/usr/bin/env python3
"""Focused claim-pools preflight checks."""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("preflight.py")
SPEC = importlib.util.spec_from_file_location("orchestrate_preflight", MODULE_PATH)
assert SPEC and SPEC.loader
preflight = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preflight)


class ClaimPoolsCheck(unittest.TestCase):
    def run_check(self, stdout: str, returncode: int = 0, stderr: str = "") -> dict[str, object]:
        result = preflight.CommandResult(
            ["bd", "config", "get", "claim.pools"], returncode, stdout, stderr
        )
        with patch.object(preflight.shutil, "which", return_value="/usr/bin/bd"), patch.object(
            preflight, "run_command", return_value=result
        ):
            return preflight.claim_pools_check()

    def test_present(self) -> None:
        result = self.run_check(",".join(preflight.CLAIM_POOLS))
        self.assertEqual(result["status"], "pass")
        self.assertIsNone(result["fix"])

    def test_missing_one(self) -> None:
        configured = ",".join(pool for pool in preflight.CLAIM_POOLS if pool != "pool:operator")
        result = self.run_check(configured)
        self.assertEqual(result["status"], "fail")
        self.assertIn("pool:operator", result["detail"])
        self.assertEqual(result["fix"], preflight.CLAIM_POOLS_FIX)

    def test_unset(self) -> None:
        result = self.run_check("")
        self.assertEqual(result["status"], "fail")
        self.assertIn("missing required aliases", result["detail"])
        self.assertEqual(result["fix"], preflight.CLAIM_POOLS_FIX)

    def test_bd_error(self) -> None:
        result = self.run_check("", returncode=1, stderr="config unavailable")
        self.assertEqual(result["status"], "fail")
        self.assertIn("config unavailable", result["detail"])
        self.assertEqual(result["fix"], preflight.CLAIM_POOLS_FIX)


    def test_isolation_requires_exact_boolean_field(self) -> None:
        result = preflight.CommandResult(
            ["omp", "config", "get", "task.isolation.enabled", "--json"],
            0,
            '{"unrelated_setting":false}',
            "",
        )
        with patch.object(preflight.shutil, "which", return_value="/usr/bin/omp"), patch.object(
            preflight, "run_command", return_value=result
        ):
            check = preflight.isolation_check()
        self.assertEqual(check["status"], "fail")

    def test_non_text_and_trailing_json_are_rejected(self) -> None:
        with self.assertRaises(ValueError):
            preflight.decode_json({"value": False})  # type: ignore[arg-type]
        with self.assertRaises(ValueError):
            preflight.decode_json('{"value":false}\nTRAILING')

    def test_base_requires_an_immutable_full_sha(self) -> None:
        result = preflight.base_check("main")
        self.assertEqual(result["status"], "fail")
        self.assertIn("exact base SHA", result["detail"])

    def test_github_repo_rejects_github_string_in_other_host(self) -> None:
        result = preflight.CommandResult(
            ["git", "remote", "-v"],
            0,
            "origin https://evil.example/github.com/owner/repo.git (fetch)\n",
            "",
        )
        with patch.object(preflight.shutil, "which", return_value="/usr/bin/git"), patch.object(
            preflight, "run_command", return_value=result
        ):
            repo, detail = preflight.github_repo()
        self.assertIsNone(repo)
        self.assertIn("no GitHub remote", detail)

    def test_policy_requires_complete_object_and_rejects_trailing_garbage(self) -> None:
        help_result = preflight.CommandResult(["gh", "api", "--help"], 0, "--jq", "")
        incomplete = preflight.CommandResult(
            ["gh", "api", "repos/owner/repo"], 0, '{"allow_merge_commit":true}', ""
        )
        trailing = preflight.CommandResult(
            ["gh", "api", "repos/owner/repo"], 0, '{"allow_merge_commit":true}\nTRAILING', ""
        )
        with patch.object(preflight, "github_repo", return_value=("owner/repo", "")), patch.object(
            preflight.shutil, "which", return_value="/usr/bin/gh"
        ), patch.object(preflight, "run_command", side_effect=[help_result, incomplete]):
            check = preflight.upstream_policy_check()
        self.assertEqual(check["status"], "fail")

        with patch.object(preflight, "github_repo", return_value=("owner/repo", "")), patch.object(
            preflight.shutil, "which", return_value="/usr/bin/gh"
        ), patch.object(preflight, "run_command", side_effect=[help_result, trailing]):
            check = preflight.upstream_policy_check()
        self.assertEqual(check["status"], "fail")

    def test_empty_sibling_checks_fail_closed(self) -> None:
        sibling = Path("sibling-preflight.py")
        result = preflight.CommandResult(["python", str(sibling), "--json"], 0, '{"checks":[]}', "")
        with patch.object(preflight, "find_sibling", return_value=(sibling, [sibling])), patch.object(
            preflight, "run_command", return_value=result
        ):
            checks = preflight.sibling_checks("beads", str(sibling), None, (), "preflight", False)
        self.assertEqual(checks[0]["status"], "fail")

if __name__ == "__main__":
    unittest.main()
