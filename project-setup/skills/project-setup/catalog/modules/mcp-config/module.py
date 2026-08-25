# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""mcp-config — write MCP server entries from public refs into .mcp.json.

The agent step (resolve) reads the frozen plan answers and determines which MCP
servers to configure. The gate step (mcp-gate) shows the selection for one-time
human review. This python step (write) merges the selected server entries into
.mcp.json using the canonical PUBLIC upstream refs — no marketplace dependency.

Public upstream refs (canonical, verified):
  - context7:        npx -y @upstash/context7-mcp
  - repomix:         npx -y repomix --mcp
  - package-version: npx -y mcp-package-version
  - codebase-memory: npx -y codebase-memory-mcp

Safety / determinism (spec 018 FR-009/FR-010/SC-006):
  - Output path is HARD-CODED to .mcp.json (the agent cannot redirect it).
  - An empty mcp_servers list is a clean no-op — nothing written (FR-010).
  - Unknown server names are WARNED and skipped; they never abort the run.
  - Merge semantics: foreign servers already present in .mcp.json are preserved;
    only the named public entries are written/updated.
  - Malformed existing .mcp.json → WARN + do NOT clobber (nothing written).
  - Output is deterministic: server keys sorted; json.dumps(..., sort_keys=True).
  - No wall-clock, no network, no subprocess. stdlib json only.

Invoked by the runner as:
    uv run module.py --plan <frozen_plan.json> --step <write> [--inspect]
