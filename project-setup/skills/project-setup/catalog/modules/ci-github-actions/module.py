# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""ci-github-actions — write a .github/workflows/ci.yml sized to the frozen stack.

The agent step (resolve) reads context["all_answers"] for active lang-* overlays
and emits four flat agent-steered keys:
  ci_plan_jobs        — list of job IDs
  ci_plan_action_refs — list of owner/repo@vN strings
  ci_plan_matrix      — JSON string encoding the per-language runtime matrix
  ci_plan_commands    — flat list of command strings (across all jobs)

This python write step (Phase B):
  1. Loads the flat ci_plan_* answers from the frozen plan.
  2. Validates each command: just <recipe> → must exist in on-disk justfile;
     {bun,pnpm,npm} run <script> → must exist in package.json; bare commands pass.
  3. Validates action refs: any ref without @v → FIXME placeholder + warning.
  4. Trims the matrix to the frozen python_version (FR-015).
  5. Renders deterministic YAML via render_ci_yaml().
  6. Writes .github/workflows/ci.yml via sdk.idempotent_write(reconcile=True).

Canonical YAML renderer (FR-013, SC-006):
  render_ci_yaml(plan_dict) -> str — pure stdlib, deterministic key order,
  2-space indent, YAML true/false, quoted values containing ":".
  Same plan_dict → identical bytes on every invocation.

Zero network on reproduce (FR-016): all validation is against on-disk files only.

Invoked by the runner as:
    uv run module.py --plan <frozen_plan.json> --step write [--inspect]
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
from pathlib import Path

# --------------------------------------------------------------------------- #
# SDK loader (mirrors lang-python / stack-adr pattern)                        #
# --------------------------------------------------------------------------- #

def _load_sdk():
    """Load the runner SDK via import (fast path) or file path (fallback)."""
    try:
        import sdk  # noqa: PLC0415
        return sdk
    except ModuleNotFoundError:
        pass
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
    sys.modules["sdk"] = mod
    spec.loader.exec_module(mod)
    return mod


# --------------------------------------------------------------------------- #
# Canonical YAML renderer (FR-013, SC-006)                                     #
# --------------------------------------------------------------------------- #

def _needs_quoting(value: str) -> bool:
    """Return True if a YAML scalar value needs quoting (contains ':' or starts
    with special characters). Conservative: quote values with ':' to avoid
    ambiguity with YAML mappings."""
    if not isinstance(value, str):
        return False
    # YAML special cases that require quoting
    specials = (":", "{", "}", "[", "]", ",", "#", "&", "*", "?", "|",
                "-", "<", ">", "=", "!", "%", "@", "`")
    if any(value.startswith(s) for s in specials):
        return True
    if ":" in value:
        return True
    # Values that look like booleans or nulls must be quoted if they are strings
    if value.lower() in ("true", "false", "yes", "no", "null", "~"):
        return True
    # Values that look like numbers (int or float) must be quoted when they are
    # strings — e.g. python-version: '3.13' should not become the float 3.13.
    # This covers version strings like "3.13", "1.22", "21", etc.
    try:
        float(value)
        return True  # Looks like a number → must quote to preserve string type
    except ValueError:
        pass
    return False


def _scalar(value) -> str:
    """Render a scalar YAML value: bool → true/false, None → null, str optionally
    quoted, numbers as-is."""
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None:
        return "null"
    if isinstance(value, (int, float)):
        return str(value)
    s = str(value)
    if _needs_quoting(s):
        # Single-quote: escape embedded single quotes by doubling them.
        escaped = s.replace("'", "''")
        return f"'{escaped}'"
    return s


