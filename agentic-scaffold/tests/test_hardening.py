from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import yaml
from conftest import git_root

ROOT = Path(__file__).parents[1]
CLI = ROOT / "skills/agentic-scaffold/scripts/scaffold.py"
DEFAULTS = "purpose,kind,language,license,beads,publish,docs_flavour,github_owner,conduct_contact"


def render(tmp_path: Path, profile: str, *sets: str) -> Path:
    root = git_root(tmp_path / profile)
    args = [sys.executable, str(CLI), "answers", "write", "--root", str(root), "--profile", profile, "--set", "name=demo", "--defaults-for", DEFAULTS]
    for item in sets:
        args += ["--set", item]
    written = subprocess.run(args, text=True, capture_output=True, check=False)
    assert written.returncode == 0, written.stdout + written.stderr
    rendered = subprocess.run([sys.executable, str(CLI), "apply", "--root", str(root), "--stage", "render"], text=True, capture_output=True, check=False)
    assert rendered.returncode == 0, rendered.stdout + rendered.stderr
    return root


def workflow(root: Path, name: str) -> dict:
    return yaml.safe_load((root / ".github/workflows" / name).read_text())


def step_names(job: dict) -> list[str]:
    return [str(step.get("name") or step.get("uses") or step.get("run", ""))[:60] for step in job["steps"]]


def test_every_action_pin_is_a_full_sha_with_a_version_comment() -> None:
    source = (ROOT / "skills/agentic-scaffold/scripts/scaffold.py").read_text()
    table = source[source.index("ACTIONS = {") : source.index("}", source.index("ACTIONS = {"))]
    pins = re.findall(r'"([^"]+@[0-9a-f]+) # ([^"]+)"', table)
    assert pins, "the pin table is empty"
    for pin, comment in pins:
        sha = pin.rsplit("@", 1)[1]
        assert len(sha) == 40, pin
        assert re.match(r"^(v|action-v|codeql-bundle-v)\d", comment), (pin, comment)


def test_release_publishes_only_verified_artifacts(tmp_path: Path) -> None:
    for profile in ("python-lib", "rust-lib", "ts-lib", "go-lib"):
        root = render(tmp_path, profile)
        text = (root / ".github/workflows/release.yml").read_text()
        doc = workflow(root, "release.yml")
        assert doc["permissions"] == {}, profile
        assert "attest-build-provenance" in text and "attest-sbom" in text and "gh attestation verify" in text, profile
        verify_at = text.index("gh attestation verify")
        publish_jobs = [name for name in doc["jobs"] if name.startswith("publish")]
        for name in publish_jobs:
            assert text.index(f"  {name}:") > verify_at, (profile, name)
        for name, job in doc["jobs"].items():
            if name.startswith("publish") or name == "build":
                assert "ACTIONS_CACHE_MODE" in json.dumps(job.get("env", {})), (profile, name)


def test_tauri_release_builds_signs_attests_then_uploads(tmp_path: Path) -> None:
    root = render(tmp_path, "tauri-desktop", "bts=false")
    doc = workflow(root, "release.yml")
    build = doc["jobs"]["build-tauri"]
    targets = [item["target"] for item in build["strategy"]["matrix"]["include"]]
    assert targets == ["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"]
    names = step_names(build)
    order = [names.index(n) for n in ("Require the signing inputs", "Build and sign Tauri bundles", "Attest build provenance", "Verify attestations before publish", "Upload the verified bundles to the release")]
    assert order == sorted(order)
    tauri_step = next(step for step in build["steps"] if step.get("id") == "tauri")
    assert "tagName" not in tauri_step["with"] and "releaseDraft" not in tauri_step["with"]
    assert build["env"]["TAURI_SIGNING_PRIVATE_KEY"] == "${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}"
    updater = doc["jobs"]["publish-updater"]
    assert updater["needs"] == ["release-gate", "build-tauri"] and "latest.json" in json.dumps(updater)
    assert not (root / ".github/workflows/tap-bump.yml").exists()
    with_tap = render(tmp_path / "tap", "tauri-desktop", "bts=false", "tap_bump=true")
    assert (with_tap / ".github/workflows/tap-bump.yml").is_file()
    tap_text = (with_tap / ".github/workflows/tap-bump.yml").read_text()
    assert "RELEASE_APP_PRIVATE_KEY" in tap_text and "Casks/demo.rb" in tap_text and "bucket/demo.json" in tap_text


def test_codeql_lane_joins_the_gate_and_skips_rust(tmp_path: Path) -> None:
    root = render(tmp_path, "python-lib", "ci_codeql=true")
    doc = workflow(root, "ci.yml")
    assert "codeql" in doc["jobs"] and "codeql" in doc["jobs"]["gate"]["needs"]
    assert doc["jobs"]["codeql"]["permissions"]["security-events"] == "write"
    plain = workflow(render(tmp_path / "plain", "python-lib"), "ci.yml")
    assert "codeql" not in plain["jobs"]
    rust = workflow(render(tmp_path / "rust", "rust-lib", "ci_codeql=true"), "ci.yml")
    assert "codeql" not in rust["jobs"]


def test_harden_runner_is_the_first_step_of_every_job_when_enabled(tmp_path: Path) -> None:
    root = render(tmp_path, "python-lib", "ci_harden_runner=true")
    for name in ("ci.yml", "release.yml"):
        for job_name, job in workflow(root, name)["jobs"].items():
            if "steps" not in job:
                continue
            first = job["steps"][0]
            assert "step-security/harden-runner" in str(first.get("uses", "")), (name, job_name)
            assert first["with"]["egress-policy"] == "audit"
    plain = workflow(render(tmp_path / "plain", "python-lib"), "ci.yml")
    assert "harden-runner" not in json.dumps(plain)
