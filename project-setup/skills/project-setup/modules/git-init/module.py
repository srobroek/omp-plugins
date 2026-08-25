# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""git-init — run git init and clear macOS provenance xattr on .git/.

Migrated from the legacy monolith project-setup.sh:
  - Codex read-only preflight (lines 114-138): if .git/.codex/.agents exist and
    are NOT writable, emit status="error" with the escalation how_to_fix instead
    of raising or exiting.
  - git init (lines ~210-228): only when no .git present.
  - xattr clear (lines 362-368): sudo -n xattr -c -r .git/ best-effort; warn on failure.

reconcile=false: re-run does nothing (git already initialised).
init_git=false: skip entirely.

Invoked by the runner as:
    uv run module.py --plan <frozen_plan.json> --step init [--inspect]
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
        sdk_path = Path(__file__).resolve().parents[2] / "runner" / "sdk.py"
    spec = importlib.util.spec_from_file_location("sdk", sdk_path)
    assert spec and spec.loader, f"cannot locate runner SDK at {sdk_path}"
    mod = importlib.util.module_from_spec(spec)
    sys.modules["sdk"] = mod          # register BEFORE exec_module (the @dataclass(Exception) footgun)
    spec.loader.exec_module(mod)
    return mod
def _codex_preflight_check(project_dir: Path) -> str | None:
    """Return an error message if any protected bootstrap path is non-writable.

    Ports the fail_if_codex_protected_paths_are_readonly check (monolith lines
    114-138) but returns the error instead of exiting so the runner can emit a
    structured result rather than killing the pipeline.
    """
    blocked = []
    for name in (".git", ".codex", ".agents"):
        p = project_dir / name
        if p.exists() and not os.access(str(p), os.W_OK):
            blocked.append(name)
    if not blocked:
        return None
    paths_str = ", ".join(blocked)
    return (
        f"project setup cannot write protected bootstrap paths: {paths_str}. "
        "Codex workspace-write protects .git, .codex, and .agents as read-only. "
        "Rerun this exact setup executor outside the sandbox with approval: "
        'sandbox_permissions = "require_escalated". '
        "Use a justification that project setup writes protected bootstrap paths."
    )