def _render_lines(obj, indent: int = 0) -> list[str]:
    """Recursively render obj as YAML lines with *indent* spaces of indentation.

    Key ordering at each dict level is whatever order the dict is passed in —
    callers are responsible for passing OrderedDicts or dicts with explicit order.
    For determinism, all dict construction in render_ci_yaml uses explicit key
    ordering via insertion order (Python 3.7+ dict guarantee).
    """
    lines: list[str] = []
    pad = " " * indent
    if isinstance(obj, dict):
        for k, v in obj.items():
            key_str = _scalar(k)
            if isinstance(v, dict):
                lines.append(f"{pad}{key_str}:")
                lines.extend(_render_lines(v, indent + 2))
            elif isinstance(v, list):
                lines.append(f"{pad}{key_str}:")
                lines.extend(_render_lines(v, indent + 2))
            else:
                lines.append(f"{pad}{key_str}: {_scalar(v)}")
    elif isinstance(obj, list):
        if not obj:
            # Inline empty list representation — but since we always write
            # list items under their parent key, fall through to item loop.
            pass
        for item in obj:
            if isinstance(item, dict):
                # First key of the dict uses "- key: value", rest use "  key: value"
                first = True
                for k, v in item.items():
                    key_str = _scalar(k)
                    item_pad = pad[:-2] + "- " if first and indent >= 2 else pad
                    if first and indent >= 2:
                        item_pad = " " * (indent - 2) + "- "
                    else:
                        item_pad = " " * indent
                    if isinstance(v, dict):
                        lines.append(f"{item_pad}{key_str}:")
                        lines.extend(_render_lines(v, indent + 2))
                    elif isinstance(v, list):
                        lines.append(f"{item_pad}{key_str}:")
                        lines.extend(_render_lines(v, indent + 2))
                    else:
                        lines.append(f"{item_pad}{key_str}: {_scalar(v)}")
                    first = False
            else:
                lines.append(f"{pad}- {_scalar(item)}")
    return lines


def render_ci_yaml(plan_dict: dict, header_comments: list[str] | None = None) -> str:
    """Render a CI workflow dict to a canonical YAML string.

    Determinism guarantees (SC-006, FR-017):
    - Key order is fixed: top-level name/on/env/jobs; per-job name/runs-on/strategy/steps.
    - No wall-clock, no random.
    - Same plan_dict → identical bytes.

    Args:
        plan_dict: A dict with keys:
            "name"    (str)  — workflow name
            "on"      (dict) — trigger config
            "env"     (dict, optional) — workflow-level env vars
            "jobs"    (dict) — job id → job definition dict
        header_comments: optional comment lines (e.g. FIXME notes for floating
            action refs) emitted verbatim right after the `name:` line. Each must
            already begin with '#'. Inserted structurally — no post-hoc string
            surgery on the rendered output.

    Returns:
        A YAML string starting with "name: ..." with a trailing newline.
    """
    # Render each top-level section through the single recursive emitter
    # (_render_lines) rather than hand-unrolling indentation per nesting level.
    # The recursive emitter handles arbitrary nesting (incl. step `with:` maps and
    # strategy.matrix lists) uniformly, so there is one rendering code path and no
    # per-level bugs. Determinism is preserved by normalizing key order BEFORE
    # rendering and emitting blank-line separators between top-level sections.
    blocks: list[list[str]] = []

    # name: (+ optional header comment lines, e.g. FIXME notes for floating refs)
    name = plan_dict.get("name", "CI")
    name_block = [f"name: {_scalar(name)}"]
    for c in (header_comments or []):
        name_block.append(c if c.lstrip().startswith("#") else f"# {c}")
    blocks.append(name_block)

    # on: — triggers in sorted key order (deterministic). An empty/None trigger
    # value renders as a bare `key:` (e.g. `workflow_dispatch:`).
    on_block = plan_dict.get("on", {})
    on_norm: dict = {}
    for trigger_key in sorted(on_block.keys()):
        tv = on_block[trigger_key]
        on_norm[trigger_key] = {} if (tv is None) else tv
    blocks.append(["on:", *_render_lines(on_norm, indent=2)])

    # env: (optional)
    env_block = plan_dict.get("env")
    if env_block:
        blocks.append(["env:", *_render_lines(env_block, indent=2)])

    # jobs: — per-job key order normalized to name/runs-on/strategy/steps, then
    # any extra keys sorted, so output is stable regardless of input dict order.
    jobs_block = plan_dict.get("jobs", {})
    job_key_order = ["name", "runs-on", "strategy", "steps"]
    jobs_norm: dict = {}
    for job_id, job_def in jobs_block.items():
        other_keys = sorted(k for k in job_def if k not in job_key_order)
        ordered = [k for k in job_key_order if k in job_def] + other_keys
        jobs_norm[job_id] = {k: job_def[k] for k in ordered}
    blocks.append(["jobs:", *_render_lines(jobs_norm, indent=2)])

    # Join sections with a single blank line between them.
    lines: list[str] = []
    for i, block in enumerate(blocks):
        if i:
            lines.append("")
        lines.extend(block)
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- #
# Command validation helpers                                                   #
# --------------------------------------------------------------------------- #

