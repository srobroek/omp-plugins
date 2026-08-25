# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""github-repo — create a GitHub repository and wire the origin remote.

Migrated from the legacy monolith project-setup.sh Step 2 (lines 231-261):
  - Prefer gh-api.py wrapper then plain gh (lines 238-242).
  - gh repo view <org>/<name> exists-check (line 246).
  - gh repo create --private|--public [--description=...] --source . --push=false (lines 252-253).
  - git remote add origin (lines 257-260).

GITHUB_APM_PAT is injected into the gh environment when available (from
`gh auth token`). Tool-missing or command-failure is NON-FATAL: warn and continue.

reconcile=false: re-run does not re-create or re-wire if origin already set.
create_repo=false: skip entirely.

Invoked by the runner as:
    uv run module.py --plan <frozen_plan.json> --step create [--inspect]
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path


def _load_sdk():
    """Load the runner SDK. Fast path: `import sdk` (the executor puts the runner
    dir on PYTHONPATH — spec 005). Fallback: load by file path for direct
    invocation outside the executor (e.g. functional tests)."""
    try:
        import sdk  # noqa: PLC0415
        return sdk
    except ModuleNotFoundError:
        pass
    # Fallback: locate sdk.py by path (PLUGIN_ROOT, or __file__-relative).
    plugin_root = os.environ.get("PLUGIN_ROOT") or os.environ.get("CLAUDE_PLUGIN_ROOT")
    if plugin_root:
        sdk_path = Path(plugin_root) / "runner" / "sdk.py"
        if not sdk_path.is_file():
            sdk_path = Path(plugin_root) / "skills" / "project-setup" / "runner" / "sdk.py"
    else:
        sdk_path = Path(__file__).resolve().parents[3] / "skills" / "project-setup" / "runner" / "sdk.py"
    spec = importlib.util.spec_from_file_location("sdk", sdk_path)
    assert spec and spec.loader, f"cannot locate runner SDK at {sdk_path}"
    mod = importlib.util.module_from_spec(spec)
    sys.modules["sdk"] = mod          # register BEFORE exec_module (the @dataclass(Exception) footgun)
    spec.loader.exec_module(mod)
    return mod
def _gh_cmd() -> list[str] | None:
    """Return the gh command prefix, preferring gh-api.py wrapper (monolith lines 238-242)."""
    if shutil.which("gh-api.py"):
        return ["gh-api.py", "gh"]
    if shutil.which("gh"):
        return ["gh"]
    return None


def _gh_env(base_env: dict) -> dict:
    """Build environment for gh invocations, injecting GITHUB_TOKEN when available."""
    env = dict(base_env)
    # Try to get a token from gh auth token; use it as GITHUB_TOKEN for gh calls.
    if "GITHUB_APM_PAT" in env:
        env.setdefault("GITHUB_TOKEN", env["GITHUB_APM_PAT"])
    elif shutil.which("gh"):
        try:
            proc = subprocess.run(
                ["gh", "auth", "token"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if proc.returncode == 0:
                token = proc.stdout.strip()
                if token:
                    env.setdefault("GITHUB_TOKEN", token)
        except (OSError, subprocess.TimeoutExpired):
            pass
    return env


def main() -> int:
    ap = argparse.ArgumentParser(description="github-repo module")
    ap.add_argument("--plan", required=True, help="path to the frozen plan.json")
    ap.add_argument("--step", required=True, help="step id to run")
    ap.add_argument("--inspect", action="store_true", help="dry pass: preview, no write")
    args = ap.parse_args()

    sdk = _load_sdk()
    inputs = sdk.load_frozen_inputs(args.plan, module_id="github-repo")

    create_repo = inputs.get_bool("create_repo", default=True)
    public = inputs.get_bool("public", default=False)
    org = inputs.get_str("org", default="")
    project_name = inputs.get_str("project_name", default="")
    description = inputs.get_str("description", default="")

    warnings: list[str] = []
    message = ""

    if not create_repo:
        result = sdk.ModuleResult(
            module_id="github-repo",
            step_id=args.step,
            status="ok",
            message="create_repo=false; skipped",
        )
        sdk.emit_result(result)
        return 0

    project_dir_env = os.environ.get("PROJECT_DIR")
    project_dir = Path(project_dir_env).resolve() if project_dir_env else Path.cwd().resolve()

    gh = _gh_cmd()
    if gh is None:
        warnings.append(
            "neither gh-api.py nor gh found on PATH; skipping GitHub repo creation. "
            f"Run 'gh repo create {org}/{project_name} --private --source . --push=false' manually."
        )
        result = sdk.ModuleResult(
            module_id="github-repo",
            step_id=args.step,
            status="ok",
            warnings=warnings,
            message="gh not found; skipped",
        )
        sdk.emit_result(result)
        return 0

    if not org or not project_name:
        warnings.append(
            "org or project_name not provided; skipping GitHub repo creation. "
            "Set org and project_name inputs and rerun."
        )
        result = sdk.ModuleResult(
            module_id="github-repo",
            step_id=args.step,
            status="ok",
            warnings=warnings,
            message="org/project_name missing; skipped",
        )
        sdk.emit_result(result)
        return 0

    repo_full = f"{org}/{project_name}"
    env = _gh_env(dict(os.environ))

    if args.inspect:
        message = f"would create GitHub repo {repo_full}"
        result = sdk.ModuleResult(
            module_id="github-repo",
            step_id=args.step,
            status="ok",
            message=message,
        )
        sdk.emit_result(result)
        return 0

    # Check if repo already exists (monolith line 246)
    view_proc = subprocess.run(
        gh + ["repo", "view", repo_full],
        capture_output=True,
        text=True,
        env=env,
        cwd=str(project_dir),
    )
    if view_proc.returncode == 0:
        message = f"GitHub repo {repo_full} already exists"
    else:
        # Create the repo (monolith lines 252-253)
        visibility = "--public" if public else "--private"
        create_cmd = gh + ["repo", "create", repo_full, visibility, "--source", ".", "--push=false"]
        if description:
            create_cmd.append(f"--description={description}")
        create_proc = subprocess.run(
            create_cmd,
            capture_output=True,
            text=True,
            env=env,
            cwd=str(project_dir),
        )
        if create_proc.returncode != 0:
            warnings.append(
                f"GitHub repo creation failed (exit {create_proc.returncode}): "
                f"{create_proc.stderr.strip()}. "
                f"Create {repo_full} manually."
            )
            message = "repo creation failed; see warnings"
        else:
            message = f"Created GitHub repo {repo_full}"

    # Ensure origin remote is set (monolith lines 257-260)
    remote_proc = subprocess.run(
        ["git", "remote", "get-url", "origin"],
        capture_output=True,
        text=True,
        cwd=str(project_dir),
    )
    if remote_proc.returncode != 0:
        add_proc = subprocess.run(
            ["git", "remote", "add", "origin", f"https://github.com/{repo_full}.git"],
            capture_output=True,
            text=True,
            cwd=str(project_dir),
        )
        if add_proc.returncode != 0:
            warnings.append(
                f"git remote add origin failed: {add_proc.stderr.strip()}. "
                f"Run 'git remote add origin https://github.com/{repo_full}.git' manually."
            )
        else:
            message += "; origin remote added"

    result = sdk.ModuleResult(
        module_id="github-repo",
        step_id=args.step,
        status="ok",
        warnings=warnings,
        message=message,
    )
    sdk.emit_result(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
