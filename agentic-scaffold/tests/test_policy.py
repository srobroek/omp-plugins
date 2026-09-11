from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parents[1]
CLI = ROOT / "skills/agentic-scaffold/scripts/scaffold.py"


def git_root(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)
    return path


def test_policy_dry_run_github_remote_does_not_send(tmp_path: Path) -> None:
    root = git_root(tmp_path / "repo")
    subprocess.run(["git", "remote", "add", "origin", "https://github.com/acme/demo.git"], cwd=root, check=True)
    log = tmp_path / "gh.log"
    fake = tmp_path / "gh"
    fake.write_text(f"#!/bin/sh\nprintf '%s\\n' \"$*\" >> {log!s}\nif [ \"$1\" = auth ]; then exit 0; fi\nprintf '%s' '{{\"delete_branch_on_merge\":false}}'\n")
    fake.chmod(0o755)
    env = {**os.environ, "PATH": f"{tmp_path}:{os.environ['PATH']}"}
    result = subprocess.run([sys.executable, str(CLI), "policy", "apply", "--root", str(root), "--dry-run"], capture_output=True, text=True, env=env)
    assert result.returncode == 0, result.stderr
    output = json.loads(result.stdout)
    assert output["plan"]
    assert not log.read_text().splitlines()[-1:] or all("--method" not in line for line in log.read_text().splitlines())


def test_policy_refuses_non_github_remote(tmp_path: Path) -> None:
    root = git_root(tmp_path / "repo")
    subprocess.run(["git", "remote", "add", "origin", "https://gitlab.com/acme/demo.git"], cwd=root, check=True)
    result = subprocess.run([sys.executable, str(CLI), "policy", "apply", "--root", str(root), "--dry-run"], capture_output=True, text=True)
    assert result.returncode != 0
    assert "github.com" in result.stdout


def test_cla_and_mpl_license_render(tmp_path: Path) -> None:
    root = git_root(tmp_path / "repo")
    result = subprocess.run([sys.executable, str(CLI), "render", "--root", str(root), "--profile", "agentic-repo", "--name", "demo", "--layer", "github", "--var", "cla=true", "--var", "license=mpl-2.0", "--var", "github_owner=acme"], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert (root / "CLA.md").is_file()
    assert (root / ".github/workflows/cla.yml").is_file()
    assert "Mozilla Public License" in (root / "LICENSE").read_text()
