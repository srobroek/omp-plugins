# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""apm-install — install APM package primitives and compile steering.

Migrated from the legacy monolith project-setup.sh Step 10b (lines 998-1073):
  - run_apm helper: apm | mise exec -- apm | uv tool run --from apm-cli apm
    (monolith lines 103-112).
  - apm install --target claude,codex,agent-skills <packages> (lines 1026-1031).
  - apm compile --target codex --no-constitution (lines 1034-1044).
  - patch/audit best-effort (lines 1047-1073).

Pure consumer of frozen answers: installs ONLY packages the user supplied, from
the marketplace the user selected. Empty package list = clean no-op (nothing
installed, status ok). No baseline packages are appended automatically.

apm-missing is NON-FATAL: warn + echo the manual command.

Invoked by the runner as:
    uv run module.py --plan <frozen_plan.json> --step install [--inspect]
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
def _run_apm(args: list[str], env: dict, cwd: str) -> tuple[int, str, str]:
    """Try apm via three resolution paths (monolith lines 103-112).

    Returns (returncode, stdout, stderr). Returns (127, "", "apm not found")
    if none of the paths succeed.
    """
    # Path 1: apm directly on PATH
    if shutil.which("apm"):
        proc = subprocess.run(
            ["apm"] + args, capture_output=True, text=True, env=env, cwd=cwd
        )
        return proc.returncode, proc.stdout, proc.stderr

    # Path 2: mise exec -- apm
    if shutil.which("mise"):
        check = subprocess.run(
            ["mise", "which", "apm"], capture_output=True, text=True, env=env, cwd=cwd
        )
        if check.returncode == 0:
            proc = subprocess.run(
                ["mise", "exec", "--", "apm"] + args,
                capture_output=True,
                text=True,
                env=env,
                cwd=cwd,
            )
            return proc.returncode, proc.stdout, proc.stderr

    # Path 3: uv tool run --from apm-cli apm
    if shutil.which("uv"):
        proc = subprocess.run(
            ["uv", "tool", "run", "--from", "apm-cli", "apm"] + args,
            capture_output=True,
            text=True,
            env=env,
            cwd=cwd,
        )
        return proc.returncode, proc.stdout, proc.stderr

    return 127, "", "apm not found"


def _apm_available(env: dict, cwd: str) -> bool:
    rc, _, _ = _run_apm(["--version"], env, cwd)
    return rc == 0