def _load_justfile_recipes(project_dir: Path) -> set[str] | None:
    """Scan PROJECT_DIR/justfile for recipe names (lines matching '^<name>:').

    Returns a set of recipe names, or None if the justfile does not exist.
    """
    justfile = project_dir / "justfile"
    if not justfile.is_file():
        return None
    recipes: set[str] = set()
    for line in justfile.read_text(encoding="utf-8").splitlines():
        # A recipe line starts with an identifier followed by ':' (no leading whitespace).
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*):", line)
        if m:
            recipes.add(m.group(1))
    return recipes


def _load_package_json_scripts(project_dir: Path) -> set[str] | None:
    """Load package.json scripts keys.

    Returns a set of script names, or None if package.json does not exist.
    """
    pkg = project_dir / "package.json"
    if not pkg.is_file():
        return None
    try:
        data = json.loads(pkg.read_text(encoding="utf-8"))
        scripts = data.get("scripts", {})
        if isinstance(scripts, dict):
            return set(scripts.keys())
    except (json.JSONDecodeError, OSError):
        pass
    return None


def _validate_commands(
    commands: list[str],
    *,
    use_just: bool,
    justfile_recipes: set[str] | None,
    pkg_scripts: set[str] | None,
    project_dir: Path,
) -> tuple[list[str], list[str]]:
    """Validate command strings per FR-012.

    Returns (valid_commands, warnings).
    """
    valid: list[str] = []
    warnings: list[str] = []

    for cmd in commands:
        # ── just <recipe> validation ────────────────────────────────────────── #
        if cmd.startswith("just "):
            if not use_just:
                warnings.append(
                    f"use_just=false: 'just' commands require a justfile — "
                    f"command dropped: {cmd!r}"
                )
                continue
            recipe = cmd[5:].strip().split()[0] if cmd[5:].strip() else ""
            if justfile_recipes is None:
                # No justfile on disk at write time
                warnings.append(
                    f"no justfile found at {project_dir}/justfile — "
                    f"command dropped: {cmd!r}"
                )
                continue
            if recipe not in justfile_recipes:
                warnings.append(
                    f"recipe {recipe!r} not found in justfile — command dropped"
                )
                continue
            valid.append(cmd)
            continue

        # ── {bun,pnpm,npm} run <script> validation ────────────────────────── #
        pm_run_match = re.match(
            r"^(bun|pnpm|npm)\s+run\s+(\S+)", cmd
        )
        if pm_run_match:
            script_name = pm_run_match.group(2)
            if pkg_scripts is None:
                # package.json absent — treat as pass-through with a warning
                warnings.append(
                    f"no package.json found — cannot validate script {script_name!r}, "
                    f"passing command through: {cmd!r}"
                )
                valid.append(cmd)
                continue
            if script_name not in pkg_scripts:
                warnings.append(
                    f"script {script_name!r} not found in package.json — command dropped: {cmd!r}"
                )
                continue
            valid.append(cmd)
            continue

        # ── bare commands pass through ────────────────────────────────────── #
        valid.append(cmd)

    return valid, warnings


def _validate_action_refs(
    refs: list[str],
) -> tuple[list[str], list[str], list[str]]:
    """Validate action refs per FR-012d.

    Returns (valid_refs, fixme_placeholders, warnings).
    valid_refs: refs with proper @vN form.
    fixme_placeholders: YAML comment strings for floating refs (replaces the ref in YAML).
    warnings: list of warning strings.
    """
    valid: list[str] = []
    fixmes: list[str] = []
    warnings: list[str] = []

    for ref in refs:
        # A valid pinned ref must contain @v followed by digits
        if re.search(r"@v\d+", ref):
            valid.append(ref)
        else:
            fixmes.append(f"# FIXME: floating or unpinned action ref: {ref}")
            warnings.append(
                f"action ref {ref!r} is not in owner/repo@vN form — "
                f"replaced with FIXME placeholder in YAML"
            )

    return valid, fixmes, warnings


