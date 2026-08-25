# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""package-add — add a package directory to a monorepo.

Ports the path-traversal guards VERBATIM from legacy package-add.sh (lines ~50-69).
These guards are SECURITY-PINNED by the old bats suite and MUST NOT be relaxed.

Guards (in order, each fails fast before any mkdir):
  1. name contains '/' or '\\' → reject "must not contain a path separator"
  2. name is '..', '.', or '' → reject "must be a plain package name"
  3. name contains '..' as substring → reject "must not contain '..'"
  4. lang not in {ts, python, go, rust} → reject "must be one of"

After guards pass: create dir/name under project_dir. Lang-overlay invocation
is a follow-up (lang modules separate); this module only creates the dir and
emits workspace registration guidance.

Steps:
  resolve  (agent)  — Tier-2 agent aligns pins with sibling frozen answers
                      (when resolve_stack == true)
  pins     (gate)   — shows the aligned pin table; user confirms before write
                      (when resolve_stack == true)
  manifest (python) — reads aligned_pins from plan, writes the per-package
                      manifest (pyproject.toml / package.json / go.mod / Cargo.toml)
                      (when resolve_stack == true)
  add      (python) — creates the package directory (always)
  workspace-edit-gate (gate) — soft gate: offers root-workspace-manifest edit
  workspace-edit (python) — appends the new member to the root workspace manifest

Security invariant (FR-001/002, SC-002):
  _validate_name + sdk.is_safe_relative_path run at the TOP of main(),
  BEFORE dispatching to any step handler. Every step invocation therefore
  re-runs the guards before any path construction. Agent output (aligned_pins)
  NEVER feeds a path — only name/dir (validated before dispatch) do.

reconcile=false: re-run skips existing dir and manifest.
default_enabled=false: monorepo add-package tool, not base scaffold.

Invoked by the runner as:
    uv run module.py --plan <frozen_plan.json> --step <step_id> [--inspect]
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from pathlib import Path

_VALID_LANGS = frozenset({"ts", "python", "go", "rust"})

# Ecosystems for which verify_pins is supported (OQ-4: go/rust deferred)
_VERIFY_ECOSYSTEMS: dict[str, str] = {
    "python": "pypi",
    "ts": "npm",
}


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


def _validate_name(name: str) -> str | None:
    """Return an error message if *name* fails the path-traversal guards.

    Ports package-add.sh lines ~50-69 VERBATIM. Returns None if name is safe.
    """
    # Guard 1: path separators (monolith case */*|*\\*)
    if "/" in name or "\\" in name:
        return f"--name must not contain a path separator: {name}"
    # Guard 2: dot-only names (monolith case ..|.|"")
    if name in ("..", ".", ""):
        return f"--name must be a plain package name: {name}"
    # Guard 3: embedded '..' (monolith case *..*) — catches 'foo..bar'
    if ".." in name:
        return f"--name must not contain '..': {name}"
    return None


def _workspace_guidance(lang: str, dir_: str, name: str) -> str:
    """Return workspace registration guidance (mirrors package-add.sh lines 160-182)."""
    rel = f"{dir_}/{name}"
    if lang == "ts":
        return (
            f"Add to root package.json workspaces: "
            f'  "workspaces": ["{rel}"]'
        )
    elif lang == "rust":
        return (
            f"Add to root Cargo.toml: "
            f"  [workspace]\\n  members = [\"{rel}\"]"
        )
    elif lang == "python":
        return (
            f"Add to root pyproject.toml: "
            f"  [tool.uv.workspace]\\n  members = [\"{rel}\"]"
        )
    elif lang == "go":
        return f"Add to go.work: use ./{rel}"
    return f"Register {rel} in your workspace manifest."


# --------------------------------------------------------------------------- #
# Step handlers                                                                #
# --------------------------------------------------------------------------- #

def _do_add(sdk, inputs, args, *, name: str, lang: str, dir_: str, project_dir: Path) -> int:
    """add step: create the package directory (guards already ran at top of main)."""
    target = project_dir / dir_ / name
    target_rel = f"{dir_}/{name}"

    guidance = _workspace_guidance(lang, dir_, name)

    if args.inspect:
        result = sdk.ModuleResult(
            module_id="package-add",
            step_id=args.step,
            status="ok",
            message=f"would create {target_rel}/; {guidance}",
        )
        sdk.emit_result(result)
        return 0

    files_written: list[str] = []

    if target.exists():
        message = f"directory {target_rel}/ already exists; skipped"
    else:
        target.mkdir(parents=True, exist_ok=True)
        files_written.append(f"{target_rel}/")
        message = (
            f"Created {target_rel}/. "
            f"Lang-overlay invocation is a follow-up (lang modules separate). "
            f"{guidance}"
        )

    result = sdk.ModuleResult(
        module_id="package-add",
        step_id=args.step,
        status="ok",
        files_written=files_written,
        message=message,
    )
    sdk.emit_result(result)
    return 0


