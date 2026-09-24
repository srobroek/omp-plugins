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


if __name__ == "__main__":
    unittest.main()
