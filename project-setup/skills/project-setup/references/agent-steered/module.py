# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""agent-steered — demonstrator module with one python step + one agent step.

Shows the Tier-1/Tier-2 split: module.py handles ONLY the python steps.
The agent step (id="draft-readme", kind="agent") is declared in module.toml
but is handed to the runner's Tier-2 agent subsystem — module.py never
receives --step draft-readme.

Steps:
  scaffold      (python) — writes an empty docs/ directory sentinel
  draft-readme  (agent)  — runner delegates to a Tier-2 LLM agent using
                           steering/decide.md as the agent brief

Invocation contract: --plan <frozen_plan.json> --step scaffold [--inspect]
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
    # Fallback: locate sdk.py by path (PLUGIN_ROOT / CLAUDE_PLUGIN_ROOT, or __file__-relative).
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
def _do_scaffold(sdk, inputs, args) -> int:
    """scaffold step: write a docs/.gitkeep sentinel (Tier-1, deterministic)."""
    diff = sdk.idempotent_write(
        "docs/.gitkeep",
        "",
        reconcile=False,
        inspect=args.inspect,
    )
    files_written = [diff.path] if diff.kind in ("create", "modify") else []
    sdk.emit_result(sdk.ModuleResult(
        module_id="agent-steered",
        step_id=args.step,
        status="ok",
        files_written=files_written,
        diffs=[diff],
    ))
    return 0


STEP_HANDLERS = {
    "scaffold": _do_scaffold,
    # "draft-readme" is intentionally absent: it is kind=agent and is handled
    # by the runner's Tier-2 agent subsystem, not by this script.
}


def main() -> int:
    ap = argparse.ArgumentParser(description="agent-steered example module")
    ap.add_argument("--plan", required=True)
    ap.add_argument("--step", required=True)
    ap.add_argument("--inspect", action="store_true")
    args = ap.parse_args()

    handler = STEP_HANDLERS.get(args.step)
    if handler is None:
        # Graceful: unknown step (including agent steps routed here by mistake)
        print(
            f"Unknown step: {args.step!r}. "
            f"Python-handled steps: {list(STEP_HANDLERS)}. "
            f"Agent steps are dispatched by the runner, not by module.py.",
            file=sys.stderr,
        )
        return 1

    sdk = _load_sdk()
    inputs = sdk.load_frozen_inputs(args.plan, module_id="agent-steered")
    return handler(sdk, inputs, args)


if __name__ == "__main__":
    raise SystemExit(main())