def _do_manifest(sdk, inputs, args, *, name: str, lang: str, dir_: str, project_dir: Path) -> int:
    """manifest step: write the per-package manifest using aligned_pins from the plan.

    Guards have already run at the top of main() — path construction is safe.
    (FR-007, SC-001, SC-002)
    """
    # Read aligned_pins answers from the frozen plan
    package_manifest_type: str = inputs.get_str("package_manifest_type", default="")
    pinned_deps: list[str] = inputs.get_list("pinned_deps", default=[])
    framework: str = inputs.get_str("framework", default="")
    go_version: str = inputs.get_str("go_version", default="")

    target_dir = project_dir / dir_ / name
    target_rel = f"{dir_}/{name}"
    warnings: list[str] = []

    # Determine manifest filename from lang if not overridden by agent answer
    lang_manifest_map = {
        "python": "pyproject.toml",
        "ts": "package.json",
        "go": "go.mod",
        "rust": "Cargo.toml",
    }
    if not package_manifest_type:
        package_manifest_type = lang_manifest_map.get(lang, "")

    if not package_manifest_type:
        error_dict = {
            "error_code": "INPUT_VALUE_INVALID",
            "module_id": "package-add",
            "module_ids": [],
            "expected": "package_manifest_type to be set (pyproject.toml/package.json/go.mod/Cargo.toml)",
            "received": repr(package_manifest_type),
            "how_to_fix": "Set package_manifest_type in the aligned_pins answers or ensure lang is one of ts/python/go/rust.",
        }
        result = sdk.ModuleResult(
            module_id="package-add",
            step_id=args.step,
            status="error",
            message=f"cannot determine manifest type for lang={lang!r}",
            error=error_dict,
        )
        sdk.emit_result(result)
        return 0

    # Pin verification (init mode only, FR-005 / OQ-4)
    if pinned_deps and inputs.mode == "init":
        ecosystem = _VERIFY_ECOSYSTEMS.get(lang)
        if ecosystem is None:
            # go/rust: skip verify + warn (OQ-4 deferred)
            warnings.append(
                f"WARN: pin verification not supported for lang={lang!r} (go/rust deferred, OQ-4) — "
                "skipping registry check. Manually verify pins before committing."
            )
        else:
            verify_result = sdk.verify_pins(pinned_deps, ecosystem)

            bad_pins = [p for p, s in verify_result.items() if s == sdk.PIN_DISCONFIRMED]
            if bad_pins:
                error = sdk.SetupError(
                    error_code=sdk.ErrorCode.INPUT_VALUE_INVALID,
                    module_id="package-add",
                    expected=f"all pins to exist on {ecosystem}",
                    received=f"disconfirmed pins: {bad_pins}",
                    how_to_fix=(
                        f"The agent proposed pins that do not exist on {ecosystem}: "
                        + ", ".join(bad_pins)
                        + ". Re-run with --refresh package-add to let the agent correct them."
                    ),
                )
                result = sdk.ModuleResult(
                    module_id="package-add",
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
                    + " — manifest write SKIPPED (safe-skip). "
                    "Restore network connectivity and re-run to write the manifest."
                )
                result = sdk.ModuleResult(
                    module_id="package-add",
                    step_id=args.step,
                    status="ok",
                    files_written=[],
                    diffs=[sdk.Diff(
                        path=f"{target_rel}/{package_manifest_type}",
                        kind="skip",
                        preview="(safe-skip: registry unreachable for some pins)",
                    )],
                    warnings=warnings,
                )
                sdk.emit_result(result)
                return 0

    # Render the per-package manifest body
    manifest_body = _render_manifest(
        lang, package_manifest_type, name, framework, pinned_deps, go_version=go_version
    )

    # Manifest path: {dir}/{name}/{package_manifest_type}
    manifest_rel = f"{target_rel}/{package_manifest_type}"

    if args.inspect:
        # Ensure parent dir exists conceptually in inspect mode
        diff = sdk.Diff(path=manifest_rel, kind="create", preview=manifest_body[:200])
        result = sdk.ModuleResult(
            module_id="package-add",
            step_id=args.step,
            status="ok",
            diffs=[diff],
            warnings=warnings,
            message=f"would write {manifest_rel}",
        )
        sdk.emit_result(result)
        return 0

    # Ensure the target directory exists (add step may not have run yet in this
    # invocation, and reconcile=false means we just mkdir if absent)
    target_dir.mkdir(parents=True, exist_ok=True)

    # Write-once: reconcile=False (existing → skip)
    diff = sdk.idempotent_write(
        manifest_rel,
        manifest_body,
        project_dir=project_dir,
        reconcile=False,
        inspect=args.inspect,
    )

    files_written: list[str] = []
    if diff.kind in ("create", "modify"):
        files_written.append(diff.path)

    result = sdk.ModuleResult(
        module_id="package-add",
        step_id=args.step,
        status="ok",
        files_written=files_written,
        diffs=[diff],
        warnings=warnings,
        message=f"{'Written' if diff.kind == 'create' else 'Skipped (exists)'}: {manifest_rel}",
    )
    sdk.emit_result(result)
    return 0


