# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""precommit-setup — scaffold .pre-commit-config.yaml and vendor close-keywords scripts.

Migrated from the legacy monolith project-setup.sh Step 5 (lines 370–434) and
Step 5b (lines 439–461). The .pre-commit-config.yaml is vendored verbatim into
templates/pre-commit-config.yaml; the close-keywords scripts are vendored into
templates/close-keywords/ and written into the project's .pre-commit-hooks/.

reconcile=true: on re-run the config is overwritten to match the template, and
.pre-commit-hooks/ scripts are updated. This mirrors the "always up-to-date"
intent of the framework.

NOTE: `pre-commit install` is NOT run here (it requires the pre-commit binary and
is a side-effect beyond deterministic file scaffolding). The runner or agent must
run it afterward:
    pre-commit install -t pre-commit -t pre-push -t commit-msg

Invoked by the runner as:
    uv run module.py --plan <frozen_plan.json> --step write [--inspect]
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import stat
import sys
from pathlib import Path

_TEMPLATES = Path(__file__).resolve().parent / "templates"
_CLOSE_KEYWORDS_TEMPLATES = _TEMPLATES / "close-keywords"
_PRECOMMIT_CONFIG_TEMPLATE = _TEMPLATES / "pre-commit-config.yaml"


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
def _make_executable(path: Path) -> None:
    """chmod +x *path* (add owner/group/other execute bits)."""
    current = path.stat().st_mode
    path.chmod(current | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def main() -> int:
    ap = argparse.ArgumentParser(description="precommit-setup module")
    ap.add_argument("--plan", required=True, help="path to the frozen plan.json")
    ap.add_argument("--step", required=True, help="step id to run")
    ap.add_argument("--inspect", action="store_true", help="dry pass: preview, no write")
    args = ap.parse_args()

    sdk = _load_sdk()
    sdk.load_frozen_inputs(args.plan, module_id="precommit-setup")

    diffs = []
    files_written = []
    warnings = []

    # ── 1. Write .pre-commit-config.yaml ─────────────────────────────────── #
    config_body = _PRECOMMIT_CONFIG_TEMPLATE.read_text(encoding="utf-8")
    diff = sdk.idempotent_write(
        ".pre-commit-config.yaml",
        config_body,
        reconcile=True,
        inspect=args.inspect,
    )
    diffs.append(diff)
    if diff.kind in ("create", "modify"):
        files_written.append(diff.path)

    # ── 2. Vendor close-keywords scripts into .pre-commit-hooks/ ─────────── #
    # The .pre-commit-config.yaml references .pre-commit-hooks/commit-msg-rewrite.sh
    # (a local hook). We vendor a committed copy of both scripts from
    # templates/close-keywords/ so the repo is self-contained.
    for script_name in ("commit-msg-rewrite.sh", "normalize-closes.sh"):
        src = _CLOSE_KEYWORDS_TEMPLATES / script_name
        if not src.is_file():
            warnings.append(
                f"close-keywords template not found: {src}; "
                f".pre-commit-hooks/{script_name} was NOT written. "
                f"The normalize-close-keywords commit-msg hook will fail until "
                f".pre-commit-hooks/commit-msg-rewrite.sh exists."
            )
            continue

        dest_rel = f".pre-commit-hooks/{script_name}"
        script_body = src.read_bytes()
        diff = sdk.idempotent_write(
            dest_rel,
            script_body,
            reconcile=True,
            inspect=args.inspect,
        )
        diffs.append(diff)
        if diff.kind in ("create", "modify"):
            files_written.append(diff.path)
            # chmod +x only when we actually wrote (not inspect)
            if not args.inspect:
                project_dir_env = os.environ.get("PROJECT_DIR")
                project_dir = Path(project_dir_env) if project_dir_env else Path.cwd()
                abs_dest = project_dir / dest_rel
                if abs_dest.exists():
                    _make_executable(abs_dest)

    result = sdk.ModuleResult(
        module_id="precommit-setup",
        step_id=args.step,
        status="ok",
        files_written=files_written,
        diffs=diffs,
        warnings=warnings,
    )
    sdk.emit_result(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
