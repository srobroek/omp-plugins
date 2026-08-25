# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""org-policy — apply org-mandated convention overrides to frozen scaffold answers.

The agent step (resolve) reads the frozen plan answers and an optional org policy
manifest (provided by the fetched org source). It emits an `overrides` list: each
entry is {key, user_value, mandated_value, reason}. A zero-length list is valid.

The gate step (overrides) shows the override table for one-time human review.

This python step (apply) applies ONLY the listed overrides to the frozen answers
via answers_to_persist. It never touches answers not listed by the org policy.

Determinism (spec 014 FR-010):
  - Reproduce replays the frozen `overrides` list with zero network.
  - reconcile=false: applied once at init; --refresh org-policy re-invokes the agent.

Invoked by the runner as:
    uv run module.py --plan <frozen_plan.json> --step <apply> [--inspect]
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import sys
from pathlib import Path


def _load_sdk():
    """Load the runner SDK. Fast path: `import sdk` (executor puts runner dir on
    PYTHONPATH — spec 005). Fallback: load by file path for direct invocation
    outside the executor (e.g. functional tests)."""
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


# --------------------------------------------------------------------------- #
# Step handlers                                                                #
# --------------------------------------------------------------------------- #

def _do_apply(sdk, inputs, args) -> int:
    """apply step: apply org-mandated overrides to the frozen answers.

    Reads the `overrides` list (agent-steered, a list of dicts with keys
    {key, user_value, mandated_value, reason}) from the frozen plan inputs.
    For each entry that has a non-empty `mandated_value`, emits it via
    `answers_to_persist` so the mandated value lands in the frozen answers.

    FR-008: applies ONLY the listed overrides; never touches other answers.
    FR-010: reconcile=false — applied once at init.
    """
    overrides: list = inputs.get_list("overrides", default=[])

    answers_to_persist: dict = {}
    for entry in overrides:
        if not isinstance(entry, dict):
            continue
        key = entry.get("key", "")
        mandated_value = entry.get("mandated_value")
        if not key:
            continue
        if mandated_value is None:
            continue
        answers_to_persist[key] = {
            "value": mandated_value,
            "source": "agent-steered",
        }

    result = sdk.ModuleResult(
        module_id="org-policy",
        step_id=args.step,
        status="ok",
        files_written=[],
        diffs=[],
        answers_to_persist=answers_to_persist,
        warnings=[],
        message=(
            f"Applied {len(answers_to_persist)} org-mandated override(s)."
            if answers_to_persist
            else "No org-policy overrides to apply."
        ),
    )
    sdk.emit_result(result)
    return 0


STEP_HANDLERS = {
    "apply": _do_apply,
    # "resolve" is kind=agent   — handled by the runner's Tier-2 agent subsystem.
    # "overrides" is kind=gate  — handled by the runner's gate subsystem.
}


def main() -> int:
    ap = argparse.ArgumentParser(description="org-policy module")
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
    inputs = sdk.load_frozen_inputs(args.plan, module_id="org-policy")
    return handler(sdk, inputs, args)


if __name__ == "__main__":
    raise SystemExit(main())
