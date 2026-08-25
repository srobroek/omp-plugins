# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""gitignore-generate — compose .gitignore from vendored CC0 templates + custom block.

Migrated from the legacy monolith project-setup.sh Step 10 (lines 879–944).

The gitnr-based approach (`ghg:macOS ghg:Linux ...`) is replaced by vendored CC0
templates from github/gitignore (Global/ namespace) so the output is deterministic
and network-free by default.

Template order (FR-030/SC-009):
  The selected base templates are composed in the deterministic order they appear
  in the `templates` multichoice input, followed by the verbatim custom block.

Dynamic fetch (dynamic_fetch=true):
  Additionally fetches templates by name from raw.githubusercontent.com/github/gitignore
  and appends them. Network errors warn and continue (vendored-only output). Tests
  MUST monkeypatch the fetch — no real network in tests.

reconcile=true: on re-run the .gitignore is overwritten to match the composed
output. This keeps the file up-to-date with template changes.

Invoked by the runner as:
    uv run module.py --plan <frozen_plan.json> --step write [--inspect]
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

_TEMPLATES_DIR = Path(__file__).resolve().parent / "templates" / "gitignore"

# Canonical mapping: multichoice value -> vendored filename.
# Order here is authoritative for deterministic composition.
_TEMPLATE_FILES: dict[str, str] = {
    "macos": "macos.gitignore",
    "linux": "linux.gitignore",
    "windows": "windows.gitignore",
    "jetbrains": "jetbrains.gitignore",
    "vscode": "vscode.gitignore",
    "vim": "vim.gitignore",
    "backup": "backup.gitignore",
    "patch": "patch.gitignore",
    "gpg": "gpg.gitignore",
}

# github/gitignore Global/ namespace mapping (for dynamic_fetch).
# Maps the canonical key to the GitHub path under the repo.
_GITHUB_GITIGNORE_GLOBAL: dict[str, str] = {
    "macos": "Global/macOS.gitignore",
    "linux": "Global/Linux.gitignore",
    "windows": "Global/Windows.gitignore",
    "jetbrains": "Global/JetBrains.gitignore",
    "vscode": "Global/VisualStudioCode.gitignore",
    "vim": "Global/Vim.gitignore",
    "backup": "Global/Backup.gitignore",
    "patch": "Global/Patch.gitignore",
    "gpg": "Global/GPG.gitignore",
}

_GITHUB_RAW_BASE = "https://raw.githubusercontent.com/github/gitignore/main"

# Verbatim custom block from project-setup.sh lines 915–930.
_CUSTOM_BLOCK = """
# Environment
.env
.env.*
!.env.example

# Fastembed
.fastembed_cache

# Repomix local snapshots
repomix.xml
repomix.md
repomix.json
repomix.txt
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
        sdk_path = Path(__file__).resolve().parents[2] / "runner" / "sdk.py"
    spec = importlib.util.spec_from_file_location("sdk", sdk_path)
    assert spec and spec.loader, f"cannot locate runner SDK at {sdk_path}"
    mod = importlib.util.module_from_spec(spec)
    sys.modules["sdk"] = mod          # register BEFORE exec_module (the @dataclass(Exception) footgun)
    spec.loader.exec_module(mod)
    return mod
def _fetch_template(name: str) -> str | None:
    """Fetch a template from raw.githubusercontent.com/github/gitignore.

    Returns the content string on success, None on any failure (network error,
    404, timeout). Callers must treat None as "warn + skip".

    For well-known base templates the GitHub path is looked up in
    _GITHUB_GITIGNORE_GLOBAL; otherwise the name is tried directly as
    <Name>.gitignore (top-level) and Global/<Name>.gitignore.
    """
    candidates: list[str] = []
    if name.lower() in _GITHUB_GITIGNORE_GLOBAL:
        candidates.append(_GITHUB_GITIGNORE_GLOBAL[name.lower()])
    else:
        # Try top-level first, then Global/
        capitalized = name[0].upper() + name[1:] if name else name
        candidates.append(f"{capitalized}.gitignore")
        candidates.append(f"Global/{capitalized}.gitignore")

    for path in candidates:
        url = f"{_GITHUB_RAW_BASE}/{path}"
        try:
            with urllib.request.urlopen(url, timeout=10) as resp:  # noqa: S310
                return resp.read().decode("utf-8")
        except (urllib.error.URLError, urllib.error.HTTPError, OSError):
            continue
    return None


def _compose_gitignore(
    templates: list[str],
    dynamic_fetch: bool,
    warnings: list[str],
) -> str:
    """Compose the .gitignore body from vendored templates + custom block.

    Parameters
    ----------
    templates:
        Ordered list of template keys to include (e.g. ["macos", "linux"]).
    dynamic_fetch:
        If True, fetch templates not present in the vendored set from GitHub.
    warnings:
        Mutable list; warnings are appended here (never raises).
    """
    parts: list[str] = []

    for key in templates:
        key_lower = key.lower()
        vendored_name = _TEMPLATE_FILES.get(key_lower)
        if vendored_name:
            vendored_path = _TEMPLATES_DIR / vendored_name
            if vendored_path.is_file():
                parts.append(f"### {key_lower} ###\n")
                parts.append(vendored_path.read_text(encoding="utf-8").rstrip("\n") + "\n")
                continue
            else:
                warnings.append(
                    f"Vendored template missing: {vendored_path}; "
                    f"re-vendor by fetching github/gitignore Global/{vendored_name}"
                )
                # Fall through to dynamic_fetch below if enabled

        # Template not in the vendored set (or vendored file missing)
        if dynamic_fetch:
            content = _fetch_template(key_lower)
            if content is not None:
                parts.append(f"### {key_lower} ###\n")
                parts.append(content.rstrip("\n") + "\n")
            else:
                warnings.append(
                    f"dynamic_fetch: could not fetch template '{key}' from github/gitignore; "
                    f"skipped. Add it manually or vendor it into templates/gitignore/."
                )
        else:
            warnings.append(
                f"Template '{key}' is not in the vendored set and dynamic_fetch=false; "
                f"skipped. Enable dynamic_fetch or vendor the template."
            )

    # Append the verbatim custom block (always included)
    parts.append(_CUSTOM_BLOCK)

    return "".join(parts)


def main() -> int:
    ap = argparse.ArgumentParser(description="gitignore-generate module")
    ap.add_argument("--plan", required=True, help="path to the frozen plan.json")
    ap.add_argument("--step", required=True, help="step id to run")
    ap.add_argument("--inspect", action="store_true", help="dry pass: preview, no write")
    args = ap.parse_args()

    sdk = _load_sdk()
    inputs = sdk.load_frozen_inputs(args.plan, module_id="gitignore-generate")

    templates: list[str] = inputs.get_multichoice(
        "templates",
        default=list(_TEMPLATE_FILES.keys()),
    )
    dynamic_fetch: bool = inputs.get_bool("dynamic_fetch", default=False)

    warnings: list[str] = []
    body = _compose_gitignore(templates, dynamic_fetch, warnings)

    diff = sdk.idempotent_write(
        ".gitignore",
        body,
        reconcile=True,
        inspect=args.inspect,
    )

    files_written = [diff.path] if diff.kind in ("create", "modify") else []
    result = sdk.ModuleResult(
        module_id="gitignore-generate",
        step_id=args.step,
        status="ok",
        files_written=files_written,
        diffs=[diff],
        warnings=warnings,
    )
    sdk.emit_result(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
