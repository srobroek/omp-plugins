# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""readme-draft — write a project README.md from the frozen scaffold facts.

The agent step (draft) reads ONLY the frozen plan answers (project_name, org,
layout, language, framework, resolved stack, license) and emits a single
readme_body answer containing a full Markdown README draft. The gate step
(readme-gate) shows the draft for one-time human review. This python step
(write) writes README.md write-once — it never clobbers a hand-edited README.

Determinism (spec 016 FR-004/FR-005):
  - Same frozen readme_body → byte-identical README.md on every run.
  - reconcile=false: idempotent_write returns skip if the file already exists.

Invoked by the runner as:
    uv run module.py --plan <frozen_plan.json> --step <write> [--inspect]
"""

from __future__ import annotations

import argparse
import importlib.util
import os
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


# Fixed output path — never read from inputs (spec 016 FR-004).
_OUTPUT_PATH = "README.md"


# --------------------------------------------------------------------------- #
# Step handlers                                                                #
# --------------------------------------------------------------------------- #

def _do_write(sdk, inputs, args) -> int:
    """write step: write README.md idempotently (write-once, reconcile=false)."""
    readme_body: str = inputs.get_str("readme_body", default="")
    warnings: list[str] = []

    if not readme_body:
        mode = inputs.mode
        if mode == "init":
            warnings.append(
                "WARN: readme-draft produced no readme_body — the draft agent step "
                "did not run or returned empty; README.md will not be written. "
                "Re-run with --refresh readme-draft to trigger the agent."
            )
        else:
            warnings.append("no readme_body in frozen plan; nothing drafted")
        result = sdk.ModuleResult(
            module_id="readme-draft",
            step_id=args.step,
            status="ok",
            files_written=[],
            diffs=[],
            warnings=warnings,
        )
        sdk.emit_result(result)
        return 0

    # FR-004: reconcile=False means skip if file exists — never clobber.
    diff = sdk.idempotent_write(
        _OUTPUT_PATH,
        readme_body,
        reconcile=False,
        inspect=args.inspect,
    )

    files_written = [diff.path] if diff.kind in ("create", "modify") else []
    result = sdk.ModuleResult(
        module_id="readme-draft",
        step_id=args.step,
        status="ok",
        files_written=files_written,
        diffs=[diff],
        warnings=warnings,
    )
    sdk.emit_result(result)
    return 0


STEP_HANDLERS = {
    "write": _do_write,
    # "draft" is kind=agent    — handled by the runner's Tier-2 agent subsystem.
    # "readme-gate" is kind=gate — handled by the runner's gate subsystem.
}


def main() -> int:
    ap = argparse.ArgumentParser(description="readme-draft module")
    ap.add_argument("--plan", required=True, help="path to the frozen plan.json")
    ap.add_argument("--step", required=True, help="step id to run")
    ap.add_argument("--inspect", action="store_true", help="dry pass: preview, no write")
    args = ap.parse_args()

    handler = STEP_HANDLERS.get(args.step)
    if handler is None:
        print(
            f"Unknown step: {args.step!r}. "
            f"Python-handled steps: {list(STEP_HANDLERS)}. "
            f"Agent/gate steps are dispatched by the runner, not by module.py.",
            file=sys.stderr,
        )
        return 1

    sdk = _load_sdk()
    inputs = sdk.load_frozen_inputs(args.plan, module_id="readme-draft")
    return handler(sdk, inputs, args)


if __name__ == "__main__":
    raise SystemExit(main())
