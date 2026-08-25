# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""lang-python — Python language overlay (Tier-2 stack resolver).

Ports setup-python.sh (119 lines) to a native-root Python module, upgraded with
a Tier-2 agent resolver step that decides the fully-pinned stack.

Steps:
  resolve  (agent)  — Tier-2 agent maps prose intent → framework + pinned deps
  pins     (gate)   — shows the frozen pin table; user confirms before any write
  write    (python) — reads frozen pins from plan, verifies against PyPI,
                      writes pyproject.toml + dev tooling, appends .gitignore +
                      pre-commit hooks using the frozen ruff version

Pin verification (init mode only, FR-005/FR-012):
  - PIN_DISCONFIRMED → hard error, write nothing
  - PIN_UNREACHABLE  → safe-skip the manifest write, emit warning (not error)
  - PIN_VERIFIED     → proceed

Reproduce mode: zero network — verification is skipped entirely (FR-009); the
pins were verified at init and the decision is replayed from answers.toml.

External tool absence/failure is NON-FATAL: a warning is emitted and the
module continues.  This mirrors the legacy WARN pattern in setup-python.sh.

Invoked by the runner as:
    uv run module.py --plan <frozen_plan.json> --step write [--inspect]
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import sys
import tomllib
from pathlib import Path

_TEMPLATES = Path(__file__).resolve().parent / "templates"


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
# --------------------------------------------------------------------------- #
# pyproject.toml dep-merging helpers (stdlib tomllib + hand-rolled render)    #
# --------------------------------------------------------------------------- #

def _parse_pyproject_deps(pyproject_path: Path) -> tuple[list[str], list[str]]:
    """Read existing [project].dependencies and [dependency-groups].dev lists.

    Returns (runtime_deps, dev_deps) as lists of strings, or empty lists if
    absent/unparseable.  Never raises.
    """
    if not pyproject_path.exists():
        return [], []
    try:
        with pyproject_path.open("rb") as fh:
            data = tomllib.load(fh)
        runtime = list(data.get("project", {}).get("dependencies", []))
        dev = list(data.get("dependency-groups", {}).get("dev", []))
        return runtime, dev
    except Exception:  # noqa: BLE001
        return [], []


def _to_pep508(pin: str) -> str:
    """Convert an internal ``name@version`` pin to PEP 508 ``name==version``.

    Idempotent: pins already using ``==`` pass through unchanged. Pins without
    a version separator (bare names) pass through unchanged. Splits on the LAST
    ``@`` to handle scoped package names gracefully.
    """
    if "==" in pin:
        return pin
    if "@" not in pin:
        return pin
    name, version = pin.rsplit("@", 1)
    return f"{name}=={version}"


def _merge_deps(existing: list[str], new_pins: list[str]) -> list[str]:
    """Merge *new_pins* into *existing*, replacing any entry that shares a package
    name with a pin from *new_pins*.  Returns a sorted, deduplicated list.

    Package name is the part before '@' or '==' (lowercased, with '-' normalized to '_').
    """
    def _name(pin: str) -> str:
        # Split on '==' first, then '@' for the internal format
        if "==" in pin:
            return pin.split("==")[0].lower().replace("-", "_")
        return pin.split("@")[0].lower().replace("-", "_")

    new_by_name = {_name(p): p for p in new_pins}
    merged = {}
    for dep in existing:
        n = _name(dep)
        if n not in new_by_name:
            merged[n] = dep
    for n, pin in new_by_name.items():
        merged[n] = pin
    return sorted(merged.values())


def _render_toml_string_list(items: list[str]) -> str:
    """Render a list of strings as a TOML array value (multi-line if >0 items)."""
    if not items:
        return "[]"
    inner = ",\n".join(f'  "{item}"' for item in items)
    return f"[\n{inner},\n]"


