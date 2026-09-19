#!/usr/bin/env python3
"""Dependabot policy contracts: uvx --from pyyaml==6.0.3 python scripts/test-dependabot-contracts.py.

Two suites, both about checks that have no other way to fail:

`PolicyMutations` mutates one fact at a time in a copy of this repository and
asserts scripts/check-dependabot-config.py names it. A validator that reads a file
and finds nothing wrong is indistinguishable from a validator that never looked, so
each contract it claims to hold gets a mutation that breaks it.

`DistGuardFixtures` drives scripts/dependabot-dist-guard.py, the only thing standing
between an artifact built from pull-request code and a push made with a write token.
It has to reject a wrong actor, a head that moved, a fork, a path outside the
generated output, a symlink and a hard link, and it has to re-check the allowlist
when it applies bytes rather than trusting the manifest it was handed.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parent.parent
VALIDATOR = "check-dependabot-config.py"
GUARD = REPO / "scripts/dependabot-dist-guard.py"

# Enough of the repository for the validator to reach every contract: the policy,
# every workflow it cross-checks, the manifests it reads pins and dependency names
# from, and a lockfile per watched directory. Lockfile contents are never read, only
# their presence, so a placeholder stands in for a 3000-line resolution.
COPIED = (
    f"scripts/{VALIDATOR}",
    "scripts/check-plugin-loading.ts",
    "package.json",
    ".github/dependabot.yml",
    ".github/workflows/ci.yml",
    ".github/workflows/dependabot-automerge.yml",
    ".github/workflows/dependabot-dist-build.yml",
    ".github/workflows/dependabot-dist.yml",
    ".github/workflows/omp-minor-issue.yml",
    ".github/workflows/release-please.yml",
    "browser-tools/package.json",
    "dep-update/package.json",
    "whats-new/package.json",
)
LOCKED = (".", "browser-tools", "dep-update", "whats-new")

DIST = ".github/workflows/dependabot-dist.yml"
BUILD = ".github/workflows/dependabot-dist-build.yml"
MINOR = ".github/workflows/omp-minor-issue.yml"
AUTOMERGE = ".github/workflows/dependabot-automerge.yml"

SHA_A = "a" * 40
SHA_B = "b" * 40
BRANCH = "dependabot/bun/browser-tools/oh-my-pi/pi-utils-18.2.1"


def run(*args: str, cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )


class DistGuardFixtures(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="omp-dependabot-guard-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.trusted = self.root / "trusted"
        for plugin in ("browser-tools", "dep-update"):
            (self.trusted / plugin).mkdir(parents=True)
            (self.trusted / plugin / "package.json").write_text("{}\n", encoding="utf-8")
        (self.trusted / "scripts").mkdir()
        self.artifact = self.root / "artifact"
        self.artifact.mkdir()
        self.event = self.root / "event.json"
        self.pulls = self.root / "pulls.json"

    # --- context -----------------------------------------------------------

    def write_context(self, run: dict | None = None, pull: dict | None = None) -> None:
        base_run = {
            "event": "pull_request",
            "conclusion": "success",
            "head_branch": BRANCH,
            "head_sha": SHA_A,
            "repository": {"full_name": "srobroek/omp-plugins"},
            "head_repository": {"full_name": "srobroek/omp-plugins"},
            "actor": {"login": "dependabot[bot]"},
            "triggering_actor": {"login": "dependabot[bot]"},
        }
        base_run.update(run or {})
        base_pull = {
            "state": "open",
            "user": {"login": "dependabot[bot]"},
            "base": {"ref": "main"},
            "head": {
                "ref": BRANCH,
                "sha": SHA_A,
                "repo": {"full_name": "srobroek/omp-plugins"},
            },
        }
        base_pull.update(pull or {})
        self.event.write_text(json.dumps({"workflow_run": base_run}), encoding="utf-8")
        self.pulls.write_text(json.dumps([base_pull]), encoding="utf-8")

    def verify_context(self, output: Path | None = None) -> subprocess.CompletedProcess[str]:
        args = [
            str(GUARD), "verify-context",
            "--event", str(self.event),
            "--pulls", str(self.pulls),
            "--repository", "srobroek/omp-plugins",
            "--default-branch", "main",
        ]
        if output:
            args += ["--github-output", str(output)]
        return run(*args, cwd=self.root)

    def assert_context_rejected(self, fragment: str) -> None:
        result = self.verify_context()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn(fragment, result.stderr)

    def test_a_matching_dependabot_context_is_accepted_and_exported(self) -> None:
        self.write_context()
        output = self.root / "github-output"
        output.touch()
        result = self.verify_context(output)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            output.read_text(encoding="utf-8"), f"head-ref={BRANCH}\nhead-sha={SHA_A}\n"
        )

    def test_a_human_authored_pull_request_is_rejected(self) -> None:
        self.write_context(pull={"user": {"login": "srobroek"}})
        self.assert_context_rejected("pull request author is 'srobroek'")

    def test_a_run_triggered_by_someone_else_is_rejected(self) -> None:
        self.write_context(run={"triggering_actor": {"login": "srobroek"}})
        self.assert_context_rejected("run triggering_actor is 'srobroek'")

    def test_a_fork_head_is_rejected(self) -> None:
        self.write_context(
            run={"head_repository": {"full_name": "attacker/omp-plugins"}},
            pull={"head": {"ref": BRANCH, "sha": SHA_A, "repo": {"full_name": "attacker/omp-plugins"}}},
        )
        self.assert_context_rejected("run head repository is 'attacker/omp-plugins'")

    def test_a_head_that_moved_between_run_and_pull_request_is_rejected(self) -> None:
        self.write_context(pull={"head": {"ref": BRANCH, "sha": SHA_B, "repo": {"full_name": "srobroek/omp-plugins"}}})
        self.assert_context_rejected("does not match the run's")

    def test_a_pull_request_on_another_branch_is_rejected(self) -> None:
        self.write_context(
            pull={"head": {"ref": "dependabot/bun/other", "sha": SHA_A, "repo": {"full_name": "srobroek/omp-plugins"}}}
        )
        self.assert_context_rejected("does not match the run's")

    def test_a_branch_outside_the_dependabot_namespace_is_rejected(self) -> None:
        self.write_context(run={"head_branch": "feature/evil"}, pull={"head": {"ref": "feature/evil", "sha": SHA_A, "repo": {"full_name": "srobroek/omp-plugins"}}})
        self.assert_context_rejected("is not a 'dependabot/' branch")

    def test_a_branch_with_traversal_is_rejected(self) -> None:
        traversal = "dependabot/../../refs/heads/main"
        self.write_context(run={"head_branch": traversal}, pull={"head": {"ref": traversal, "sha": SHA_A, "repo": {"full_name": "srobroek/omp-plugins"}}})
        self.assert_context_rejected("is not a valid git ref name")

    def test_a_pull_request_targeting_another_base_is_rejected(self) -> None:
        self.write_context(pull={"base": {"ref": "release"}})
        self.assert_context_rejected("pull request base is 'release'")

    def test_a_failed_build_run_is_rejected(self) -> None:
        self.write_context(run={"conclusion": "failure"})
        self.assert_context_rejected("run conclusion must be 'success'")

    def test_a_run_from_another_event_is_rejected(self) -> None:
        self.write_context(run={"event": "workflow_dispatch"})
        self.assert_context_rejected("run event must be 'pull_request'")

    def test_an_ambiguous_pull_request_lookup_is_rejected(self) -> None:
        self.write_context()
        self.pulls.write_text("[]", encoding="utf-8")
        self.assert_context_rejected("expected exactly one open pull request")

    def test_event_branch_prints_a_validated_branch_and_refuses_others(self) -> None:
        self.write_context()
        good = run(str(GUARD), "event-branch", "--event", str(self.event), cwd=self.root)
        self.assertEqual(good.returncode, 0, good.stderr)
        self.assertEqual(good.stdout.strip(), BRANCH)
        self.event.write_text(
            json.dumps({"workflow_run": {"head_branch": "dependabot/x;$(id)"}}), encoding="utf-8"
        )
        bad = run(str(GUARD), "event-branch", "--event", str(self.event), cwd=self.root)
        self.assertEqual(bad.returncode, 1, bad.stdout)
        self.assertIn("outside [A-Za-z0-9._/-]", bad.stderr)

    # --- artifact ----------------------------------------------------------

    def stage_artifact(self, files: dict[str, str], metadata: dict | None = None) -> None:
        for relative, content in files.items():
            path = self.artifact / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        payload = {
            "repository": "srobroek/omp-plugins",
            "head_ref": BRANCH,
            "head_sha": SHA_A,
            "files": sorted(files),
        }
        payload.update(metadata or {})
        (self.artifact / "dependabot-dist.json").write_text(json.dumps(payload), encoding="utf-8")

    def verify_artifact(self) -> subprocess.CompletedProcess[str]:
        return run(
            str(GUARD), "verify-artifact",
            "--artifact", str(self.artifact),
            "--trusted", str(self.trusted),
            "--repository", "srobroek/omp-plugins",
            "--head-ref", BRANCH,
            "--head-sha", SHA_A,
            "--manifest", str(self.root / "manifest.txt"),
            cwd=self.root,
        )

    def assert_artifact_rejected(self, fragment: str) -> None:
        result = self.verify_artifact()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn(fragment, result.stderr)
        self.assertFalse((self.root / "manifest.txt").exists(), "a rejected artifact wrote a manifest")

    def test_generated_output_is_accepted_and_listed(self) -> None:
        self.stage_artifact({
            "browser-tools/dist/headed-browser-tools.js": "// bundle\n",
            "browser-tools/THIRD_PARTY_NOTICES.txt": "notices\n",
            "dep-update/dist/dep-scan-tool.js": "// bundle\n",
        })
        result = self.verify_artifact()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            (self.root / "manifest.txt").read_text(encoding="utf-8"),
            "browser-tools/THIRD_PARTY_NOTICES.txt\n"
            "browser-tools/dist/headed-browser-tools.js\n"
            "dep-update/dist/dep-scan-tool.js\n",
        )

    def test_a_path_outside_the_generated_output_is_rejected(self) -> None:
        self.stage_artifact({
            "browser-tools/dist/headed-browser-tools.js": "// bundle\n",
            ".github/workflows/pwn.yml": "on: push\n",
        })
        self.assert_artifact_rejected(".github/workflows/pwn.yml: not a generated output path")

    def test_a_source_file_beside_the_bundle_is_rejected(self) -> None:
        self.stage_artifact({"browser-tools/extensions/headed-browser-tools.ts": "export {}\n"})
        self.assert_artifact_rejected("not a generated output path")

    def test_a_lockfile_is_not_publishable_output(self) -> None:
        self.stage_artifact({"browser-tools/bun.lock": '{"lockfileVersion": 1}\n'})
        self.assert_artifact_rejected("browser-tools/bun.lock: not a generated output path")

    def test_a_dist_directory_under_a_non_plugin_is_rejected(self) -> None:
        self.stage_artifact({"scripts/dist/pwn.js": "// bundle\n"})
        self.assert_artifact_rejected("scripts/ is not a plugin in the default branch")

    def test_a_symlinked_payload_file_is_rejected(self) -> None:
        self.stage_artifact({"browser-tools/dist/headed-browser-tools.js": "// bundle\n"})
        link = self.artifact / "dep-update/dist/dep-scan-tool.js"
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to("/etc/passwd")
        self.assert_artifact_rejected("dep-update/dist/dep-scan-tool.js: symlink")

    def test_a_symlinked_directory_is_rejected(self) -> None:
        self.stage_artifact({"browser-tools/dist/headed-browser-tools.js": "// bundle\n"})
        (self.artifact / "dep-update").symlink_to(self.trusted, target_is_directory=True)
        self.assert_artifact_rejected("dep-update: symlinked directory")

    def test_a_hard_linked_payload_file_is_rejected(self) -> None:
        self.stage_artifact({"browser-tools/dist/headed-browser-tools.js": "// bundle\n"})
        target = self.artifact / "dep-update/dist/dep-scan-tool.js"
        target.parent.mkdir(parents=True, exist_ok=True)
        os.link(self.artifact / "browser-tools/dist/headed-browser-tools.js", target)
        self.assert_artifact_rejected("hard link with 2 names")

    def test_a_head_sha_the_build_did_not_claim_is_rejected(self) -> None:
        self.stage_artifact(
            {"browser-tools/dist/headed-browser-tools.js": "// bundle\n"},
            metadata={"head_sha": SHA_B},
        )
        self.assert_artifact_rejected(f"head_sha is '{SHA_B}'")

    def test_a_metadata_file_list_that_hides_a_payload_entry_is_rejected(self) -> None:
        self.stage_artifact(
            {
                "browser-tools/dist/headed-browser-tools.js": "// bundle\n",
                "dep-update/dist/dep-scan-tool.js": "// bundle\n",
            },
            metadata={"files": ["browser-tools/dist/headed-browser-tools.js"]},
        )
        self.assert_artifact_rejected("files does not match the uploaded payload")

    def test_an_artifact_without_metadata_is_rejected(self) -> None:
        self.stage_artifact({"browser-tools/dist/headed-browser-tools.js": "// bundle\n"})
        (self.artifact / "dependabot-dist.json").unlink()
        self.assert_artifact_rejected("missing dependabot-dist.json")

    def test_an_artifact_with_no_payload_is_rejected(self) -> None:
        self.stage_artifact({})
        self.assert_artifact_rejected("carries no generated output")

    # --- apply -------------------------------------------------------------

    def apply(self, manifest: str) -> subprocess.CompletedProcess[str]:
        (self.root / "manifest.txt").write_text(manifest, encoding="utf-8")
        return run(
            str(GUARD), "apply",
            "--artifact", str(self.artifact),
            "--manifest", str(self.root / "manifest.txt"),
            "--target", str(self.target),
            "--trusted", str(self.trusted),
            cwd=self.root,
        )

    def prepare_target(self) -> None:
        self.target = self.root / "_dependabot-head"
        (self.target / "browser-tools/dist").mkdir(parents=True)
        (self.target / "browser-tools/dist/headed-browser-tools.js").write_text("// old\n", encoding="utf-8")

    def test_apply_copies_bytes_without_the_executable_bit(self) -> None:
        self.prepare_target()
        self.stage_artifact({"browser-tools/dist/headed-browser-tools.js": "// new\n"})
        (self.artifact / "browser-tools/dist/headed-browser-tools.js").chmod(0o755)
        result = self.apply("browser-tools/dist/headed-browser-tools.js\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        landed = self.target / "browser-tools/dist/headed-browser-tools.js"
        self.assertEqual(landed.read_text(encoding="utf-8"), "// new\n")
        self.assertEqual(landed.stat().st_mode & 0o777, 0o644)

    def test_apply_rechecks_the_allowlist_instead_of_trusting_the_manifest(self) -> None:
        self.prepare_target()
        self.stage_artifact({"browser-tools/dist/headed-browser-tools.js": "// new\n"})
        pwn = self.artifact / ".github/workflows/pwn.yml"
        pwn.parent.mkdir(parents=True)
        pwn.write_text("on: push\n", encoding="utf-8")
        result = self.apply(".github/workflows/pwn.yml\n")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("not a generated output path", result.stderr)
        self.assertFalse((self.target / ".github").exists())

    def test_apply_refuses_a_symlinked_destination(self) -> None:
        self.prepare_target()
        outside = self.root / "outside.js"
        outside.write_text("// untouched\n", encoding="utf-8")
        destination = self.target / "browser-tools/dist/headed-browser-tools.js"
        destination.unlink()
        destination.symlink_to(outside)
        self.stage_artifact({"browser-tools/dist/headed-browser-tools.js": "// new\n"})
        result = self.apply("browser-tools/dist/headed-browser-tools.js\n")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("destination is a symlink", result.stderr)
        self.assertEqual(outside.read_text(encoding="utf-8"), "// untouched\n")

    def test_apply_refuses_a_symlinked_destination_parent(self) -> None:
        self.prepare_target()
        outside = self.root / "outside"
        outside.mkdir()
        shutil.rmtree(self.target / "browser-tools")
        (self.target / "browser-tools").symlink_to(outside, target_is_directory=True)
        self.stage_artifact({"browser-tools/dist/headed-browser-tools.js": "// new\n"})
        result = self.apply("browser-tools/dist/headed-browser-tools.js\n")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("destination path contains a symlink", result.stderr)
        self.assertEqual(list(outside.iterdir()), [], "a rejected path changed the outside tree")

    # --- stage -------------------------------------------------------------

    def test_stage_and_verify_agree_on_the_same_allowlist(self) -> None:
        """The build half and the publish half share `classify`, so prove they agree."""
        source = self.root / "head"
        for plugin in ("browser-tools", "dep-update"):
            (source / plugin / "dist").mkdir(parents=True)
            (source / plugin / "package.json").write_text("{}\n", encoding="utf-8")
        (source / "browser-tools/dist/headed-browser-tools.js").write_text("// new\n", encoding="utf-8")
        (source / "browser-tools/THIRD_PARTY_NOTICES.txt").write_text("notices\n", encoding="utf-8")
        changed = self.root / "changed.txt"
        changed.write_text(
            "browser-tools/dist/headed-browser-tools.js\nbrowser-tools/THIRD_PARTY_NOTICES.txt\n",
            encoding="utf-8",
        )
        out = self.root / "staged"
        staged = run(
            str(GUARD), "stage",
            "--repo", str(source),
            "--changed", str(changed),
            "--out", str(out),
            "--repository", "srobroek/omp-plugins",
            "--head-ref", BRANCH,
            "--head-sha", SHA_A,
            cwd=self.root,
        )
        self.assertEqual(staged.returncode, 0, staged.stderr)
        self.artifact = out
        result = self.verify_artifact()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_stage_refuses_to_publish_a_deletion(self) -> None:
        source = self.root / "head"
        (source / "browser-tools/dist").mkdir(parents=True)
        (source / "browser-tools/package.json").write_text("{}\n", encoding="utf-8")
        changed = self.root / "changed.txt"
        changed.write_text("browser-tools/dist/gone.js\n", encoding="utf-8")
        staged = run(
            str(GUARD), "stage",
            "--repo", str(source),
            "--changed", str(changed),
            "--out", str(self.root / "staged"),
            "--repository", "srobroek/omp-plugins",
            "--head-ref", BRANCH,
            "--head-sha", SHA_A,
            cwd=self.root,
        )
        self.assertEqual(staged.returncode, 1, staged.stdout)
        self.assertIn("this automation only publishes bytes", staged.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
