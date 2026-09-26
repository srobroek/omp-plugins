#!/usr/bin/env python3
"""Focused claim-pools preflight checks."""

from __future__ import annotations
import importlib.util
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("preflight.py")
SPEC = importlib.util.spec_from_file_location("orchestrate_preflight", MODULE_PATH)
assert SPEC and SPEC.loader
preflight = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preflight)


class ClaimPoolsCheck(unittest.TestCase):
    def make_installed_tree(self, directory: str, registry_contents: str | None = "registry") -> dict[str, Path]:
        root = Path(directory)
        plugins_root = root / "plugins"
        cache_root = plugins_root / "cache" / "plugins"
        package_roots = {
            package: cache_root / f"srobroek-omp___{package}___3.0.0"
            for package in ("orchestrate", "beads", "worktrunk")
        }
        orchestrate_script = package_roots["orchestrate"] / "skills" / "orchestrate-preflight" / "preflight.py"
        orchestrate_script.parent.mkdir(parents=True)
        shutil.copy2(MODULE_PATH, orchestrate_script)
        sibling_scripts: dict[str, Path] = {}
        for package, skill in (("beads", "beads-preflight"), ("worktrunk", "worktrunk-preflight")):
            script = package_roots[package] / "skills" / skill / "preflight.py"
            script.parent.mkdir(parents=True)
            payload = {
                "checks": [{"id": f"{package}-installed", "status": "pass", "detail": "ok", "fix": None}]
            }
            script.write_text(
                "#!/usr/bin/env python3\nimport json\n"
                f"print(json.dumps({payload!r}))\n",
                encoding="utf-8",
            )
            sibling_scripts[package] = script
        if registry_contents is not None:
            if registry_contents == "registry":
                registry_contents = json.dumps(
                    {
                        "version": 2,
                        "plugins": {
                            f"{package}@srobroek-omp": [
                                {
                                    "scope": "user",
                                    "installPath": str(package_roots[package]),
                                    "version": "3.0.0",
                                }
                            ]
                            for package in ("beads", "worktrunk")
                        },
                    }
                )
            (plugins_root / "installed_plugins.json").write_text(registry_contents, encoding="utf-8")
        return {
            "orchestrate": orchestrate_script,
            "beads": sibling_scripts["beads"],
            "worktrunk": sibling_scripts["worktrunk"],
            "plugins": plugins_root,
            "cache_plugins": cache_root,
        }

    def test_installed_registry_runs_both_sibling_preflights(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            paths = self.make_installed_tree(directory)
            with patch.object(preflight, "__file__", str(paths["orchestrate"])):
                beads_found, beads_tried = preflight.find_sibling(None, None, ("beads",), "beads-preflight")
                worktrunk_found, worktrunk_tried = preflight.find_sibling(
                    None, None, ("worktrunk",), "worktrunk-preflight"
                )
                beads = preflight.sibling_checks("beads", None, None, ("beads",), "beads-preflight", False)
                worktrunk = preflight.sibling_checks(
                    "worktrunk", None, None, ("worktrunk",), "worktrunk-preflight", False
                )
        self.assertEqual(beads_found.resolve(), paths["beads"].resolve())
        self.assertIn(paths["beads"].resolve(), {path.resolve() for path in beads_tried})
        self.assertEqual(worktrunk_found.resolve(), paths["worktrunk"].resolve())
        self.assertIn(paths["worktrunk"].resolve(), {path.resolve() for path in worktrunk_tried})
        self.assertEqual(beads[0]["id"], "beads.beads-installed")
        self.assertEqual(beads[0]["status"], "pass")
        self.assertEqual(worktrunk[0]["id"], "worktrunk.worktrunk-installed")
        self.assertEqual(worktrunk[0]["status"], "pass")
    def test_unresolved_node_modules_symlink_finds_sibling(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            paths = self.make_installed_tree(directory)
            scope_root = paths["plugins"] / "node_modules" / "@srobroek"
            scope_root.mkdir(parents=True)
            links: dict[str, Path] = {}
            for package in ("orchestrate", "beads", "worktrunk"):
                link = scope_root / package
                link.symlink_to(paths[package].parents[2], target_is_directory=True)
                links[package] = link
            orchestrate_link_script = links["orchestrate"] / "skills" / "orchestrate-preflight" / "preflight.py"
            expected_beads = links["beads"] / "skills" / "beads-preflight" / "preflight.py"
            with patch.object(preflight, "__file__", str(orchestrate_link_script)):
                found, _ = preflight.find_sibling(None, None, ("beads",), "beads-preflight")
                checks = preflight.sibling_checks("beads", None, None, ("beads",), "beads-preflight", False)
        self.assertEqual(found, expected_beads)
        self.assertEqual(checks[0]["status"], "pass")


    def test_missing_registry_uses_a_single_installed_glob_match(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            paths = self.make_installed_tree(directory, registry_contents=None)
            with patch.object(preflight, "__file__", str(paths["orchestrate"])):
                found, tried = preflight.find_sibling(None, None, ("beads",), "beads-preflight")
        self.assertEqual(found.resolve(), paths["beads"].resolve())
        self.assertIn(paths["beads"].resolve(), {path.resolve() for path in tried})

    def test_missing_registry_with_multiple_glob_matches_fails_with_install_fix(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            paths = self.make_installed_tree(directory, registry_contents=None)
            alternate = paths["cache_plugins"] / "srobroek-omp___beads___4.0.0" / "skills" / "beads-preflight" / "preflight.py"
            alternate.parent.mkdir(parents=True)
            shutil.copy2(paths["beads"], alternate)
            with patch.object(preflight, "__file__", str(paths["orchestrate"])):
                checks = preflight.sibling_checks("beads", None, None, ("beads",), "beads-preflight", False)
        self.assertEqual(checks[0]["status"], "fail")
        self.assertEqual(checks[0]["fix"], "omp plugin install beads@srobroek-omp")
        self.assertIn("3.0.0", checks[0]["detail"])
        self.assertIn("4.0.0", checks[0]["detail"])

    def test_malformed_registry_falls_back_to_glob(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            paths = self.make_installed_tree(directory, registry_contents="not json")
            with patch.object(preflight, "__file__", str(paths["orchestrate"])):
                found, _ = preflight.find_sibling(None, None, ("beads",), "beads-preflight")
        self.assertEqual(found.resolve(), paths["beads"].resolve())

    def test_invalid_utf8_command_output_is_replaced(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "emit-invalid-utf8.py"
            script.write_text("#!/usr/bin/env python3\nimport os; os.write(1, b'\\xff\\xfe')", encoding="utf-8")
            script.chmod(0o700)
            result = preflight.run_command([str(script)])
        self.assertEqual(result.returncode, 0)
        self.assertIn("\ufffd", result.stdout)

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

    def test_relative_sibling_path_uses_package_root_from_child_cwd(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "repo"
            script = root / "orchestrate/skills/orchestrate-preflight/preflight.py"
            sibling = root / "beads/skills/beads-preflight/preflight.py"
            sibling.parent.mkdir(parents=True)
            sibling.touch()
            child_cwd = Path(directory) / "child-worktree"
            child_cwd.mkdir()
            previous = Path.cwd()
            os.chdir(child_cwd)
            try:
                with patch.object(preflight, "__file__", str(script)):
                    found, _ = preflight.find_sibling(
                        "beads/skills/beads-preflight/preflight.py", None, (), "beads-preflight"
                    )
            finally:
                os.chdir(previous)
        self.assertEqual(found.resolve(), sibling.resolve())
if __name__ == "__main__":
    unittest.main()