# --------------------------------------------------------------------------- #
# CI YAML plan construction                                                    #
# --------------------------------------------------------------------------- #

def _build_on_block(triggers: list[str], default_branch: str) -> dict:
    """Build the 'on:' block from the ci_trigger list."""
    on: dict = {}
    for t in triggers:
        if t == "push":
            on["push"] = {"branches": [default_branch]}
        elif t == "pull_request":
            on["pull_request"] = {"branches": [default_branch]}
        elif t == "workflow_dispatch":
            on["workflow_dispatch"] = None
    return on


def _build_jobs(
    job_ids: list[str],
    matrix_entries: list[dict],
    valid_refs: list[str],
    fixme_refs: list[str],
    valid_commands: list[str],
) -> dict:
    """Build the jobs dict for the CI plan.

    For simplicity in v1, all jobs share the same validated commands and action
    refs. The matrix entry for a job is matched by language ("python" in job_id,
    "ts" in job_id, etc.).
    """
    # Build a lookup from ref string to "uses" value
    ref_set = set(valid_refs)

    jobs: dict = {}
    for job_id in job_ids:
        steps: list[dict] = []

        # checkout is always first
        checkout_ref = next(
            (r for r in valid_refs if r.startswith("actions/checkout@")),
            None,
        )
        if checkout_ref:
            steps.append({"uses": checkout_ref})
        elif fixme_refs:
            # Floating checkout — add FIXME comment as a step name
            for fref in fixme_refs:
                if "checkout" in fref.lower():
                    steps.append({"name": fref, "uses": "actions/checkout@FIXME"})

        # Language-specific setup step
        if "python" in job_id:
            uv_ref = next(
                (r for r in valid_refs if "setup-uv" in r), None
            )
            python_ref = next(
                (r for r in valid_refs if "setup-python" in r), None
            )
            # Find python version from matrix
            py_version = next(
                (e.get("version", "") for e in matrix_entries if e.get("lang") == "python"),
                "",
            )
            if uv_ref:
                steps.append({"uses": uv_ref})
                if py_version:
                    steps[-1] = {"uses": uv_ref, "with": {"python-version": py_version}}
            elif python_ref:
                step: dict = {"uses": python_ref}
                if py_version:
                    step["with"] = {"python-version": py_version}
                steps.append(step)
        elif "ts" in job_id or "node" in job_id:
            # Find package manager from matrix
            pm = next(
                (e.get("pm", "bun") for e in matrix_entries if e.get("lang") == "ts"),
                "bun",
            )
            if pm == "bun":
                bun_ref = next(
                    (r for r in valid_refs if "setup-bun" in r), None
                )
                if bun_ref:
                    steps.append({"uses": bun_ref})
            else:
                node_ref = next(
                    (r for r in valid_refs if "setup-node" in r), None
                )
                if node_ref:
                    steps.append({"uses": node_ref})
        elif "go" in job_id:
            go_ref = next(
                (r for r in valid_refs if "setup-go" in r), None
            )
            go_version = next(
                (e.get("version", "") for e in matrix_entries if e.get("lang") == "go"),
                "",
            )
            if go_ref:
                step = {"uses": go_ref}
                if go_version:
                    step["with"] = {"go-version": go_version}
                steps.append(step)
        elif "rust" in job_id:
            rust_ref = next(
                (r for r in valid_refs if "rust-toolchain" in r or "rust" in r), None
            )
            if rust_ref:
                steps.append({"uses": rust_ref})

        # Install `just` if any command uses it (green-theater guard: CI must not
        # be green-while-doing-nothing because `just` is not on ubuntu-latest).
        if any(cmd.startswith("just ") or cmd == "just" for cmd in valid_commands):
            steps.append({
                "name": "Install just",
                "uses": "taiki-e/install-action@v2",
                "with": {"tool": "just"},
            })

        # Command steps — filter to those relevant to this job
        for cmd in valid_commands:
            steps.append({"name": f"Run: {cmd}", "run": cmd})

        # Build the job definition
        job_def: dict = {
            "name": job_id.replace("-", " ").title(),
            "runs-on": "ubuntu-latest",
        }

        # Matrix strategy — only if this job has a relevant matrix entry
        job_lang = None
        if "python" in job_id:
            job_lang = "python"
        elif "ts" in job_id:
            job_lang = "ts"
        elif "go" in job_id:
            job_lang = "go"
        elif "rust" in job_id:
            job_lang = "rust"

        lang_entry = next(
            (e for e in matrix_entries if e.get("lang") == job_lang),
            None,
        ) if job_lang else None

        if lang_entry and len(lang_entry) > 1:
            # Only add matrix if there's meaningful version info
            strategy_matrix: dict = {}
            if "version" in lang_entry:
                strategy_matrix[f"{job_lang}-version"] = [lang_entry["version"]]
            elif "pm" in lang_entry:
                strategy_matrix["pm"] = [lang_entry["pm"]]
            if strategy_matrix:
                job_def["strategy"] = {"matrix": strategy_matrix}

        job_def["steps"] = steps
        jobs[job_id] = job_def

    return jobs


