# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""core-identity — capture project identity answers.

This module has NO filesystem work. It exists as the upstream anchor that all
other modules declare in requires=[]. Its single step "record" is a no-op
confirmation: it validates that the frozen inputs are readable and emits a
ModuleResult with files_written=[].

Design note: the runner persists user answers itself from the frozen plan; this
module does NOT re-emit them in answers_to_persist (that would be redundant and
could confuse provenance tracking). The step is present because the contract
requires [[steps]] to be non-empty, and because downstream modules need
requires=["core-identity"] to be resolvable.

Invoked by the runner as:
    uv run module.py --plan <frozen_plan.json> --step record [--inspect]
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
        sdk_path = Path(__file__).resolve().parents[2] / "runner" / "sdk.py"
    spec = importlib.util.spec_from_file_location("sdk", sdk_path)
    assert spec and spec.loader, f"cannot locate runner SDK at {sdk_path}"
    mod = importlib.util.module_from_spec(spec)
    sys.modules["sdk"] = mod          # register BEFORE exec_module (the @dataclass(Exception) footgun)
    spec.loader.exec_module(mod)
    return mod
def main() -> int:
    ap = argparse.ArgumentParser(description="core-identity module")
    ap.add_argument("--plan", required=True, help="path to the frozen plan.json")
    ap.add_argument("--step", required=True, help="step id to run")
    ap.add_argument("--inspect", action="store_true", help="dry pass: preview, no write")
    args = ap.parse_args()

    sdk = _load_sdk()
    # Validate that the frozen plan contains our section and inputs are loadable.
    sdk.load_frozen_inputs(args.plan, module_id="core-identity")

    # No filesystem work. Emit a zero-write result. The runner has already
    # persisted the user answers from the frozen plan before invoking this step.
    result = sdk.ModuleResult(
        module_id="core-identity",
        step_id=args.step,
        status="ok",
        files_written=[],
        diffs=[],
    )
    sdk.emit_result(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