def main() -> int:
    ap = argparse.ArgumentParser(description="apm-install module")
    ap.add_argument("--plan", required=True, help="path to the frozen plan.json")
    ap.add_argument("--step", required=True, help="step id to run")
    ap.add_argument("--inspect", action="store_true", help="dry pass: preview, no write")
    args = ap.parse_args()

    sdk = _load_sdk()
    inputs = sdk.load_frozen_inputs(args.plan, module_id="apm-install")

    agentic_packages = inputs.get_str("agentic_packages", default="")
    marketplace = inputs.get_str("marketplace", default="")
    compile_claude = inputs.get_bool("compile_claude", default=True)

    project_dir_env = os.environ.get("PROJECT_DIR")
    project_dir = Path(project_dir_env).resolve() if project_dir_env else Path.cwd().resolve()
    cwd = str(project_dir)

    # Build environment — inject GITHUB_APM_PAT from gh auth token when available
    env = dict(os.environ)
    if shutil.which("gh"):
        try:
            tok_proc = subprocess.run(
                ["gh", "auth", "token"], capture_output=True, text=True, timeout=5
            )
            if tok_proc.returncode == 0:
                token = tok_proc.stdout.strip()
                if token:
                    env.setdefault("GITHUB_APM_PAT", token)
        except (OSError, subprocess.TimeoutExpired):
            pass

    warnings: list[str] = []
    messages: list[str] = []

    # Compose package list: ONLY what the user supplied (no baseline appended)
    packages = [p for p in [agentic_packages] if p.strip()]

    install_cmd_str = (
        f"apm install --target claude,codex,agent-skills {' '.join(packages)}"
        if packages else "apm install (no packages selected)"
    )

    # PRIMARY precondition: packages must be non-empty (FR-004/SC-003)
    if not packages:
        result = sdk.ModuleResult(
            module_id="apm-install",
            step_id=args.step,
            status="ok",
            message="no APM packages selected; nothing to install",
        )
        sdk.emit_result(result)
        return 0

    if args.inspect:
        result = sdk.ModuleResult(
            module_id="apm-install",
            step_id=args.step,
            status="ok",
            message=f"would run: {install_cmd_str}",
        )
        sdk.emit_result(result)
        return 0

    # SECONDARY precondition: apm binary must be available (FR-005)
    if not _apm_available(env, cwd):
        warnings.append(
            f"apm not found; run manually: {install_cmd_str}"
        )
        result = sdk.ModuleResult(
            module_id="apm-install",
            step_id=args.step,
            status="ok",
            warnings=warnings,
            message="apm not available; skipped",
        )
        sdk.emit_result(result)
        return 0

    # Step 1: apm install (monolith lines 1026-1031)
    rc, _, stderr = _run_apm(
        ["install", "--target", "claude,codex,agent-skills"] + packages,
        env,
        cwd,
    )
    if rc != 0:
        warnings.append(
            f"apm install failed (exit {rc}): {stderr.strip()}. "
            f"Run manually: {install_cmd_str}"
        )
    else:
        messages.append("apm install completed")

    # Step 2: apm compile --target codex --no-constitution (monolith lines 1034-1044)
    rc_codex, _, stderr_codex = _run_apm(
        ["compile", "--target", "codex", "--no-constitution"], env, cwd
    )
    if rc_codex != 0:
        warnings.append(
            f"apm compile --target codex failed (exit {rc_codex}): {stderr_codex.strip()}. "
            "Run 'apm compile --target codex --no-constitution' manually."
        )
    else:
        messages.append("apm compile (codex) completed")

    if compile_claude:
        rc_claude, _, stderr_claude = _run_apm(
            ["compile", "--target", "claude", "--no-constitution"], env, cwd
        )
        if rc_claude != 0:
            warnings.append(
                f"apm compile --target claude failed (exit {rc_claude}): {stderr_claude.strip()}. "
                "Run 'apm compile --target claude --no-constitution' manually."
            )
        else:
            messages.append("apm compile (claude) completed")

    # Step 3: patch/audit best-effort (monolith lines 1047-1073)
    # patch-agentic-tools
    rc_list, list_out, _ = _run_apm(["list"], env, cwd)
    if rc_list == 0 and "patch-agentic-tools" in list_out:
        rc_patch, _, stderr_patch = _run_apm(["run", "patch-agentic-tools"], env, cwd)
        if rc_patch != 0:
            warnings.append(
                f"patch-agentic-tools failed (exit {rc_patch}): {stderr_patch.strip()}"
            )
        else:
            messages.append("patch-agentic-tools completed")
    else:
        # Try fallback patch script
        patch_scripts = list(project_dir.glob("apm_modules/**/scripts/patch-runtime-agents.py"))
        if patch_scripts:
            py_proc = subprocess.run(
                [sys.executable, str(patch_scripts[0]), "--all"],
                capture_output=True,
                text=True,
                env=env,
                cwd=cwd,
            )
            if py_proc.returncode != 0:
                warnings.append(
                    f"patch-runtime-agents.py failed: {py_proc.stderr.strip()}"
                )
            else:
                messages.append("patch-runtime-agents.py completed")
        else:
            warnings.append("patch-runtime-agents.py not found under apm_modules")

    # audit-agentic-tools
    rc_list2, list_out2, _ = _run_apm(["list"], env, cwd)
    if rc_list2 == 0 and "audit-agentic-tools" in list_out2:
        rc_audit, _, stderr_audit = _run_apm(["run", "audit-agentic-tools"], env, cwd)
        if rc_audit != 0:
            warnings.append(
                f"audit-agentic-tools failed (exit {rc_audit}): {stderr_audit.strip()}"
            )
        else:
            messages.append("audit-agentic-tools completed")
    else:
        audit_scripts = list(project_dir.glob("apm_modules/**/scripts/audit-agentic-assets.py"))
        if audit_scripts:
            au_proc = subprocess.run(
                [sys.executable, str(audit_scripts[0])],
                capture_output=True,
                text=True,
                env=env,
                cwd=cwd,
            )
            if au_proc.returncode != 0:
                warnings.append(
                    f"audit-agentic-assets.py failed: {au_proc.stderr.strip()}"
                )
            else:
                messages.append("audit-agentic-assets.py completed")
        else:
            warnings.append("audit-agentic-assets.py not found under apm_modules")

    result = sdk.ModuleResult(
        module_id="apm-install",
        step_id=args.step,
        status="ok",
        warnings=warnings,
        message="; ".join(messages) if messages else "apm-install completed",
    )
    sdk.emit_result(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
