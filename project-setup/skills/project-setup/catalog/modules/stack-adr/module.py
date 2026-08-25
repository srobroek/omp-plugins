# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""stack-adr — write a deterministic STACK.md (or ADR) from frozen stack decisions.

Part 1 (this file): a pure-python write step that reads every resolver module's
frozen answers from the plan (any module carrying pinned_deps, framework, or
rationale), renders the record from a verbatim template, and writes it
idempotently with reconcile=True. Runs in BOTH init and reproduce modes.

Part 2 (staleness/staleness-gate): a reproduce-only kind=agent + informational
gate pair handled entirely by the runner. The agent emits no answers_to_persist
(FR-012); it only emits a message advisory. Module.py has no handler for those
steps.

Date determinism (plan.md "written_at determinism subtlety"):
  freeze() is called on every run, so plan.written_at is always today. If the
  write step read plan.written_at directly, a reproduce on a later date would
  produce a different STACK.md (byte-identity broken, FR-016). Instead, at first
  init the step seeds written_at from plan.written_at and persists it as a
  DERIVED answer in answers_to_persist. On every subsequent run (reproduce),
  the committed written_at answer is in the frozen plan → read unchanged → same
  date → byte-identical output. plan.written_at still reflects the current run
  (it's honest), but the STACK.md date comes from the frozen derived answer.

Steps handled by module.py (kind=python):
  write — collect resolver modules, render template, write, emit answers_to_persist

Agent + gate steps (staleness, staleness-gate) are handled by the runner; they
never reach module.py.

Invoked by the runner as:
    uv run module.py --plan <frozen_plan.json> --step <write> [--inspect]
"""

from __future__ import annotations

import argparse
import glob
import importlib.util
import os
import re
import sys
from pathlib import Path

_TEMPLATES = Path(__file__).resolve().parent / "templates"

# Answer keys that identify a module as a "resolver module" (one that carries
# a stack decision). We discover by key presence — NOT by module id — so future
# resolvers (lang-go, lang-rust, package-add) are picked up without code changes
# (spec 012 FR-004).
_RESOLVER_ANSWER_KEYS = frozenset({"pinned_deps", "framework", "rationale"})


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


def _collect_resolver_modules(plan) -> list[tuple[str, dict]]:
    """Iterate all plan modules in plan.order; return those that carry at least
    one of pinned_deps / framework / rationale in their answers.

    Returns a list of (module_id, answers_dict) in plan order.
    No hard-coded module ids — discovery is purely by answer-key presence.
    """
    result = []
    for mod_id in plan.order:
        pm = plan.modules.get(mod_id)
        if pm is None:
            continue
        answers = pm.answers or {}
        if _RESOLVER_ANSWER_KEYS & set(answers.keys()):
            result.append((mod_id, answers))
    return result


def _render_context_section(resolver_modules: list[tuple[str, dict]]) -> str:
    """Build the Context section body listing framework + ecosystem per resolver."""
    if not resolver_modules:
        return "No resolver decisions recorded — no lang-* module was enabled."
    lines = []
    for mod_id, answers in resolver_modules:
        framework = answers.get("framework", "")
        ecosystem = answers.get("ecosystem", "")
        # Infer ecosystem from module id if not explicitly set.
        if not ecosystem:
            if "python" in mod_id:
                ecosystem = "pypi"
            elif "ts" in mod_id or "typescript" in mod_id or "node" in mod_id:
                ecosystem = "npm"
        label = framework or mod_id
        eco_str = f" ({ecosystem})" if ecosystem else ""
        lines.append(f"- **{mod_id}**: framework `{label}`{eco_str}")
    return "\n".join(lines)


def _render_decision_section(resolver_modules: list[tuple[str, dict]]) -> str:
    """Build the Decision section with a pinned-deps table per resolver module."""
    if not resolver_modules:
        return "No pinned dependencies recorded."
    sections = []
    for mod_id, answers in resolver_modules:
        pinned_deps = answers.get("pinned_deps", [])
        if not isinstance(pinned_deps, list):
            pinned_deps = []
        if not pinned_deps:
            sections.append(f"### {mod_id}\n\nNo pinned dependencies recorded.")
            continue
        lines = [f"### {mod_id}", "", "| Package | Pinned Version |", "|---------|---------------|"]
        for dep in pinned_deps:
            dep_str = str(dep)
            # Split on @ but keep scoped npm packages (e.g. @types/node@18.0.0).
            # Strategy: find the LAST @ that is not the first character.
            at_idx = dep_str.rfind("@")
            if at_idx > 0:
                pkg = dep_str[:at_idx]
                ver = dep_str[at_idx + 1:]
            else:
                pkg = dep_str
                ver = ""
            lines.append(f"| `{pkg}` | `{ver}` |" if ver else f"| `{pkg}` | — |")
        sections.append("\n".join(lines))
    return "\n\n".join(sections)


def _render_rationale_section(resolver_modules: list[tuple[str, dict]]) -> str:
    """Build the Rationale section combining rationale text from each resolver."""
    if not resolver_modules:
        return "No rationale recorded."
    parts = []
    for mod_id, answers in resolver_modules:
        rationale = answers.get("rationale", "")
        if rationale and isinstance(rationale, str) and rationale.strip():
            parts.append(f"### {mod_id}\n\n{rationale.strip()}")
    if not parts:
        return "No rationale recorded."
    return "\n\n".join(parts)


def _scan_adr_number(adr_dir: Path) -> int:
    """Scan adr_dir for NNN-*.md files and return max(found_numbers, default=0) + 1.

    Uses sorted(glob) for determinism. If the directory does not exist, returns 1.
    """
    if not adr_dir.exists():
        return 1
    pattern = str(adr_dir / "*.md")
    files = sorted(glob.glob(pattern))
    found = []
    for f in files:
        name = Path(f).name
        m = re.match(r"^(\d{3})-", name)
        if m:
            found.append(int(m.group(1)))
    return (max(found) if found else 0) + 1


def _render_from_template(template_name: str, substitutions: dict[str, str]) -> str:
    """Load template_name from templates/ and apply placeholder substitutions.

    Single-pass substitution via sorted-longest-first alternation so a user value
    containing another placeholder token cannot be double-substituted.
    Raises FileNotFoundError if the template is missing.
    """
    template_file = _TEMPLATES / template_name
    body = template_file.read_text(encoding="utf-8")
    # Sort keys longest-first to avoid partial-match issues with overlapping names.
    keys_sorted = sorted(substitutions.keys(), key=len, reverse=True)
    pattern = re.compile("|".join(re.escape(k) for k in keys_sorted))
    return pattern.sub(lambda m: substitutions[m.group(0)], body)


# --------------------------------------------------------------------------- #
# Step handlers                                                                #
# --------------------------------------------------------------------------- #

def _do_write(sdk, inputs, args) -> int:
    """write step: collect resolver module answers, render template, write idempotently.

    DATE DETERMINISM (plan.md "written_at determinism subtlety"):
    1. Read the frozen written_at DERIVED ANSWER first (inputs.get_str).
    2. If absent (first init), seed from plan.written_at (the top-level field,
       set at freeze() time to today's date).
    3. If plan.written_at is also empty (pre-012 plan), fall back to "unknown".
    4. Persist written_at as a DERIVED answer so reproduce reads the SAME date.
    Never read datetime.now() / time.time() / wall-clock here (FR-007).
    """
    # ── 1. Load full plan to discover resolver modules (FR-004) ─────────────── #
    plan = sdk.load_plan(Path(args.plan))

    # ── 2. Resolve the date — derived answer first, then plan field (subtlety) ── #
    written_at = inputs.get_str("written_at", default="")
    if not written_at:
        # First init: seed from the plan-level written_at set by freeze().
        written_at = getattr(plan, "written_at", "") or "unknown"

    # ── 3. Resolve format + adr_path ────────────────────────────────────────── #
    fmt = inputs.get_choice("format", default="simple")
    frozen_adr_path = inputs.get_str("adr_path", default="")

    project_dir_str = os.environ.get("PROJECT_DIR", "")
    project_dir = Path(project_dir_str) if project_dir_str else Path.cwd()

    answers_to_persist: dict = {}
    warnings: list[str] = []

    if fmt == "adr":
        if frozen_adr_path:
            # Reproduce path: use the exact frozen path, no re-scan (FR-006c).
            out_rel = frozen_adr_path
        else:
            # First init: scan docs/adr/ for existing NNN-*.md, assign max+1.
            adr_dir = project_dir / "docs" / "adr"
            num = _scan_adr_number(adr_dir)
            num_str = f"{num:03d}"
            out_rel = f"docs/adr/{num_str}-stack-decision.md"
            # Persist so reproduce writes the SAME path without re-scanning (FR-006c).
            answers_to_persist["adr_path"] = {"value": out_rel, "source": "derived"}
    else:
        out_rel = "docs/decisions/STACK.md"

    # ── 4. Collect resolver modules in plan order (FR-004) ──────────────────── #
    resolver_modules = _collect_resolver_modules(plan)

    # ── 5. Build template substitutions (FR-008) ─────────────────────────────── #
    context_section = _render_context_section(resolver_modules)
    decision_section = _render_decision_section(resolver_modules)
    rationale_section = _render_rationale_section(resolver_modules)

    substitutions: dict[str, str] = {
        "WRITTEN_AT": written_at,
        "CONTEXT_SECTION": context_section,
        "DECISION_SECTION": decision_section,
        "RATIONALE_SECTION": rationale_section,
    }

    if fmt == "adr":
        # Extract ADR number from the path for the title placeholder.
        adr_num_match = re.search(r"(\d{3})-stack-decision", out_rel)
        adr_number = adr_num_match.group(1) if adr_num_match else "001"
        substitutions["ADR_NUMBER"] = adr_number
        template_name = "adr.md"
    else:
        template_name = "stack.md"

    body = _render_from_template(template_name, substitutions)

    # ── 6. Persist written_at as DERIVED answer (determinism fix) ─────────────── #
    # Persist written_at even if it was already frozen — idempotent re-emit is fine
    # (the persist stage only updates if the value changed, and it won't have).
    answers_to_persist["written_at"] = {"value": written_at, "source": "derived"}

    # ── 7. Write idempotently ────────────────────────────────────────────────── #
    diff = sdk.idempotent_write(
        out_rel,
        body,
        reconcile=True,
        inspect=args.inspect,
    )

    files_written = [diff.path] if diff.kind in ("create", "modify") else []
    result = sdk.ModuleResult(
        module_id="stack-adr",
        step_id=args.step,
        status="ok",
        files_written=files_written,
        diffs=[diff],
        warnings=warnings,
        answers_to_persist=answers_to_persist,
    )
    sdk.emit_result(result)
    return 0


STEP_HANDLERS = {
    "write": _do_write,
    # "staleness"       is kind=agent  — handled by the runner's Tier-2 agent subsystem.
    # "staleness-gate"  is kind=gate   — handled by the runner's gate subsystem.
}


def main() -> int:
    ap = argparse.ArgumentParser(description="stack-adr module")
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
    inputs = sdk.load_frozen_inputs(args.plan, module_id="stack-adr")
    return handler(sdk, inputs, args)


if __name__ == "__main__":
    raise SystemExit(main())