"""

from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import os
import re
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


# Fixed output path — never read from inputs.
_OUTPUT_PATH = ".mcp.json"

# Canonical PUBLIC MCP server specs (verified upstreams).
# These are the ONLY entries this module manages; all other existing entries
# in .mcp.json are preserved unchanged (merge semantics).
_PUBLIC_MCP: dict[str, dict] = {
    "context7": {"command": "npx", "args": ["-y", "@upstash/context7-mcp"]},
    "repomix": {"command": "npx", "args": ["-y", "repomix", "--mcp"]},
    "package-version": {"command": "npx", "args": ["-y", "mcp-package-version"]},
    "codebase-memory": {"command": "npx", "args": ["-y", "codebase-memory-mcp"]},
}

_KNOWN_NAMES = ", ".join(sorted(_PUBLIC_MCP))


def _parse_mcp_versions(raw: str) -> dict[str, str]:
    """Parse 'name=version' overrides from a space-or-comma-separated string.

    Examples:
      "context7=1.0.14 repomix=0.2.0"  → {"context7": "1.0.14", "repomix": "0.2.0"}
      ""                                → {}
      "bogus-no-equals"                 → {} (malformed token silently ignored)
    """
    result: dict[str, str] = {}
    if not raw or not raw.strip():
        return result
    # Split on commas or whitespace
    tokens = re.split(r"[,\s]+", raw.strip())
    for token in tokens:
        if not token:
            continue
        if "=" in token:
            name, _, version = token.partition("=")
            name = name.strip()
            version = version.strip()
            if name and version:
                result[name] = version
        # tokens without "=" are silently ignored (malformed)
    return result


def _apply_version(server_spec: dict, version: str) -> dict:
    """Return a copy of server_spec with the package token in args versioned.

    The package token is the first arg after '-y' that is NOT a flag (does not
    start with '-').  e.g. args=['-y', '@upstash/context7-mcp'] → token becomes
    '@upstash/context7-mcp@1.0.14'.  Flags after the package (like '--mcp') are
    preserved unchanged.
    """
    import copy
    spec = copy.deepcopy(server_spec)
    args: list = spec.get("args", [])
    # Find the first non-flag token (the package name)
    for i, token in enumerate(args):
        if not token.startswith("-"):
            args[i] = f"{token}@{version}"
            break
    spec["args"] = args
    return spec


# --------------------------------------------------------------------------- #
# Step handlers                                                                #
# --------------------------------------------------------------------------- #

def _do_write(sdk, inputs, args) -> int:
    """write step: merge selected MCP server entries into .mcp.json."""
    mcp_servers: list = inputs.get_list("mcp_servers", default=[])
    mcp_versions_raw = inputs.get_str("mcp_versions", default="")
    version_overrides = _parse_mcp_versions(mcp_versions_raw)
    warnings: list[str] = []

    # FR-010: empty list → clean no-op, nothing written.
    if not mcp_servers:
        result = sdk.ModuleResult(
            module_id="mcp-config",
            step_id=args.step,
            status="ok",
            files_written=[],
            diffs=[],
            warnings=[],
            message="no MCP servers selected; nothing written",
        )
        sdk.emit_result(result)
        return 0

    # Resolve each requested name against the public registry.
    selected: dict[str, dict] = {}
    for name in mcp_servers:
        if not isinstance(name, str):
            warnings.append(
                f"WARN: mcp_servers entry is not a string — skipped: {name!r}"
            )
            continue
        name = name.strip()
        if name in _PUBLIC_MCP:
            base_spec = _PUBLIC_MCP[name]
            if name in version_overrides:
                # Pin the package token to the specified version
                spec = _apply_version(base_spec, version_overrides[name])
            else:
                # No override — use the unpinned (latest) public ref
                spec = copy.deepcopy(base_spec)
            selected[name] = spec
        else:
            warnings.append(
                f"WARN: unknown MCP server {name!r}; skipped — "
                f"known: {_KNOWN_NAMES}"
            )

    # If filtering left nothing valid → no-op + accumulated warnings.
    if not selected:
        result = sdk.ModuleResult(
            module_id="mcp-config",
            step_id=args.step,
            status="ok",
            files_written=[],
            diffs=[],
            warnings=warnings,
            message="no recognized MCP servers after filtering; nothing written",
        )
        sdk.emit_result(result)
        return 0

    # --------------------------------------------------------------------------
    # Merge with existing .mcp.json (if present).
    # --------------------------------------------------------------------------
    project_dir_env = os.environ.get("PROJECT_DIR")
    project_dir = Path(project_dir_env) if project_dir_env else Path.cwd()
    existing_path = project_dir / _OUTPUT_PATH

    merged_servers: dict[str, dict] = {}

    if existing_path.is_file():
        raw = existing_path.read_text(encoding="utf-8")
        try:
            existing_doc = json.loads(raw)
        except json.JSONDecodeError as exc:
            warnings.append(
                f"WARN: existing .mcp.json is malformed JSON ({exc}); "
                "NOT clobbering — fix manually and re-run."
            )
            result = sdk.ModuleResult(
                module_id="mcp-config",
                step_id=args.step,
                status="ok",
                files_written=[],
                diffs=[],
                warnings=warnings,
                message="existing .mcp.json is malformed; nothing written",
            )
            sdk.emit_result(result)
            return 0

        # Preserve all foreign servers; our entries overwrite for the names we manage.
        existing_servers = existing_doc.get("mcpServers", {})
        if isinstance(existing_servers, dict):
            merged_servers.update(existing_servers)

    # Our public entries are authoritative for the names we manage.
    merged_servers.update(selected)

    # Deterministic serialisation: sort server keys.
    doc = {"mcpServers": dict(sorted(merged_servers.items()))}
    body = json.dumps(doc, indent=2, sort_keys=True) + "\n"

    # reconcile=True: we computed the authoritative merged body; write it.
    diff = sdk.idempotent_write(
        _OUTPUT_PATH,
        body,
        reconcile=True,
        inspect=args.inspect,
    )

    files_written = [diff.path] if diff.kind in ("create", "modify") else []
    result = sdk.ModuleResult(
        module_id="mcp-config",
        step_id=args.step,
        status="ok",
        files_written=files_written,
        diffs=[diff],
        warnings=warnings,
        message=f"wrote .mcp.json with {len(selected)} MCP server(s): {', '.join(sorted(selected))}",
    )
    sdk.emit_result(result)
    return 0


STEP_HANDLERS = {
    "write": _do_write,
    # "resolve" is kind=agent  — handled by the runner's Tier-2 agent subsystem.
    # "mcp-gate" is kind=gate  — handled by the runner's gate subsystem.
}


def main() -> int:
    ap = argparse.ArgumentParser(description="mcp-config module")
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
    inputs = sdk.load_frozen_inputs(args.plan, module_id="mcp-config")
    return handler(sdk, inputs, args)


if __name__ == "__main__":
    raise SystemExit(main())
