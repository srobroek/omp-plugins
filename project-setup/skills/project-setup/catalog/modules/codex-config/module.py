# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""codex-config — scaffold a project-scoped .codex/config.toml.

This is the REFERENCE module: the canonical shape every capability module
follows. It is invoked by the runner as a subprocess (Model-B contract):

    uv run module.py --plan <frozen_plan.json> --step <step_id> [--inspect]

It reads its FROZEN inputs from the plan on disk (never from agent-supplied
args), does deterministic work via the runner SDK, and prints EXACTLY ONE
canonical JSON result object to stdout. The agent is a trigger; this process is
the source of truth for what it writes.

Module authoring notes (read before copying this as a template):
- The SDK is loaded BY FILE PATH (no pip install, no PyPI dep). It is found via
  the ``$PLUGIN_ROOT`` env var the executor sets; the loaded module MUST be
  registered in ``sys.modules`` before ``exec_module`` (a dataclass subclassing
  Exception fails otherwise — see shared-contracts.md §6).
- Declare any third-party deps in the PEP 723 header above; ``uv run`` provisions
  them per-invocation. This module needs none.
- Tier-1 (kind=python) modules MUST be deterministic: same inputs → byte-identical
  output. Use ``sdk.idempotent_write`` which honors ``--inspect`` (preview, no
  write) with an inspect==write guarantee.
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import sys
from pathlib import Path

# The literal .codex/config.toml body — preserved verbatim from the legacy
# monolith (Step 7) so migrated projects are byte-identical.
_CODEX_CONFIG = """\
# Project or subfolder-scoped Codex overrides.
# Keep global defaults in ~/.codex/config.toml and place repo-specific
# overrides here when the repository needs different behavior.

# Example MCP server entry:
# [mcp_servers.context7]
# command = "npx"
# args = ["-y", "@upstash/context7-mcp"]

# Add project-local Codex settings below as needed.
"""


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
    ap = argparse.ArgumentParser(description="codex-config module")
    ap.add_argument("--plan", required=True, help="path to the frozen plan.json")
    ap.add_argument("--step", required=True, help="step id to run")
    ap.add_argument("--inspect", action="store_true", help="dry pass: preview, no write")
    args = ap.parse_args()

    sdk = _load_sdk()
    sdk.load_frozen_inputs(args.plan, module_id="codex-config")  # validates our plan section exists

    # Single step "write": create .codex/config.toml if absent (reconcile=false).
    diff = sdk.idempotent_write(
        ".codex/config.toml",
        _CODEX_CONFIG,
        reconcile=False,
        inspect=args.inspect,
    )

    files_written = [diff.path] if diff.kind in ("create", "modify") else []
    result = sdk.ModuleResult(
        module_id="codex-config",
        step_id=args.step,
        status="ok",
        files_written=files_written,
        diffs=[diff],
    )
    sdk.emit_result(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
