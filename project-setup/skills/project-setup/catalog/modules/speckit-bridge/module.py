# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""speckit-bridge — install and initialise speckit.

Modes:
  - none        → skip (no-op).
  - lightweight → ensure specs/ exists.
  - full        → install spec-kit and initialise it.

full-mode install precedence:
  1. If speckit_source is non-empty (the interview froze a marketplace locator),
     install that via apm then delegate to setup-speckit.sh as before.
  2. Otherwise, use PUBLIC spec-kit (github.com/github/spec-kit).
     - speckit_version == "" or "latest" → unpinned: installs the current latest.
     - speckit_version == "vX.Y.Z" → pinned: installs that exact version.
     Command: `uv tool install specify-cli --from <git-url>[@<version>]`
     then `specify init .`.
  3. If neither uv/specify is available nor a marketplace speckit, degrade
     gracefully: emit status=ok with a warning + the manual public command
     (FR-008 non-fatal contract).

Invoked by the runner as:
    uv run module.py --plan <frozen_plan.json> --step setup [--inspect]
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path

# Public spec-kit git source (github.com/github/spec-kit).
# No pin constant — the version is an opt-in per-invocation choice (FR-V1/FR-V2).
# "latest" (or blank) → unpinned install command (resolves current HEAD/release).
# A concrete version string (e.g. "v0.0.61") → pinned install command.
_SPECKIT_GIT = "git+https://github.com/github/spec-kit.git"


def _speckit_ref(version: str) -> str:
    """Return the --from ref for uv tool install.

    "latest" or "" → unpinned (no @tag appended).
    Any other string → pinned as {_SPECKIT_GIT}@{version}.
    """
    if not version or version.lower() == "latest":
        return _SPECKIT_GIT
    return f"{_SPECKIT_GIT}@{version}"


def _speckit_manual_cmd(version: str) -> str:
    """Return the manual install+init command for the given version choice."""
    ref = _speckit_ref(version)
    return f"uv tool install specify-cli --from {ref} && specify init ."


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
    """Try apm via three resolution paths (mirrors apm-install module)."""
    if shutil.which("apm"):
        proc = subprocess.run(
            ["apm"] + args, capture_output=True, text=True, env=env, cwd=cwd
        )
        return proc.returncode, proc.stdout, proc.stderr

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


def _run_cmd(cmd: list[str], env: dict, cwd: str) -> tuple[int, str, str]:
    """Generic subprocess helper; never raises. Returns (rc, stdout, stderr)."""
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, env=env, cwd=cwd
        )
        return proc.returncode, proc.stdout, proc.stderr
    except FileNotFoundError as exc:
        return 127, "", str(exc)
    except Exception as exc:  # noqa: BLE001
        return 1, "", str(exc)


def _install_public_speckit(env: dict, cwd: str, version: str = "latest") -> tuple[bool, str]:
    """Install PUBLIC spec-kit via uv and run `specify init .`.

    version: "latest" or "" → unpinned (current HEAD/release).
             any other string → pinned @version.

    Returns (success: bool, detail: str).
    Degrades gracefully when uv or specify is unavailable.
    """
    if not shutil.which("uv"):
        return False, "uv not found on PATH"

    ref = _speckit_ref(version)
    install_cmd = [
        "uv", "tool", "install", "specify-cli",
        "--from", ref,
    ]
    rc_install, _, stderr_install = _run_cmd(install_cmd, env, cwd)
    if rc_install != 0:
        return False, f"uv tool install failed (exit {rc_install}): {stderr_install.strip()}"

    # After install, specify should be on PATH (uv tool bin dir)
    if not shutil.which("specify"):
        return False, "specify not found on PATH after uv tool install"

    rc_init, _, stderr_init = _run_cmd(["specify", "init", "."], env, cwd)
    if rc_init != 0:
        return False, f"specify init failed (exit {rc_init}): {stderr_init.strip()}"

    return True, ""