def _patch_pyproject_deps(
    pyproject_path: Path,
    runtime_pins: list[str],
    dev_pins: list[str],
    warnings: list[str],
) -> bool:
    """Write merged runtime + dev deps into pyproject.toml.

    Strategy: read existing deps → merge with new pins → rewrite the
    [project].dependencies and [dependency-groups].dev blocks in-place using
    line-level text replacement.  Falls back to appending the blocks if they
    are absent.  Returns True if the file was modified.  Never raises.
    """
    if not pyproject_path.exists():
        warnings.append("WARN: pyproject.toml absent — cannot patch deps (run uv init first)")
        return False
    try:
        existing_rt, existing_dev = _parse_pyproject_deps(pyproject_path)
        merged_rt = [_to_pep508(p) for p in _merge_deps(existing_rt, runtime_pins)]
        merged_dev = [_to_pep508(p) for p in _merge_deps(existing_dev, dev_pins)]

        content = pyproject_path.read_text(encoding="utf-8")

        # ── patch [project].dependencies ─────────────────────────────────── #
        content = _replace_or_append_toml_list(
            content,
            section="project",
            key="dependencies",
            new_values=merged_rt,
        )

        # ── patch [dependency-groups].dev ────────────────────────────────── #
        content = _replace_or_append_toml_section_key(
            content,
            section_header="[dependency-groups]",
            key="dev",
            new_values=merged_dev,
        )

        pyproject_path.write_text(content, encoding="utf-8")
        return True
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"WARN: could not patch pyproject.toml deps: {exc}")
        return False


def _replace_or_append_toml_list(
    content: str,
    section: str,
    key: str,
    new_values: list[str],
) -> str:
    """Replace `key = [...]` inside `[section]` in *content*, or append it.

    Handles both single-line and multi-line arrays.  If the section does not
    exist, appends `[section]\\nkey = [...]`.  If the key does not exist inside
    the section, appends it after the section header.
    """
    import re
    rendered = _render_toml_string_list(new_values)
    new_line = f"{key} = {rendered}"

    # Match single-line: key = [...]
    single = re.compile(
        rf'^({re.escape(key)}\s*=\s*)\[([^\]]*)\]',
        re.MULTILINE,
    )
    # Match multi-line: key = [\n...\n]
    multi = re.compile(
        rf'^({re.escape(key)}\s*=\s*)\[([^\]]*)\]',
        re.MULTILINE | re.DOTALL,
    )

    # Try to find and replace within the right section
    section_pat = re.compile(rf'^\[{re.escape(section)}\]', re.MULTILINE)
    m_sec = section_pat.search(content)
    if m_sec:
        # Find the next section header after this one
        next_sec = re.compile(r'^\[', re.MULTILINE)
        m_next = next_sec.search(content, m_sec.end())
        end = m_next.start() if m_next else len(content)
        section_text = content[m_sec.start():end]

        key_pat = re.compile(
            rf'^{re.escape(key)}\s*=\s*\[.*?\]',
            re.MULTILINE | re.DOTALL,
        )
        m_key = key_pat.search(section_text)
        if m_key:
            # Replace the key block
            new_section = (
                section_text[:m_key.start()]
                + new_line
                + section_text[m_key.end():]
            )
            return content[:m_sec.start()] + new_section + content[end:]
        else:
            # Append key after the section header line
            header_end = section_text.index("\n") + 1 if "\n" in section_text else len(section_text)
            new_section = (
                section_text[:header_end]
                + new_line + "\n"
                + section_text[header_end:]
            )
            return content[:m_sec.start()] + new_section + content[end:]
    else:
        # Append entire section
        sep = "\n" if content.endswith("\n") else "\n\n"
        return content + sep + f"[{section}]\n{new_line}\n"


def _replace_or_append_toml_section_key(
    content: str,
    section_header: str,
    key: str,
    new_values: list[str],
) -> str:
    """Replace `key = [...]` inside a section identified by its full header string.

    If the section or key does not exist, append them.
    """
    import re
    rendered = _render_toml_string_list(new_values)
    new_line = f"{key} = {rendered}"

    sec_pat = re.compile(r'^' + re.escape(section_header), re.MULTILINE)
    m_sec = sec_pat.search(content)
    if m_sec:
        next_sec = re.compile(r'^\[', re.MULTILINE)
        m_next = next_sec.search(content, m_sec.end())
        end = m_next.start() if m_next else len(content)
        section_text = content[m_sec.start():end]

        key_pat = re.compile(
            rf'^{re.escape(key)}\s*=\s*\[.*?\]',
            re.MULTILINE | re.DOTALL,
        )
        m_key = key_pat.search(section_text)
        if m_key:
            new_section = (
                section_text[:m_key.start()]
                + new_line
                + section_text[m_key.end():]
            )
            return content[:m_sec.start()] + new_section + content[end:]
        else:
            header_end = section_text.index("\n") + 1 if "\n" in section_text else len(section_text)
            new_section = (
                section_text[:header_end]
                + new_line + "\n"
                + section_text[header_end:]
            )
            return content[:m_sec.start()] + new_section + content[end:]
    else:
        sep = "\n" if content.endswith("\n") else "\n\n"
        return content + sep + f"{section_header}\n{new_line}\n"