# Default Go language version for a generated go.mod when the caller supplies
# none. A bare major.minor line (no patch) is the go.mod convention. Bump this
# default as Go advances; it is overridable via the `go_version` answer so the
# value is never silently frozen.
_DEFAULT_GO_VERSION = "1.23"


def _render_manifest(
    lang: str,
    manifest_type: str,
    name: str,
    framework: str,
    pinned_deps: list[str],
    go_version: str = "",
) -> str:
    """Render a per-package manifest body deterministically.

    Uses sorted keys, no wall-clock. (FR-007, 003 determinism contract)
    """
    if lang == "python":
        # pyproject.toml: minimal [project] + [build-system] + dependencies list.
        # [build-system] is required for `pip install -e .` (PEP 517); without it
        # the package is non-installable. Matches what `uv init --package` produces.
        deps_lines = "\n".join(f'  "{pin}",' for pin in sorted(pinned_deps))
        deps_block = f"[\n{deps_lines}\n]" if pinned_deps else "[]"
        return (
            f'[project]\n'
            f'name = "{name}"\n'
            f'version = "0.1.0"\n'
            f'description = ""\n'
            f'dependencies = {deps_block}\n'
            f'\n'
            f'[build-system]\n'
            f'requires = ["uv_build>=0.9,<10"]\n'
            f'build-backend = "uv_build"\n'
        )
    elif lang == "ts":
        # package.json: minimal with dependencies dict (sorted keys)
        deps: dict[str, str] = {}
        for pin in sorted(pinned_deps):
            if "@" in pin:
                pkg, ver = pin.rsplit("@", 1) if pin.count("@") > 1 else pin.split("@", 1)
                # Handle scoped packages: @scope/name@version
                if pin.startswith("@"):
                    # e.g. @scope/name@1.0.0 → split on last @
                    at_idx = pin.rfind("@")
                    pkg = pin[:at_idx]
                    ver = pin[at_idx + 1:]
                deps[pkg] = ver
            else:
                deps[pin] = "*"
        obj = {
            "name": name,
            "version": "0.1.0",
            "private": True,
            "dependencies": deps,
        }
        return json.dumps(obj, indent=2, sort_keys=False) + "\n"
    elif lang == "go":
        # go.mod stub. The go directive uses the supplied go_version (a bare
        # major.minor line per go.mod convention), defaulting to a current line
        # rather than a frozen literal.
        gv = (go_version or "").strip() or _DEFAULT_GO_VERSION
        # Tolerate a leading 'go ' or 'v' prefix in the answer.
        gv = gv.removeprefix("go").strip().lstrip("v") or _DEFAULT_GO_VERSION
        return f'module {name}\n\ngo {gv}\n'
    elif lang == "rust":
        # Cargo.toml stub with dependencies
        deps_lines = "\n".join(
            f'{pin.split("@")[0]} = "{pin.split("@")[1]}"'
            for pin in sorted(pinned_deps)
            if "@" in pin
        )
        deps_block = f"\n[dependencies]\n{deps_lines}\n" if deps_lines else ""
        return (
            f'[package]\n'
            f'name = "{name}"\n'
            f'version = "0.1.0"\n'
            f'edition = "2021"\n'
            f'{deps_block}'
        )
    # Fallback: empty file
    return ""


