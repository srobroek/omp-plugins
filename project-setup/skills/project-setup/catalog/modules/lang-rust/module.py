# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""lang-rust — Rust language overlay.

Ports setup-rust.sh (138 lines) to a native-root Python module.

Steps:
  write    (python) — Write rust-toolchain.toml, clippy.toml, rustfmt.toml,
                      Cargo.toml (workspace=true only, deterministic),
                      append Rust .gitignore block, append pre-commit-rust hooks.
  scaffold (python) — Run `cargo init .` (workspace=false only; G4-gated).
                      When workspace=true, this is a no-op (no generator needed).

Note: the legacy --esp branch (esp-idf toolchain) is preserved as a
crate_kind=="esp" branch that writes a rust-toolchain.toml with channel="esp".

External tool absence/failure is NON-FATAL: a warning is emitted and the
module continues.  This mirrors the legacy WARN pattern in setup-rust.sh.

Invoked by the runner as:
    uv run module.py --plan <frozen_plan.json> --step <write|scaffold> [--inspect]
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import sys
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
# Step handlers                                                                #
# --------------------------------------------------------------------------- #

def _do_write(sdk, inputs, args) -> int:
    """write step: deterministic config writes (no external generator).

    Writes rust-toolchain.toml, clippy.toml, rustfmt.toml, and (workspace=true)
    a deterministic Cargo.toml workspace template. Also appends the Rust
    .gitignore block and pre-commit-rust hooks. Does NOT run cargo init —
    that is the scaffold step (G4-gated, spec 004 FR-013).
    """
    workspace: bool = inputs.get_bool("workspace", default=False)
    crate_kind: str = inputs.get_str("crate_kind", default="")

    project_dir_env = os.environ.get("PROJECT_DIR")
    project_dir = Path(project_dir_env).resolve() if project_dir_env else Path.cwd().resolve()

    warnings: list[str] = []
    diffs = []
    files_written: list[str] = []

    # ── 1. Cargo.toml — workspace mode only (deterministic write) ─────────── #
    # workspace=false: Cargo.toml is created by `cargo init` in the scaffold step.
    # workspace=true:  write a deterministic workspace template here; no generator.
    cargo_toml = project_dir / "Cargo.toml"
    if not cargo_toml.exists():
        if workspace:
            workspace_body = (_TEMPLATES / "cargo-workspace.toml").read_text(encoding="utf-8")
            diff = sdk.idempotent_write(
                "Cargo.toml",
                workspace_body,
                project_dir=project_dir,
                reconcile=False,
                inspect=args.inspect,
            )
            diffs.append(diff)
            if diff.kind in ("create", "modify"):
                files_written.append(diff.path)
        # workspace=false: skip here — scaffold will run cargo init
    else:
        diffs.append(sdk.Diff(path="Cargo.toml", kind="skip", preview="(Cargo.toml already exists)"))

    # ── 2. rust-toolchain.toml ─────────────────────────────────────────────── #
    if crate_kind.lower() == "esp":
        toolchain_body = "[toolchain]\nchannel = \"esp\"\n"
    else:
        toolchain_body = (_TEMPLATES / "rust-toolchain-stable.toml").read_text(encoding="utf-8")
    diff = sdk.idempotent_write(
        "rust-toolchain.toml",
        toolchain_body,
        project_dir=project_dir,
        reconcile=False,
        inspect=args.inspect,
    )
    diffs.append(diff)
    if diff.kind in ("create", "modify"):
        files_written.append(diff.path)

    # ── 3. clippy.toml ─────────────────────────────────────────────────────── #
    clippy_body = (_TEMPLATES / "clippy.toml").read_text(encoding="utf-8")
    diff = sdk.idempotent_write(
        "clippy.toml",
        clippy_body,
        project_dir=project_dir,
        reconcile=False,
        inspect=args.inspect,
    )
    diffs.append(diff)
    if diff.kind in ("create", "modify"):
        files_written.append(diff.path)

    # ── 4. rustfmt.toml ────────────────────────────────────────────────────── #
    rustfmt_body = (_TEMPLATES / "rustfmt.toml").read_text(encoding="utf-8")
    diff = sdk.idempotent_write(
        "rustfmt.toml",
        rustfmt_body,
        project_dir=project_dir,
        reconcile=False,
        inspect=args.inspect,
    )
    diffs.append(diff)
    if diff.kind in ("create", "modify"):
        files_written.append(diff.path)

    # ── 5. Append Rust .gitignore block ────────────────────────────────────── #
    gitignore = project_dir / ".gitignore"
    gi_block = (_TEMPLATES / "gitignore-block.txt").read_text(encoding="utf-8")
    if not args.inspect:
        appended = sdk.append_if_absent(
            gitignore, "/target", gi_block, warnings, "Rust .gitignore"
        )
        if appended:
            files_written.append(".gitignore")
            diffs.append(sdk.Diff(path=".gitignore", kind="modify", preview="(Rust gitignore block appended)"))
        else:
            diffs.append(sdk.Diff(path=".gitignore", kind="skip", preview="(/target already present)"))
    else:
        existing_gi = gitignore.read_text(encoding="utf-8") if gitignore.exists() else ""
        if "/target" not in existing_gi:
            diffs.append(sdk.Diff(path=".gitignore", kind="modify", preview="(would append Rust gitignore block)"))
        else:
            diffs.append(sdk.Diff(path=".gitignore", kind="skip", preview="(/target already present)"))

    # ── 6. Append Rust pre-commit hooks ────────────────────────────────────── #
    precommit = project_dir / ".pre-commit-config.yaml"
    pc_block = (_TEMPLATES / "precommit-block.yaml").read_text(encoding="utf-8")
    if precommit.exists():
        if not args.inspect:
            appended = sdk.append_if_absent(
                precommit, "doublify/pre-commit-rust", pc_block, warnings, "Rust pre-commit hooks"
            )
            if appended:
                files_written.append(".pre-commit-config.yaml")
                diffs.append(sdk.Diff(path=".pre-commit-config.yaml", kind="modify", preview="(Rust hooks appended)"))
            else:
                diffs.append(sdk.Diff(path=".pre-commit-config.yaml", kind="skip", preview="(Rust hooks already present)"))
        else:
            existing_pc = precommit.read_text(encoding="utf-8")
            if "doublify/pre-commit-rust" not in existing_pc:
                diffs.append(sdk.Diff(path=".pre-commit-config.yaml", kind="modify", preview="(would append Rust hooks)"))
            else:
                diffs.append(sdk.Diff(path=".pre-commit-config.yaml", kind="skip", preview="(Rust hooks already present)"))
    else:
        diffs.append(sdk.Diff(
            path=".pre-commit-config.yaml",
            kind="skip",
            preview="(.pre-commit-config.yaml absent — run precommit-setup first)",
        ))

    result = sdk.ModuleResult(
        module_id="lang-rust",
        step_id=args.step,
        status="ok",
        files_written=files_written,
        diffs=diffs,
        warnings=warnings,
    )
    sdk.emit_result(result)
    return 0


