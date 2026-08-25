# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""quality-hooks — write .agents/hooks/quality-languages.

Migrated from the legacy monolith project-setup.sh lines 1094-1097:

    if [ "${#QUALITY_LANGS[@]}" -gt 0 ]; then
        mkdir -p .agents/hooks
        printf '%s\n' "${QUALITY_LANGS[@]}" | sort -u > .agents/hooks/quality-languages
        echo "Configured agent quality hook languages: ${QUALITY_LANGS[*]}"
    fi

reconcile=true: on re-run the file is updated to match the sorted-unique list.
Empty list → skip (no file written / no change).

Invoked by the runner as:
    uv run module.py --plan <frozen_plan.json> --step write [--inspect]
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
def main() -> int:
    ap = argparse.ArgumentParser(description="quality-hooks module")
    ap.add_argument("--plan", required=True, help="path to the frozen plan.json")
    ap.add_argument("--step", required=True, help="step id to run")
    ap.add_argument("--inspect", action="store_true", help="dry pass: preview, no write")
    args = ap.parse_args()

    sdk = _load_sdk()
    inputs = sdk.load_frozen_inputs(args.plan, module_id="quality-hooks")

    quality_languages = inputs.get_list("quality_languages", default=[])

    if not quality_languages:
        result = sdk.ModuleResult(
            module_id="quality-hooks",
            step_id=args.step,
            status="ok",
            message="quality_languages is empty; skipped",
        )
        sdk.emit_result(result)
        return 0

    # Sort and deduplicate (monolith: sort -u)
    langs_sorted = sorted(set(str(lang) for lang in quality_languages))
    # One language per line with trailing newline (monolith: printf '%s\n')
    body = "\n".join(langs_sorted) + "\n"

    diff = sdk.idempotent_write(
        ".agents/hooks/quality-languages",
        body,
        reconcile=True,
        inspect=args.inspect,
    )

    files_written = [diff.path] if diff.kind in ("create", "modify") else []
    result = sdk.ModuleResult(
        module_id="quality-hooks",
        step_id=args.step,
        status="ok",
        files_written=files_written,
        diffs=[diff],
        message=f"quality-languages: {', '.join(langs_sorted)}" if files_written else "no change",
    )
    sdk.emit_result(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