def main() -> int:
    ap = argparse.ArgumentParser(description="speckit-bridge module")
    ap.add_argument("--plan", required=True, help="path to the frozen plan.json")
    ap.add_argument("--step", required=True, help="step id to run")
    ap.add_argument("--inspect", action="store_true", help="dry pass: preview, no write")
    args = ap.parse_args()

    sdk = _load_sdk()
    inputs = sdk.load_frozen_inputs(args.plan, module_id="speckit-bridge")

    spec_mode = inputs.get_choice("spec_mode", default="none")
    speckit_source = inputs.get_str("speckit_source", default="")
    speckit_version = inputs.get_str("speckit_version", default="latest")
    # marketplace is read for context but speckit_source is the operative signal
    # (the interview sets speckit_source when it resolves a marketplace locator)

    project_dir_env = os.environ.get("PROJECT_DIR")
    project_dir = Path(project_dir_env).resolve() if project_dir_env else Path.cwd().resolve()
    cwd = str(project_dir)

    env = dict(os.environ)
    warnings: list[str] = []

    if spec_mode == "none":
        result = sdk.ModuleResult(
            module_id="speckit-bridge",
            step_id=args.step,
            status="ok",
            message="spec_mode=none; skipped",
        )
        sdk.emit_result(result)
        return 0

    if spec_mode == "lightweight":
        specs_dir = project_dir / "specs"
        if args.inspect:
            result = sdk.ModuleResult(
                module_id="speckit-bridge",
                step_id=args.step,
                status="ok",
                message="would create specs/ directory",
            )
            sdk.emit_result(result)
            return 0

        specs_dir.mkdir(parents=True, exist_ok=True)
        result = sdk.ModuleResult(
            module_id="speckit-bridge",
            step_id=args.step,
            status="ok",
            message="spec_mode=lightweight; specs/ ensured",
        )
        sdk.emit_result(result)
        return 0

    # spec_mode == "full"
    # --------------------------------------------------------------------- #
    # Path A: user's marketplace provides a speckit package (speckit_source  #
    # non-empty) — install via apm then delegate to setup-speckit.sh.        #
    # --------------------------------------------------------------------- #
    if speckit_source:
        # Check apm is available
        rc_ver, _, _ = _run_apm(["--version"], env, cwd)
        if rc_ver != 0:
            err_dict = {
                "error_code": "MISSING_REQUIRED_TOOL",
                "module_id": "speckit-bridge",
                "module_ids": [],
                "expected": "apm CLI available",
                "received": "apm not found on PATH",
                "how_to_fix": (
                    "Install apm, then rerun with spec_mode=full. "
                    "Alternatively, set spec_mode=lightweight or spec_mode=none."
                ),
            }
            result = sdk.ModuleResult(
                module_id="speckit-bridge",
                step_id=args.step,
                status="error",
                message="spec_mode=full with marketplace speckit requires apm; apm not found",
                error=err_dict,
            )
            sdk.emit_result(result)
            return 0

        if args.inspect:
            result = sdk.ModuleResult(
                module_id="speckit-bridge",
                step_id=args.step,
                status="ok",
                message=(
                    f"would install {speckit_source} via apm "
                    "and run setup-speckit.sh"
                ),
            )
            sdk.emit_result(result)
            return 0

        # Install marketplace speckit package
        rc_install, _, stderr_install = _run_apm(
            ["install", "--target", "claude,codex,agent-skills", speckit_source],
            env,
            cwd,
        )
        if rc_install != 0:
            err_dict = {
                "error_code": "FETCH_FAILED",
                "module_id": "speckit-bridge",
                "module_ids": [],
                "expected": f"successful apm install of {speckit_source}",
                "received": f"exit {rc_install}: {stderr_install.strip()}",
                "how_to_fix": (
                    f"Run 'apm install --target claude,codex,agent-skills {speckit_source}' "
                    "manually, then rerun speckit-bridge."
                ),
            }
            result = sdk.ModuleResult(
                module_id="speckit-bridge",
                step_id=args.step,
                status="error",
                message=f"apm install {speckit_source} failed: {stderr_install.strip()}",
                error=err_dict,
            )
            sdk.emit_result(result)
            return 0

        # Locate setup-speckit.sh under apm_modules
        setup_scripts = list(project_dir.glob("apm_modules/**/speckit-setup/scripts/setup-speckit.sh"))
        if not setup_scripts:
            err_dict = {
                "error_code": "FETCH_FAILED",
                "module_id": "speckit-bridge",
                "module_ids": [],
                "expected": "setup-speckit.sh under apm_modules/*/speckit-setup/scripts/",
                "received": "not found after successful apm install",
                "how_to_fix": (
                    f"Run 'apm install --target claude,codex,agent-skills {speckit_source}' "
                    "and verify setup-speckit.sh exists under apm_modules."
                ),
            }
            result = sdk.ModuleResult(
                module_id="speckit-bridge",
                step_id=args.step,
                status="error",
                message="setup-speckit.sh not found after apm install",
                error=err_dict,
            )
            sdk.emit_result(result)
            return 0

        setup_script = setup_scripts[0]

        # Run setup-speckit.sh
        run_proc = subprocess.run(
            ["bash", str(setup_script), "--script", "sh", "--render-for", "codex,claude"],
            capture_output=True,
            text=True,
            env=env,
            cwd=cwd,
        )
        if run_proc.returncode != 0:
            warnings.append(
                f"setup-speckit.sh failed (exit {run_proc.returncode}): "
                f"{run_proc.stderr.strip()}. "
                "Run 'bash setup-speckit.sh --script sh --render-for codex,claude' manually."
            )

        result = sdk.ModuleResult(
            module_id="speckit-bridge",
            step_id=args.step,
            status="ok",
            warnings=warnings,
            message="speckit setup completed" if not warnings else "speckit setup completed with warnings",
        )
        sdk.emit_result(result)
        return 0

    # --------------------------------------------------------------------- #
    # Path B: no marketplace speckit — use PUBLIC spec-kit (default).        #
    # speckit_version controls pinning: "latest"/""=unpinned, else pinned.   #
    # --------------------------------------------------------------------- #
    version_label = speckit_version if speckit_version and speckit_version.lower() != "latest" else "latest"
    manual_cmd = _speckit_manual_cmd(speckit_version)

    if args.inspect:
        result = sdk.ModuleResult(
            module_id="speckit-bridge",
            step_id=args.step,
            status="ok",
            message=(
                f"would install public spec-kit ({version_label}) via: {manual_cmd}"
            ),
        )
        sdk.emit_result(result)
        return 0

    success, detail = _install_public_speckit(env, cwd, version=speckit_version)
    if not success:
        # Graceful degrade (FR-008): warn + manual command, non-fatal
        warnings.append(
            f"Public spec-kit install skipped ({detail}). "
            f"To set up spec-kit manually: {manual_cmd}"
        )
        result = sdk.ModuleResult(
            module_id="speckit-bridge",
            step_id=args.step,
            status="ok",
            warnings=warnings,
            message="speckit setup skipped (tool unavailable); see warnings for manual command",
        )
        sdk.emit_result(result)
        return 0

    result = sdk.ModuleResult(
        module_id="speckit-bridge",
        step_id=args.step,
        status="ok",
        warnings=warnings,
        message=f"speckit setup completed via public spec-kit ({version_label})",
    )
    sdk.emit_result(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