def _do_workspace_edit(sdk, inputs, args, *, name: str, lang: str, dir_: str, project_dir: Path) -> int:
    """workspace-edit step: append the new package member to the root workspace manifest.

    Uses sdk.append_if_absent with a per-package marker so re-runs don't
    double-append (FR-010, SC-006). Guards have already run at the top of main().
    """
    marker = f"# project-setup: {name}"
    warnings: list[str] = []
    rel = f"{dir_}/{name}"

    # Determine the root workspace manifest path and append block per lang
    if lang == "python":
        manifest_path = project_dir / "pyproject.toml"
        block = (
            f"\n{marker}\n"
            f"[tool.uv.workspace]\n"
            f'members = ["{rel}"]\n'
        )
        label = "uv workspace member"
    elif lang == "ts":
        # TS workspace-edit: proper JSON edit — parse, add to workspaces[], re-serialize.
        # Text-appending a comment + bare string to package.json corrupts the JSON.
        manifest_path = project_dir / "package.json"
        label = "package.json workspace entry"

        if args.inspect:
            existing = manifest_path.read_text(encoding="utf-8") if manifest_path.exists() else "{}"
            already = False
            try:
                data_i = json.loads(existing)
                already = rel in (data_i.get("workspaces") or [])
            except Exception:  # noqa: BLE001
                pass
            diff_i = sdk.Diff(
                path="package.json",
                kind="skip" if already else "modify",
                preview=f'({"already present" if already else f"would add {rel!r} to workspaces[]"})',
            )
            sdk.emit_result(sdk.ModuleResult(
                module_id="package-add",
                step_id=args.step,
                status="ok",
                diffs=[diff_i],
                warnings=warnings,
                message=f"would add {rel!r} to package.json workspaces[]",
            ))
            return 0

        # Real edit: parse → add → re-serialize
        files_written_ts: list[str] = []
        if manifest_path.exists():
            try:
                data_ts = json.loads(manifest_path.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                data_ts = {}
        else:
            data_ts = {}
        ws: list = list(data_ts.get("workspaces") or [])
        if rel not in ws:
            ws.append(rel)
            data_ts["workspaces"] = sorted(ws)
            manifest_path.write_text(
                json.dumps(data_ts, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            files_written_ts.append("package.json")
            msg_ts = f"Added {rel!r} to package.json workspaces[]"
        else:
            msg_ts = f"package.json workspaces[]: {rel!r} already present (idempotent skip)"
        sdk.emit_result(sdk.ModuleResult(
            module_id="package-add",
            step_id=args.step,
            status="ok",
            files_written=files_written_ts,
            warnings=warnings,
            message=msg_ts,
        ))
        return 0
    elif lang == "go":
        manifest_path = project_dir / "go.work"
        block = f"\n{marker}\nuse ./{rel}\n"
        label = "go.work use entry"
    elif lang == "rust":
        manifest_path = project_dir / "Cargo.toml"
        block = (
            f"\n{marker}\n"
            f"[workspace]\n"
            f'members = ["{rel}"]\n'
        )
        label = "Cargo workspace member"
    else:
        result = sdk.ModuleResult(
            module_id="package-add",
            step_id=args.step,
            status="ok",
            message=f"workspace-edit: unknown lang={lang!r}; no workspace manifest updated",
            warnings=[f"WARN: no workspace-edit handler for lang={lang!r}"],
        )
        sdk.emit_result(result)
        return 0

    if args.inspect:
        # Preview what would be appended
        existing = manifest_path.read_text(encoding="utf-8") if manifest_path.exists() else ""
        if marker in existing:
            diff = sdk.Diff(path=str(manifest_path.relative_to(project_dir)), kind="skip", preview="(already present)")
        else:
            diff = sdk.Diff(path=str(manifest_path.relative_to(project_dir)), kind="modify", preview=block)
        result = sdk.ModuleResult(
            module_id="package-add",
            step_id=args.step,
            status="ok",
            diffs=[diff],
            warnings=warnings,
            message=f"would append {label} to {manifest_path.name}",
        )
        sdk.emit_result(result)
        return 0

    appended = sdk.append_if_absent(manifest_path, marker, block, warnings, label)

    files_written: list[str] = []
    if appended:
        try:
            rel_manifest = str(manifest_path.relative_to(project_dir))
        except ValueError:
            rel_manifest = manifest_path.name
        files_written.append(rel_manifest)
        message = f"Appended {label} to {manifest_path.name}"
    else:
        message = f"{manifest_path.name}: {label} already present (idempotent skip)"

    result = sdk.ModuleResult(
        module_id="package-add",
        step_id=args.step,
        status="ok",
        files_written=files_written,
        warnings=warnings,
        message=message,
    )
    sdk.emit_result(result)
    return 0


# --------------------------------------------------------------------------- #
# main() — guards run first (security-pinned), then dispatch on args.step     #
# --------------------------------------------------------------------------- #

def main() -> int:
    ap = argparse.ArgumentParser(description="package-add module")
    ap.add_argument("--plan", required=True, help="path to the frozen plan.json")
    ap.add_argument("--step", required=True, help="step id to run")
    ap.add_argument("--inspect", action="store_true", help="dry pass: preview, no write")
    args = ap.parse_args()

    sdk = _load_sdk()
    inputs = sdk.load_frozen_inputs(args.plan, module_id="package-add")

    name = inputs.get_str("name", default="")
    lang = inputs.get_choice("lang", default="ts")
    dir_ = inputs.get_str("dir", default="packages")

    # --- Path-traversal guards (security-pinned, MUST run before any mkdir) ---
    # These run UNCONDITIONALLY before any step dispatch, so every step invocation
    # re-validates name and dir_ before any path construction. (FR-001/002, SC-002)
    name_err = _validate_name(name)
    if name_err:
        err_dict = {
            "error_code": "PATH_ESCAPE",
            "module_id": "package-add",
            "module_ids": [],
            "expected": "plain package name without path separators or '..'",
            "received": repr(name),
            "how_to_fix": name_err,
        }
        result = sdk.ModuleResult(
            module_id="package-add",
            step_id=args.step,
            status="error",
            message=name_err,
            error=err_dict,
        )
        sdk.emit_result(result)
        return 0

    # Validate lang
    if lang not in _VALID_LANGS:
        err_dict = {
            "error_code": "INPUT_VALUE_INVALID",
            "module_id": "package-add",
            "module_ids": [],
            "expected": f"lang in {sorted(_VALID_LANGS)}",
            "received": repr(lang),
            "how_to_fix": f"Set lang to one of: ts, python, go, rust (got: {lang!r})",
        }
        result = sdk.ModuleResult(
            module_id="package-add",
            step_id=args.step,
            status="error",
            message=f"invalid lang: {lang!r}",
            error=err_dict,
        )
        sdk.emit_result(result)
        return 0

    project_dir_env = os.environ.get("PROJECT_DIR")
    project_dir = Path(project_dir_env).resolve() if project_dir_env else Path.cwd().resolve()

    # Validate dir_ itself is a safe relative path (no traversal in the dir arg either)
    if not sdk.is_safe_relative_path(dir_):
        err_dict = {
            "error_code": "PATH_ESCAPE",
            "module_id": "package-add",
            "module_ids": [],
            "expected": "safe relative dir path",
            "received": repr(dir_),
            "how_to_fix": f"dir must be a safe relative path within the project: {dir_!r}",
        }
        result = sdk.ModuleResult(
            module_id="package-add",
            step_id=args.step,
            status="error",
            message=f"unsafe dir path: {dir_!r}",
            error=err_dict,
        )
        sdk.emit_result(result)
        return 0

    # Guards have passed. Now construct shared path context and dispatch.
    # NOTE: target path is constructed ONLY here, after all guards have run.

    step_kwargs = dict(
        name=name,
        lang=lang,
        dir_=dir_,
        project_dir=project_dir,
    )

    if args.step == "add":
        return _do_add(sdk, inputs, args, **step_kwargs)
    elif args.step == "manifest":
        return _do_manifest(sdk, inputs, args, **step_kwargs)
    elif args.step == "workspace-edit":
        return _do_workspace_edit(sdk, inputs, args, **step_kwargs)
    elif args.step in ("resolve", "pins", "workspace-edit-gate"):
        # These are agent/gate steps — dispatched by the runner, not by module.py.
        # If the runner accidentally calls module.py for these, emit a clean error.
        print(
            f"Step {args.step!r} is a {'agent' if args.step == 'resolve' else 'gate'} step "
            f"dispatched by the runner, not by module.py. "
            f"Python-handled steps: add, manifest, workspace-edit.",
            file=sys.stderr,
        )
        return 1
    else:
        print(
            f"Unknown step: {args.step!r}. "
            f"Python-handled steps: add, manifest, workspace-edit. "
            f"Agent/gate steps (runner-dispatched): resolve, pins, workspace-edit-gate.",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
