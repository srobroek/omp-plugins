# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""dirs-scaffold — create the standard directory structure.

Preserves the EXACT legacy directory list from project-setup.sh Step 3
(lines 265–315). Creates 21 base DIRS with .gitkeep files. When
layout=monorepo and no targets override is provided, adds the 15 default
monorepo TARGETS. Custom targets are appended when provided via the
targets input.

reconcile=true: on re-run it verifies .gitkeep files exist in all dirs,
creating any that were removed. idempotent_write handles the skip-if-identical
case automatically.

Invoked by the runner as:
    uv run module.py --plan <frozen_plan.json> --step write [--inspect]
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import sys
from pathlib import Path

# --- Legacy DIRS (lines 265–286 of project-setup.sh) ---
# Exactly 21 entries, preserved verbatim.
_BASE_DIRS = [
    ".codex",
    ".agents/hooks",
    ".github/workflows",
    "docs/architecture",
    "docs/decisions",
    "docs/research",
    "docs/runbooks",
    "docs/product",
    "docs/engineering",
    "docs/operations",
    "docs/api",
    "specs",
    "infrastructure/environments",
    "infrastructure/terraform/modules",
    "infrastructure/terraform/stacks",
    "infrastructure/terraform/environments",
    "tests",
    "scripts",
    "assets",
    "archive",
]

# --- Legacy monorepo TARGETS (lines 289–305 of project-setup.sh) ---
# Exactly 15 entries. Added when layout=monorepo and no explicit targets given.
_MONOREPO_TARGETS = [
    "apps",
    "services",
    "functions",
    "workers",
    "libs/domain",
    "libs/application",
    "libs/adapters",
    "libs/config",
    "libs/testing",
    "libs/ui",
    "libs/types",
    "packages",
    "schemas",
    "data/shared",
    "tools",
]


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
    ap = argparse.ArgumentParser(description="dirs-scaffold module")
    ap.add_argument("--plan", required=True, help="path to the frozen plan.json")
    ap.add_argument("--step", required=True, help="step id to run")
    ap.add_argument("--inspect", action="store_true", help="dry pass: preview, no write")
    args = ap.parse_args()

    sdk = _load_sdk()
    inputs = sdk.load_frozen_inputs(args.plan, module_id="dirs-scaffold")

    layout = inputs.get_choice("layout", default="single")
    targets_input = inputs.get_list("targets", default=[])

    # Build the full directory list:
    # base + monorepo defaults (when layout=monorepo and no explicit targets)
    # + explicit targets (appended to base regardless of layout when provided)
    dirs = list(_BASE_DIRS)
    if layout == "monorepo" and not targets_input:
        dirs.extend(_MONOREPO_TARGETS)
    elif targets_input:
        dirs.extend(targets_input)

    diffs = []
    files_written = []

    for d in dirs:
        gitkeep_path = f"{d}/.gitkeep"
        diff = sdk.idempotent_write(
            gitkeep_path,
            b"",  # .gitkeep files are always empty
            reconcile=True,  # reconcile=true: ensure they exist on re-run
            inspect=args.inspect,
        )
        diffs.append(diff)
        if diff.kind in ("create", "modify"):
            files_written.append(diff.path)

    result = sdk.ModuleResult(
        module_id="dirs-scaffold",
        step_id=args.step,
        status="ok",
        files_written=files_written,
        diffs=diffs,
    )
    sdk.emit_result(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