def _do_scaffold(sdk, inputs, args) -> int:
    """scaffold step: run `cargo init .` (G4-gated, workspace=false only).

    Separated from `write` (spec 004 FR-013) so the soft G4 gate can skip JUST
    the external-generator run while the deterministic `write` step's config
    files already landed. When workspace=true, this is a clean no-op — the
    workspace Cargo.toml was written deterministically in the write step.
    """
    workspace: bool = inputs.get_bool("workspace", default=False)

    project_dir_env = os.environ.get("PROJECT_DIR")
    project_dir = Path(project_dir_env).resolve() if project_dir_env else Path.cwd().resolve()

    warnings: list[str] = []
    diffs = []
    files_written: list[str] = []

    # Crate identity: prefer the explicit project_name answer; fall back to the
    # directory name when absent (preserves existing behaviour for answer-less runs).
    raw_name = inputs.get_str("project_name", default="") or project_dir.name
    crate_name = raw_name.strip()

    if workspace:
        # workspace=true: no generator needed, Cargo.toml was written in the write step
        result = sdk.ModuleResult(
            module_id="lang-rust",
            step_id=args.step,
            status="ok",
            files_written=files_written,
            diffs=diffs,
            warnings=warnings,
        )
        sdk.emit_result(result)
        return 0

    # workspace=false: run cargo init (may create Cargo.toml + src/main.rs)
    # --name overrides the default (which is the directory name) so the crate name
    # matches the answer-driven project_name rather than whatever the dir happens to be.
    cargo_toml = project_dir / "Cargo.toml"
    if not cargo_toml.exists():
        if not args.inspect:
            sdk.run_tool(
                ["cargo", "init", ".", "--name", crate_name],
                cwd=project_dir,
                warnings=warnings,
                label="cargo init",
            )
        else:
            warnings.append(f"inspect: would run cargo init . --name {crate_name}")
    else:
        diffs.append(sdk.Diff(path="Cargo.toml", kind="skip", preview="(Cargo.toml already exists)"))

    result = sdk.ModuleResult(
        module_id="lang-rust",
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
    "scaffold": _do_scaffold,
    # "run-generator" is kind=gate — handled by the runner's gate subsystem.
}


def main() -> int:
    ap = argparse.ArgumentParser(description="lang-rust module")
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
    inputs = sdk.load_frozen_inputs(args.plan, module_id="lang-rust")
    return handler(sdk, inputs, args)


if __name__ == "__main__":
    raise SystemExit(main())
