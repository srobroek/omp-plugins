# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""agents-md — write a skeleton AGENTS.md + splice the architecture section.

Preserves BOTH verbatim heredocs from project-setup.sh Step 6 (lines 478–585):
  - monorepo layout: templates/monorepo.md  (lines 478–536)
  - single layout:   templates/single.md    (lines 538–585)

PROJECT_NAME and ORG placeholders are substituted from core-identity answers.
The template text is stored in templates/ alongside this module so it travels
with the module and is easy to diff/audit.

reconcile=true: re-running overwrites AGENTS.md to match the template (with
current substitutions) if it has drifted.

Steps handled by module.py (kind=python):
  write  — write the full AGENTS.md skeleton (with sentinel markers in place)
  splice — read frozen architecture_md, validate top-level dirs, splice into
           the sentinel-bounded span in AGENTS.md

Agent + gate steps (resolve-arch, arch-gate) are handled by the runner; they
never reach module.py.

Invoked by the runner as:
    uv run module.py --plan <frozen_plan.json> --step <write|splice> [--inspect]
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import re
import sys
from pathlib import Path

_TEMPLATES = Path(__file__).resolve().parent / "templates"

# Sentinel markers written by the base template and used by the splice step.
# These are module-level constants so tests and the step handler share them.
BEGIN_SENTINEL = "<!-- BEGIN ps:architecture -->"
END_SENTINEL = "<!-- END ps:architecture -->"

# Regex to match path-table rows referencing a top-level directory.
# Matches lines of the form:  | `<name>/` ...
# where <name> is the directory name (no slash, no backtick inside).
# Group 1 captures the bare directory name without trailing slash.
# Documented here per spec 006 OQ-2.
_PATH_ROW_RE = re.compile(r"^\|\s*`([^`/]+)/`", re.MULTILINE)


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


def _render(layout: str, project_name: str, org: str, description: str = "") -> str:
    """Load the appropriate template and substitute placeholders.

    Single-pass substitution via one regex alternation so a user value that
    happens to contain another placeholder token (e.g. a project literally named
    "myORG-api") cannot be double-substituted. PROJECT_NAME precedes ORG in the
    alternation so the longer token wins on the literal ``ORG/PROJECT_NAME`` line.

    When *description* is supplied, the ``PROJECT DESCRIPTION`` placeholder comment
    is replaced with the real one-line description (the value is already known from
    core-identity, so leaving it as a TODO comment is needless drift). When empty,
    the comment is left intact for a later agent fill.
    """
    template_file = _TEMPLATES / ("monorepo.md" if layout == "monorepo" else "single.md")
    body = template_file.read_text(encoding="utf-8")
    if description.strip():
        body = body.replace(
            "<!-- PROJECT DESCRIPTION: to be filled by agent -->",
            description.strip(),
            1,
        )
    mapping = {"PROJECT_NAME": project_name, "ORG": org}
    pattern = re.compile("|".join(re.escape(k) for k in mapping))
    return pattern.sub(lambda m: mapping[m.group(0)], body)


# --------------------------------------------------------------------------- #
# Step handlers                                                                #
# --------------------------------------------------------------------------- #

def _do_write(sdk, inputs, args) -> int:
    """write step: render the AGENTS.md skeleton and write it idempotently."""
    layout = inputs.get_choice("layout", default="single")
    project_name = inputs.get_str("project_name", default="PROJECT_NAME")
    org = inputs.get_str("org", default="ORG")
    description = inputs.get_str("description", default="")

    body = _render(layout, project_name, org, description)

    diff = sdk.idempotent_write(
        "AGENTS.md",
        body,
        reconcile=True,
        inspect=args.inspect,
    )

    files_written = [diff.path] if diff.kind in ("create", "modify") else []
    result = sdk.ModuleResult(
        module_id="agents-md",
        step_id=args.step,
        status="ok",
        files_written=files_written,
        diffs=[diff],
    )
    sdk.emit_result(result)
    return 0


def _do_splice(sdk, inputs, args) -> int:
    """splice step: filter phantom paths then splice architecture_md into AGENTS.md.

    1. Read architecture_md (frozen agent answer) + agent_editable_globs.
    2. Validate top-level directories: strip any path-table row in architecture_md
       that references a directory NOT present in scan_top_level_dirs(). Warn per
       stripped row. Row pattern: | `<name>/`  (backtick-quoted name ending in /).
    3. Call splice_between_sentinels to replace the sentinel-bounded span.
    4. Emit ModuleResult with warnings.

    Works in both init (architecture_md is the fresh agent answer) and reproduce
    (architecture_md is the committed answer replayed from answers.toml) modes —
    the logic is identical; no network calls are made.
    """
    architecture_md: str = inputs.get_str("architecture_md", default="")
    agent_editable_globs: list[str] = inputs.get_list("agent_editable_globs", default=[])

    warnings: list[str] = []

    # ── Phantom-path guard (spec 006 FR-007, OQ-2) ───────────────────────── #
    existing_dirs = sdk.scan_top_level_dirs()  # reads $PROJECT_DIR from env

    def _keep_row(m: re.Match) -> bool:
        """Return True if the matched directory name exists on disk."""
        dir_name = m.group(1)
        return dir_name in existing_dirs

    # Collect rows to strip, then remove them from the body.
    filtered_lines = []
    for line in architecture_md.splitlines(keepends=True):
        m = _PATH_ROW_RE.match(line)
        if m and not _keep_row(m):
            dir_name = m.group(1)
            warnings.append(
                f"WARN: phantom path '{dir_name}/' referenced in architecture_md — row removed"
            )
        else:
            filtered_lines.append(line)
    filtered_body = "".join(filtered_lines)

    # ── Splice into AGENTS.md between the sentinel markers ────────────────── #
    diff = sdk.splice_between_sentinels(
        "AGENTS.md",
        BEGIN_SENTINEL,
        END_SENTINEL,
        filtered_body,
        inspect=args.inspect,
        missing="append",
        warnings=warnings,
    )

    files_written = [diff.path] if diff.kind in ("create", "modify") else []
    result = sdk.ModuleResult(
        module_id="agents-md",
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
    "splice": _do_splice,
    # "resolve-arch" is kind=agent  — handled by the runner's Tier-2 agent subsystem.
    # "arch-gate"    is kind=gate   — handled by the runner's gate subsystem.
}


def main() -> int:
    ap = argparse.ArgumentParser(description="agents-md module")
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
    inputs = sdk.load_frozen_inputs(args.plan, module_id="agents-md")
    return handler(sdk, inputs, args)


if __name__ == "__main__":
    raise SystemExit(main())
