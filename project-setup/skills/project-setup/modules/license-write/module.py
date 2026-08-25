# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""license-write — write a LICENSE file from a vendored SPDX template.

Templates for all 13 GitHub Licenses API keys are vendored verbatim in
templates/licenses/<key>.txt. The raw bodies are from GitHub's Licenses API
(GET /licenses/<key> .body field) and preserved character-for-character so
offline runs are deterministic.

Placeholder substitution handles all bracket-style tokens used across the 13
licenses:
  - [year] / [yyyy]  → current year (datetime.now().year)
  - [fullname] / [name of copyright owner]  → author

Where a license has no placeholders (e.g. agpl-3.0, gpl-2.0, unlicense) the
body is written as-is.

SC-001 carve-out: year and author lines vary at runtime (current year via
datetime, author from git config user.name or the input). Tests MUST exclude
those lines from byte-identical assertions.

reconcile=false: LICENSE is never overwritten on re-run (write-if-absent,
matching the legacy `if [ ! -f LICENSE ]` behaviour).

dynamic_fetch=true: fetches the latest body from GET /licenses/<key>
on demand. On failure (network error, timeout, bad JSON) warns and falls back
to the vendored copy. Tests MUST monkeypatch the fetch — no real network.

Invoked by the runner as:
    uv run module.py --plan <frozen_plan.json> --step write [--inspect]
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

_LICENSES_DIR = Path(__file__).resolve().parent / "templates" / "licenses"

# All 13 GitHub Licenses API keys — authoritative list for the choice input.
_ALL_KEYS: list[str] = [
    "agpl-3.0",
    "apache-2.0",
    "bsd-2-clause",
    "bsd-3-clause",
    "bsl-1.0",
    "cc0-1.0",
    "epl-2.0",
    "gpl-2.0",
    "gpl-3.0",
    "lgpl-2.1",
    "mit",
    "mpl-2.0",
    "unlicense",
]

_GITHUB_API_BASE = "https://api.github.com/licenses"


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
def _git_user_name() -> str:
    """Return git config user.name, or 'AUTHOR' if unavailable."""
    try:
        result = subprocess.run(
            ["git", "config", "user.name"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        name = result.stdout.strip()
        return name if name else "AUTHOR"
    except Exception:
        return "AUTHOR"


def _fetch_license_body(key: str) -> str | None:
    """Fetch the license body from the GitHub Licenses API.

    Returns the body string on success, None on any failure.
    Callers must treat None as "warn + use vendored fallback".
    """
    url = f"{_GITHUB_API_BASE}/{key}"
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "license-write-module/2.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310
            data = json.loads(resp.read().decode("utf-8"))
        body = data.get("body", "")
        return body if body else None
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError, KeyError):
        return None


def _substitute_placeholders(body: str, year: str, author: str) -> str:
    """Replace all known bracket-style placeholders with runtime values.

    Handles all patterns found across the 13 GitHub-API license bodies:
      - apache-2.0:   [yyyy], [name of copyright owner]
      - bsd-2-clause, bsd-3-clause, mit: [year], [fullname]
    Licenses with no placeholders (e.g. agpl-3.0, gpl-2.0) are returned as-is.
    """
    body = body.replace("[yyyy]", year)
    body = body.replace("[year]", year)
    body = body.replace("[fullname]", author)
    body = body.replace("[name of copyright owner]", author)
    return body


def _render(
    key: str,
    year: str,
    author: str,
    dynamic_fetch: bool,
    warnings: list[str],
) -> str:
    """Compose the LICENSE body for *key*.

    1. If dynamic_fetch=True: attempt a live fetch from the GitHub Licenses API.
       On failure: warn + fall back to vendored copy.
    2. Always apply placeholder substitution ([year], [yyyy], [fullname], etc.).
    """
    if key not in _ALL_KEYS:
        raise ValueError(
            f"Unknown license key: {key!r}. "
            f"Valid keys: {', '.join(_ALL_KEYS)}"
        )

    body: str | None = None

    if dynamic_fetch:
        body = _fetch_license_body(key)
        if body is None:
            warnings.append(
                f"dynamic_fetch: could not fetch license '{key}' from "
                f"{_GITHUB_API_BASE}/{key}; using vendored copy."
            )

    if body is None:
        vendored = _LICENSES_DIR / f"{key}.txt"
        if not vendored.is_file():
            raise FileNotFoundError(
                f"Vendored license template missing: {vendored}. "
                f"Re-vendor by running the fetch script."
            )
        body = vendored.read_text(encoding="utf-8")

    return _substitute_placeholders(body, year, author)


def main() -> int:
    ap = argparse.ArgumentParser(description="license-write module")
    ap.add_argument("--plan", required=True, help="path to the frozen plan.json")
    ap.add_argument("--step", required=True, help="step id to run")
    ap.add_argument("--inspect", action="store_true", help="dry pass: preview, no write")
    args = ap.parse_args()

    sdk = _load_sdk()
    inputs = sdk.load_frozen_inputs(args.plan, module_id="license-write")

    key = inputs.get_choice("license", default="apache-2.0")
    # SC-001 carve-out: author and year are runtime values, not frozen answers.
    author_input = inputs.get_str("author", default="")
    author = author_input if author_input else _git_user_name()
    year = str(datetime.now().year)
    dynamic_fetch = inputs.get_bool("dynamic_fetch", default=False)

    warnings: list[str] = []
    body = _render(key, year, author, dynamic_fetch, warnings)

    diff = sdk.idempotent_write(
        "LICENSE",
        body,
        reconcile=False,  # write-if-absent; never overwrite on re-run
        inspect=args.inspect,
    )

    files_written = [diff.path] if diff.kind in ("create", "modify") else []
    result = sdk.ModuleResult(
        module_id="license-write",
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