def _do_commit(sdk, inputs, args, project_dir: Path) -> int:
    """Run the 'commit' step: create an initial scaffold commit.

    Gate: only runs when init_git=true AND initial_commit=true.
    Non-fatal on failure: emits a warning and exits 0.
    """
    init_git = inputs.get_bool("init_git", default=True)
    initial_commit = inputs.get_bool("initial_commit", default=False)

    warnings: list[str] = []

    if not init_git or not initial_commit:
        result = sdk.ModuleResult(
            module_id="git-init",
            step_id=args.step,
            status="ok",
            files_written=[],
            message="initial_commit skipped (init_git=false or initial_commit=false)",
        )
        sdk.emit_result(result)
        return 0

    if args.inspect:
        result = sdk.ModuleResult(
            module_id="git-init",
            step_id=args.step,
            status="ok",
            files_written=[],
            diffs=[],
            message="--inspect: would run git add -A && git commit",
        )
        sdk.emit_result(result)
        return 0

    git_bin = shutil.which("git")
    if git_bin is None:
        result = sdk.ModuleResult(
            module_id="git-init",
            step_id=args.step,
            status="ok",
            files_written=[],
            warnings=["git not found on PATH; skipping initial commit. Run 'git add -A && git commit' manually."],
        )
        sdk.emit_result(result)
        return 0

    # Ensure .git exists before attempting a commit.
    if not (project_dir / ".git").exists():
        result = sdk.ModuleResult(
            module_id="git-init",
            step_id=args.step,
            status="ok",
            files_written=[],
            warnings=["no .git directory found; skipping initial commit. Run 'git init' then commit manually."],
        )
        sdk.emit_result(result)
        return 0

    # Provide a fallback identity so the commit doesn't fail in fresh/CI
    # environments where user.name/email haven't been configured.
    _GIT_ID_FLAGS = [
        "-c", "user.name=project-setup",
        "-c", "user.email=project-setup@localhost",
    ]

    # Stage everything.
    add_proc = subprocess.run(
        ["git"] + _GIT_ID_FLAGS + ["add", "-A"],
        capture_output=True,
        text=True,
        cwd=str(project_dir),
    )
    if add_proc.returncode != 0:
        warnings.append(
            f"git add -A failed (exit {add_proc.returncode}): {add_proc.stderr.strip()}. "
            "Run 'git add -A && git commit' manually."
        )
        result = sdk.ModuleResult(
            module_id="git-init",
            step_id=args.step,
            status="ok",
            files_written=[],
            warnings=warnings,
        )
        sdk.emit_result(result)
        return 0

    commit_proc = subprocess.run(
        ["git"] + _GIT_ID_FLAGS + [
            "commit", "-m", "Initial project scaffold (project-setup)",
        ],
        capture_output=True,
        text=True,
        cwd=str(project_dir),
    )
    if commit_proc.returncode != 0:
        stderr_text = commit_proc.stderr.strip() or commit_proc.stdout.strip()
        warnings.append(
            f"git commit failed (exit {commit_proc.returncode}): {stderr_text}. "
            "Run 'git commit' manually after reviewing staged files."
        )
        result = sdk.ModuleResult(
            module_id="git-init",
            step_id=args.step,
            status="ok",
            files_written=[],
            warnings=warnings,
        )
        sdk.emit_result(result)
        return 0

    result = sdk.ModuleResult(
        module_id="git-init",
        step_id=args.step,
        status="ok",
        files_written=[],
        warnings=warnings,
        message="Initial scaffold committed.",
    )
    sdk.emit_result(result)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="git-init module")
    ap.add_argument("--plan", required=True, help="path to the frozen plan.json")
    ap.add_argument("--step", required=True, help="step id to run")
    ap.add_argument("--inspect", action="store_true", help="dry pass: preview, no write")
    args = ap.parse_args()

    sdk = _load_sdk()
    inputs = sdk.load_frozen_inputs(args.plan, module_id="git-init")

    project_dir_env = os.environ.get("PROJECT_DIR")
    project_dir = Path(project_dir_env).resolve() if project_dir_env else Path.cwd().resolve()

    if args.step == "commit":
        return _do_commit(sdk, inputs, args, project_dir)

    init_git = inputs.get_bool("init_git", default=True)

    warnings: list[str] = []
    message = ""

    if not init_git:
        result = sdk.ModuleResult(
            module_id="git-init",
            step_id=args.step,
            status="ok",
            message="init_git=false; skipped",
        )
        sdk.emit_result(result)
        return 0

    # Codex read-only preflight (monolith lines 114-138).
    # Must run BEFORE any writes; emit error result (not raise) if blocked.
    preflight_err = _codex_preflight_check(project_dir)
    if preflight_err is not None:
        err_dict = {
            "error_code": "MISSING_REQUIRED_TOOL",
            "module_id": "git-init",
            "module_ids": [],
            "expected": "writable .git/.codex/.agents paths",
            "received": "read-only protected paths detected",
            "how_to_fix": (
                'Rerun outside the Codex sandbox with sandbox_permissions = "require_escalated". '
                "Use a justification that project setup writes protected bootstrap paths."
            ),
        }
        result = sdk.ModuleResult(
            module_id="git-init",
            step_id=args.step,
            status="error",
            message=preflight_err,
            error=err_dict,
        )
        sdk.emit_result(result)
        return 0

    git_dir = project_dir / ".git"
    files_written: list[str] = []

    if git_dir.exists():
        message = ".git already exists; skipping git init"
    elif args.inspect:
        message = "would run: git init"
        files_written.append(".git/")
    else:
        # Run git init (monolith ~lines 210-228)
        git_bin = shutil.which("git")
        if git_bin is None:
            warnings.append(
                "git not found on PATH; skipping git init. "
                "Install git and rerun, or run 'git init' manually."
            )
        else:
            proc = subprocess.run(
                ["git", "init"],
                capture_output=True,
                text=True,
                cwd=str(project_dir),
            )
            if proc.returncode != 0:
                warnings.append(
                    f"git init failed (exit {proc.returncode}): {proc.stderr.strip()}. "
                    "Run 'git init' manually."
                )
            else:
                files_written.append(".git/")
                message = "git init completed"

                # Clear macOS provenance xattr (monolith lines 362-368).
                # Best-effort: warn on failure, never raise.
                xattr_bin = shutil.which("xattr")
                if xattr_bin is not None and (project_dir / ".git").exists():
                    xattr_proc = subprocess.run(
                        ["sudo", "-n", "xattr", "-c", "-r", ".git/"],
                        capture_output=True,
                        text=True,
                        cwd=str(project_dir),
                    )
                    if xattr_proc.returncode != 0:
                        warnings.append(
                            "xattr clear failed — run 'sudo xattr -c -r .git/' manually "
                            "if worktree git operations fail"
                        )

    result = sdk.ModuleResult(
        module_id="git-init",
        step_id=args.step,
        status="ok",
        files_written=files_written,
        warnings=warnings,
        message=message,
    )
    sdk.emit_result(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