# --------------------------------------------------------------------------- #
# Step handlers                                                                #
# --------------------------------------------------------------------------- #

def _do_write(sdk, inputs, args) -> int:
    """write step: verify pins (init only), then write pyproject.toml + tooling."""
    python_version: str = inputs.get_str("python_version", default="3.13")
    framework: str = inputs.get_str("framework", default="none")
    pinned_deps: list[str] = inputs.get_list("pinned_deps", default=[])
    dev_deps: list[str] = inputs.get_list("dev_deps", default=[])
    ruff_version: str = inputs.get_str("ruff_version", default="")
    # Project/package identity comes from the answer (mirrors agents-md, which
    # declares its own project_name input). Fall back to the directory name only
    # when unset, so existing behavior is preserved for answer-less runs.
    description: str = inputs.get_str("description", default="")

    project_dir_env = os.environ.get("PROJECT_DIR")
    project_dir = Path(project_dir_env).resolve() if project_dir_env else Path.cwd().resolve()

    warnings: list[str] = []
    diffs = []
    files_written: list[str] = []

    # ── Pin verification (init mode only, FR-005/FR-012) ───────────────────── #
    all_pins = list(pinned_deps) + list(dev_deps)
    if all_pins and inputs.mode == "init":
        verify_result = sdk.verify_pins(all_pins, "pypi")

        bad_pins = [p for p, s in verify_result.items() if s == sdk.PIN_DISCONFIRMED]
        if bad_pins:
            error = sdk.SetupError(
                error_code=sdk.ErrorCode.INPUT_VALUE_INVALID,
                module_id="lang-python",
                expected="all pins to exist on PyPI",
                received=f"disconfirmed pins: {bad_pins}",
                how_to_fix=(
                    "The agent proposed pins that do not exist on PyPI: "
                    + ", ".join(bad_pins)
                    + ". Re-run with --refresh lang-python to let the agent correct them."
                ),
            )
            result = sdk.ModuleResult(
                module_id="lang-python",
                step_id=args.step,
                status="error",
                files_written=[],
                diffs=[],
                warnings=warnings,
                error=error.to_dict(),
            )
            sdk.emit_result(result)
            return 1

        unreachable_pins = [p for p, s in verify_result.items() if s == sdk.PIN_UNREACHABLE]
        if unreachable_pins:
            warnings.append(
                "WARN: registry unreachable for pins: "
                + ", ".join(unreachable_pins)
                + " — manifest write SKIPPED (safe-skip, FR-012). "
                "Restore network connectivity and re-run to write the manifest."
            )
            result = sdk.ModuleResult(
                module_id="lang-python",
                step_id=args.step,
                status="ok",
                files_written=[],
                diffs=[sdk.Diff(
                    path="pyproject.toml",
                    kind="skip",
                    preview="(safe-skip: registry unreachable for some pins)",
                )],
                warnings=warnings,
            )
            sdk.emit_result(result)
            return 0

    # Package identity: prefer the explicit project_name answer; only fall back
    # to the directory name when it is absent. Normalize to a valid Python
    # package identifier (PEP 8 / importable): lowercase, '-'→'_'.
    raw_name = inputs.get_str("project_name", default="") or project_dir.name
    project_name = raw_name.strip().lower().replace("-", "_")

    # ── 1. uv init ─────────────────────────────────────────────────────────── #
    # --package: produces an installable package (adds [build-system] +
    #   src/<name>/ layout + [project.scripts]) and NO stray root main.py.
    # --name: names the project after the answer, not the directory.
    # --no-readme: readme-draft owns README.md; don't let uv pre-create a stub
    #   that the (reconcile=false) readme write step would then refuse to clobber.
    pyproject = project_dir / "pyproject.toml"
    if not pyproject.exists():
        if not args.inspect:
            sdk.run_tool(
                ["uv", "init", "--name", project_name, "--package",
                 "--no-readme", "--python", python_version],
                cwd=project_dir,
                warnings=warnings,
                label="uv init",
            )
        else:
            warnings.append(
                f"inspect: would run uv init --name {project_name} --package "
                f"--no-readme --python {python_version}"
            )

    # ── 2. src layout ──────────────────────────────────────────────────────── #
    # uv init --package already created src/<name>/__init__.py; ensure it exists
    # for the answer-less / pre-existing-pyproject path too.
    src_dir = project_dir / "src" / project_name
    init_rel = f"src/{project_name}/__init__.py"
    if not args.inspect:
        src_dir.mkdir(parents=True, exist_ok=True)
    init_body = ""
    diff = sdk.idempotent_write(
        init_rel,
        init_body,
        project_dir=project_dir,
        reconcile=False,
        inspect=args.inspect,
    )
    diffs.append(diff)
    if diff.kind in ("create", "modify"):
        files_written.append(diff.path)

    # ── 2b. Sync description into pyproject (replace uv's placeholder) ──────── #
    # `uv init` writes `description = "Add your description here"`. If the agent
    # supplied a real description, replace that placeholder in-place so the
    # manifest reflects the project, not uv's default.
    if description and not args.inspect and pyproject.exists():
        try:
            import re as _re
            _content = pyproject.read_text(encoding="utf-8")
            _esc = description.replace("\\", "\\\\").replace('"', '\\"')
            _new, _n = _re.subn(
                r'^(description\s*=\s*)".*"',
                lambda m: f'{m.group(1)}"{_esc}"',
                _content,
                count=1,
                flags=_re.MULTILINE,
            )
            if _n and _new != _content:
                pyproject.write_text(_new, encoding="utf-8")
                if "pyproject.toml" not in files_written:
                    files_written.append("pyproject.toml")
                diffs.append(sdk.Diff(path="pyproject.toml", kind="modify",
                                      preview="(description synced)"))
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"WARN: could not sync description into pyproject.toml: {exc}")

    # ── 3. Ruff config in pyproject.toml ───────────────────────────────────── #
    ruff_block = (_TEMPLATES / "ruff-config.toml").read_text(encoding="utf-8")
    if not args.inspect:
        appended = sdk.append_if_absent(
            pyproject, "ruff", ruff_block, warnings, "ruff config"
        )
        if appended:
            files_written.append("pyproject.toml")
            diffs.append(sdk.Diff(path="pyproject.toml", kind="modify", preview="(ruff config appended)"))
        else:
            diffs.append(sdk.Diff(path="pyproject.toml", kind="skip", preview="(ruff already present)"))
    else:
        existing_toml = pyproject.read_text(encoding="utf-8") if pyproject.exists() else ""
        if "ruff" not in existing_toml:
            diffs.append(sdk.Diff(path="pyproject.toml", kind="modify", preview="(would append ruff config)"))
        else:
            diffs.append(sdk.Diff(path="pyproject.toml", kind="skip", preview="(ruff already present)"))

    # ── 4. Write pinned deps into pyproject.toml ───────────────────────────── #
    if all_pins and not args.inspect:
        patched = _patch_pyproject_deps(
            pyproject,
            runtime_pins=list(pinned_deps),
            dev_pins=list(dev_deps),
            warnings=warnings,
        )
        if patched:
            if "pyproject.toml" not in files_written:
                files_written.append("pyproject.toml")
            diffs.append(sdk.Diff(
                path="pyproject.toml",
                kind="modify",
                preview=f"(pinned deps written: {len(pinned_deps)} runtime, {len(dev_deps)} dev)",
            ))
        # else: warning already appended by _patch_pyproject_deps
    elif all_pins and args.inspect:
        diffs.append(sdk.Diff(
            path="pyproject.toml",
            kind="modify",
            preview=(
                f"(would write {len(pinned_deps)} runtime pins + {len(dev_deps)} dev pins)"
            ),
        ))

    # ── 5. uv add pinned dev deps (replaces unpinned uv add --dev ruff pytest) #
    if dev_deps and not args.inspect:
        # Build the uv add command with exact pinned versions
        # uv add --dev accepts name==version or name@version; use == form for pip compat
        uv_dev_args = ["uv", "add", "--dev"] + [
            p.replace("@", "==", 1) for p in dev_deps
        ]
        sdk.run_tool(
            uv_dev_args,
            cwd=project_dir,
            warnings=warnings,
            label="uv add --dev (pinned)",
        )
    elif not dev_deps and not args.inspect:
        # No agent-resolved dev deps — fall back: warn but do NOT install unpinned
        warnings.append(
            "WARN: no pinned dev_deps in frozen plan — skipping uv add --dev. "
            "Re-run with the resolve step to get pinned dev tools."
        )

    # ── 6. Append Python .gitignore block ──────────────────────────────────── #
    gitignore = project_dir / ".gitignore"
    gi_block = (_TEMPLATES / "gitignore-block.txt").read_text(encoding="utf-8")
    if not args.inspect:
        appended = sdk.append_if_absent(
            gitignore, "__pycache__", gi_block, warnings, "Python .gitignore"
        )
        if appended:
            files_written.append(".gitignore")
            diffs.append(sdk.Diff(path=".gitignore", kind="modify", preview="(Python gitignore block appended)"))
        else:
            diffs.append(sdk.Diff(path=".gitignore", kind="skip", preview="(__pycache__ already present)"))
    else:
        existing_gi = gitignore.read_text(encoding="utf-8") if gitignore.exists() else ""
        if "__pycache__" not in existing_gi:
            diffs.append(sdk.Diff(path=".gitignore", kind="modify", preview="(would append Python gitignore block)"))
        else:
            diffs.append(sdk.Diff(path=".gitignore", kind="skip", preview="(__pycache__ already present)"))

    # ── 7. Append ruff pre-commit hooks (with frozen ruff_version) ─────────── #
    precommit = project_dir / ".pre-commit-config.yaml"
    # Derive the pre-commit block, substituting ruff_version if available (FR-014)
    pc_block_raw = (_TEMPLATES / "precommit-block.yaml").read_text(encoding="utf-8")
    if ruff_version:
        # Replace hardcoded rev with the frozen ruff pin version
        pc_block = pc_block_raw.replace("rev: v0.6.9", f"rev: v{ruff_version}")
        # Guard: if the template rev was already something else, do a broader replace
        import re as _re
        pc_block = _re.sub(r'(rev:\s*)v[\d.]+', rf'\1v{ruff_version}', pc_block)
    else:
        pc_block = pc_block_raw
    if precommit.exists():
        if not args.inspect:
            appended = sdk.append_if_absent(
                precommit, "astral-sh/ruff-pre-commit", pc_block, warnings, "ruff pre-commit hooks"
            )
            if appended:
                files_written.append(".pre-commit-config.yaml")
                diffs.append(sdk.Diff(path=".pre-commit-config.yaml", kind="modify", preview="(ruff hooks appended)"))
            else:
                diffs.append(sdk.Diff(path=".pre-commit-config.yaml", kind="skip", preview="(ruff hooks already present)"))
        else:
            existing_pc = precommit.read_text(encoding="utf-8")
            if "astral-sh/ruff-pre-commit" not in existing_pc:
                diffs.append(sdk.Diff(path=".pre-commit-config.yaml", kind="modify", preview="(would append ruff hooks)"))
            else:
                diffs.append(sdk.Diff(path=".pre-commit-config.yaml", kind="skip", preview="(ruff hooks already present)"))
    else:
        diffs.append(sdk.Diff(
            path=".pre-commit-config.yaml",
            kind="skip",
            preview="(.pre-commit-config.yaml absent — run precommit-setup first)",
        ))

    # ── Cross-field re-validation (FR-003, best-effort) ────────────────────── #
    # Warn if the frozen python_version looks inconsistent with the chosen framework.
    # (Full constraint resolution is out of scope for 003; we warn, don't hard-error.)
    if framework and python_version:
        try:
            major, minor = (int(x) for x in python_version.split(".")[:2])
            if framework in ("django",) and (major, minor) < (3, 10):
                warnings.append(
                    f"WARN: Django typically requires Python >=3.10; "
                    f"frozen python_version={python_version!r} may be too old."
                )
        except (ValueError, TypeError):
            pass  # non-parseable version string — skip

    result = sdk.ModuleResult(
        module_id="lang-python",
        step_id=args.step,
        status="ok",
        files_written=files_written,
        diffs=diffs,
        warnings=warnings,
    )
    sdk.emit_result(result)
    return 0


STEP_HANDLERS = {
    "write": _do_write,
    # "resolve" is kind=agent — handled by the runner's Tier-2 agent subsystem.
    # "pins" is kind=gate — handled by the runner's gate subsystem.
}


def main() -> int:
    ap = argparse.ArgumentParser(description="lang-python module")
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
    inputs = sdk.load_frozen_inputs(args.plan, module_id="lang-python")
    return handler(sdk, inputs, args)


if __name__ == "__main__":
    raise SystemExit(main())