# --------------------------------------------------------------------------- #
# Main write step                                                               #
# --------------------------------------------------------------------------- #

def _do_write(sdk, inputs, args) -> int:
    """write step: validate ci_plan, render canonical YAML, write ci.yml."""

    # ── 1. Load frozen ci_plan_* answers ─────────────────────────────────── #
    job_ids: list[str] = inputs.get_list("ci_plan_jobs", default=[])
    action_refs: list[str] = inputs.get_list("ci_plan_action_refs", default=[])
    matrix_raw: str = inputs.get_str("ci_plan_matrix", default="[]")
    commands: list[str] = inputs.get_list("ci_plan_commands", default=[])

    # Also read user-facing inputs
    ci_triggers: list[str] = inputs.get_list("ci_trigger", default=["push", "pull_request"])
    default_branch: str = inputs.get_str("default_branch", default="main")
    use_just: bool = inputs.get_bool("use_just", default=True)

    project_dir_env = os.environ.get("PROJECT_DIR", "")
    project_dir = Path(project_dir_env) if project_dir_env else Path.cwd()

    warnings: list[str] = []

    # ── 2. Parse matrix JSON ─────────────────────────────────────────────── #
    try:
        matrix_entries: list[dict] = json.loads(matrix_raw) if matrix_raw else []
        if not isinstance(matrix_entries, list):
            matrix_entries = []
    except (json.JSONDecodeError, TypeError):
        warnings.append(f"ci_plan_matrix is not valid JSON ({matrix_raw!r}) — using empty matrix")
        matrix_entries = []

    # ── 3. Matrix trimming (FR-015): trim to frozen python_version ────────── #
    # Read cross-module frozen answers via load_plan to get frozen python_version
    try:
        full_plan = sdk.load_plan(Path(args.plan))
        py_mod = getattr(full_plan, "modules", {}).get("lang-python")
        frozen_python_version = None
        if py_mod is not None:
            frozen_python_version = (py_mod.answers or {}).get("python_version")
        if frozen_python_version:
            new_matrix = []
            for entry in matrix_entries:
                if entry.get("lang") == "python":
                    if entry.get("version") != frozen_python_version:
                        warnings.append(
                            f"matrix python version {entry.get('version')!r} differs from "
                            f"frozen python_version {frozen_python_version!r} — trimming to frozen"
                        )
                        entry = {**entry, "version": frozen_python_version}
                new_matrix.append(entry)
            matrix_entries = new_matrix
    except Exception:
        # load_plan failure is non-fatal for matrix trimming
        pass

    # ── 4. Validate action refs (FR-012d) ─────────────────────────────────── #
    valid_refs, fixme_refs, ref_warnings = _validate_action_refs(action_refs)
    warnings.extend(ref_warnings)

    # ── 5. Load on-disk validation artifacts ─────────────────────────────── #
    justfile_recipes = _load_justfile_recipes(project_dir)
    pkg_scripts = _load_package_json_scripts(project_dir)

    # ── 6. Validate commands (FR-012) ─────────────────────────────────────── #
    valid_commands, cmd_warnings = _validate_commands(
        commands,
        use_just=use_just,
        justfile_recipes=justfile_recipes,
        pkg_scripts=pkg_scripts,
        project_dir=project_dir,
    )
    warnings.extend(cmd_warnings)

    # ── 7. Zero-jobs guard (FR-014) ──────────────────────────────────────── #
    if not job_ids:
        if inputs.mode == "init":
            warnings.append(
                "WARN: ci-github-actions produced no ci_plan_jobs — the resolve "
                "agent step did not run or returned empty; .github/workflows/ci.yml "
                "will not be written. Re-run with --refresh ci-github-actions to "
                "trigger the agent."
            )
        else:
            warnings.append("ci_plan_jobs is empty — no CI workflow written")
        result = sdk.ModuleResult(
            module_id="ci-github-actions",
            step_id=args.step,
            status="ok",
            files_written=[],
            diffs=[],
            warnings=warnings,
        )
        sdk.emit_result(result)
        return 0

    # ── 8. Build jobs dict ────────────────────────────────────────────────── #
    jobs = _build_jobs(
        job_ids=job_ids,
        matrix_entries=matrix_entries,
        valid_refs=valid_refs,
        fixme_refs=fixme_refs,
        valid_commands=valid_commands,
    )

    # ── 9. Zero-valid-jobs guard (FR-014) — after command stripping ───────── #
    # A job with no run steps (only setup steps) is still useful. Zero-valid-
    # commands means no run steps, but the job itself is still present.
    # We only abort if job_ids was non-empty but all jobs ended up empty of steps
    # AND there were no valid commands at all and no setup steps. Instead, we check
    # the simpler spec rule: "zero valid jobs after validation → files_written=[]".
    # The spec's SC-008 says "commands all drop → files_written=[], warning".
    if commands and not valid_commands:
        warnings.append(
            "all ci_plan_commands were dropped during validation — no CI workflow written"
        )
        result = sdk.ModuleResult(
            module_id="ci-github-actions",
            step_id=args.step,
            status="ok",
            files_written=[],
            diffs=[],
            warnings=warnings,
        )
        sdk.emit_result(result)
        return 0

    # ── 10. Build the on: block ────────────────────────────────────────────── #
    on_block = _build_on_block(ci_triggers, default_branch)

    # ── 11. Build the full plan dict and render YAML (FR-013, SC-006) ─────── #
    plan_dict: dict = {
        "name": "CI",
        "on": on_block,
        "jobs": jobs,
    }
    # FIXME placeholders for floating refs are inserted structurally as header
    # comments (right after `name:`), not via post-hoc string surgery on the output.
    yaml_content = render_ci_yaml(plan_dict, header_comments=fixme_refs or None)

    # ── 12. Write idempotently (FR-011) ───────────────────────────────────── #
    diff = sdk.idempotent_write(
        ".github/workflows/ci.yml",
        yaml_content,
        reconcile=True,
        inspect=args.inspect,
    )

    files_written = [diff.path] if diff.kind in ("create", "modify") else []
    result = sdk.ModuleResult(
        module_id="ci-github-actions",
        step_id=args.step,
        status="ok",
        files_written=files_written,
        diffs=[diff],
        warnings=warnings,
    )
    sdk.emit_result(result)
    return 0


# --------------------------------------------------------------------------- #
# Entry point                                                                  #
# --------------------------------------------------------------------------- #

STEP_HANDLERS = {
    "write": _do_write,
    # "resolve"   is kind=agent  — dispatched by the runner's Tier-2 agent subsystem.
    # "ci-review" is kind=gate   — dispatched by the runner's gate subsystem.
}


def main() -> int:
    ap = argparse.ArgumentParser(description="ci-github-actions module")
    ap.add_argument("--plan", required=True, help="path to frozen plan.json")
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
    inputs = sdk.load_frozen_inputs(args.plan, module_id="ci-github-actions")
    return handler(sdk, inputs, args)


if __name__ == "__main__":
    raise SystemExit(main())
