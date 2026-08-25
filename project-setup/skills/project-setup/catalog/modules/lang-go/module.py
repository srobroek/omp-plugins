# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""lang-go — Go language overlay.

Ports setup-go.sh (145 lines) to a native-root Python module.

Steps:
  write    (python) — Derive module path from git remote if not provided,
                      create cmd/ internal/ pkg/ directories + cmd/<binary>/main.go,
                      write .golangci.yml, append Go .gitignore block,
                      append pre-commit-golang hooks.
  scaffold (python) — Run `go mod init <module_path>` (G4-gated).

Ordering note: cmd/<binary>/main.go is a plain file write (package main /
fmt.Println) that does NOT require go.mod to exist. The deterministic write step
can safely precede the go mod init generator. The binary lives one level under
cmd/ so `go build ./...` does not collide with the cmd/ directory.

External tool absence/failure is NON-FATAL: a warning is emitted and the
module continues.  This mirrors the legacy WARN pattern in setup-go.sh.

Invoked by the runner as:
    uv run module.py --plan <frozen_plan.json> --step <write|scaffold> [--inspect]
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import re
import shutil
import subprocess
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


def _derive_module_path(
    project_dir: Path, warnings: list[str], *, project_name: str = ""
) -> str:
    """Derive a Go module path from git remote, mirroring legacy setup-go.sh lines 30-38.

    The optional *project_name* keyword argument is used for the fallback path
    (``example.com/<project_name>``) so the fallback uses the answer-driven name
    rather than the raw directory name.
    """
    git = shutil.which("git")
    if git:
        try:
            result = subprocess.run(
                [git, "remote", "get-url", "origin"],
                cwd=str(project_dir),
                capture_output=True,
                text=True,
                timeout=10,
            )
            remote = result.stdout.strip()
            if remote:
                # Normalize https://, ssh://git@, git@host:path  →  host/path
                module = remote
                module = re.sub(r"^https://", "", module)
                module = re.sub(r"^ssh://git@", "", module)
                module = re.sub(r"^git@([^:]+):", r"\1/", module)
                module = re.sub(r"\.git$", "", module)
                return module
        except Exception:  # noqa: BLE001
            pass
    name_part = project_name.strip() if project_name.strip() else project_dir.name
    fallback = f"example.com/{name_part}"
    warnings.append(f"WARN: No git remote found — using module path '{fallback}'")
    return fallback


def _binary_name(project_name: str, module_path: str) -> str:
    """Derive the command binary name for the ``cmd/<binary>/`` layout.

    The entrypoint MUST live at ``cmd/<binary>/main.go`` rather than
    ``cmd/main.go``: with the latter, ``go build ./...`` infers the binary name
    from the package's parent directory (``cmd``) and tries to write an output
    file named ``cmd`` into the working directory, which collides with the
    ``cmd/`` directory itself ("build output \"cmd\" already exists and is a
    directory"). Nesting one level down names the binary ``<binary>`` and removes
    the collision.

    Preference order for the name: project_name, then the last path segment of
    the module path, then ``app``. The result is sanitized to a safe Go-ish
    identifier (lowercased, non-alphanumerics collapsed to ``-``) so spaces or
    punctuation in the project name cannot break the path or the build.
    """
    candidate = project_name.strip()
    if not candidate and module_path:
        candidate = module_path.rstrip("/").split("/")[-1]
    candidate = candidate.lower()
    candidate = re.sub(r"[^a-z0-9]+", "-", candidate).strip("-")
    return candidate or "app"


# --------------------------------------------------------------------------- #
# Step handlers                                                                #
# --------------------------------------------------------------------------- #

def _do_write(sdk, inputs, args) -> int:
    """write step: deterministic layout writes (no external generator).

    Derives the Go module path (needed for cmd/main.go content), creates the
    standard Go layout (cmd/, internal/, pkg/, cmd/main.go), writes
    .golangci.yml, appends the Go .gitignore block, and appends pre-commit-golang
    hooks. Does NOT run go mod init — that is the scaffold step (G4-gated,
    spec 004 FR-013).

    Ordering safety: cmd/main.go is `package main` + fmt.Println — it does NOT
    import anything that requires go.mod to exist. The write step precedes the
    scaffold generator safely.
    """
    module_path: str = inputs.get_str("module_path", default="")
    # app_kind accepted but no structural branches in legacy — free-form placeholder

    project_dir_env = os.environ.get("PROJECT_DIR")
    project_dir = Path(project_dir_env).resolve() if project_dir_env else Path.cwd().resolve()

    warnings: list[str] = []
    diffs = []
    files_written: list[str] = []

    # Package identity: prefer the explicit project_name answer; fall back to the
    # directory name only when absent (preserves existing behaviour for answer-less
    # runs). The fallback module path also uses project_name so both sides agree.
    raw_name = inputs.get_str("project_name", default="") or project_dir.name
    project_name = raw_name.strip()

    # ── 1. Derive module path (needed for cmd/main.go project_name) ─────────── #
    if not module_path:
        module_path = _derive_module_path(project_dir, warnings, project_name=project_name)

    # ── 2. Standard Go layout ──────────────────────────────────────────────── #
    # Entrypoint lives at cmd/<binary>/main.go (NOT cmd/main.go): the nested form
    # gives `go build ./...` a binary name of <binary>, avoiding the "build output
    # 'cmd' already exists and is a directory" collision the flat cmd/main.go
    # layout triggers.
    binary = _binary_name(project_name, module_path)
    main_go_rel = f"cmd/{binary}/main.go"
    main_go_body = f'package main\n\nimport "fmt"\n\nfunc main() {{\n\tfmt.Println("{project_name}")\n}}\n'
    if not args.inspect:
        for d in ("cmd", "internal", "pkg"):
            (project_dir / d).mkdir(exist_ok=True)
    diff = sdk.idempotent_write(
        main_go_rel,
        main_go_body,
        project_dir=project_dir,
        reconcile=False,
        inspect=args.inspect,
    )
    diffs.append(diff)
    if diff.kind in ("create", "modify"):
        files_written.append(diff.path)

    # ── 3. .golangci.yml ───────────────────────────────────────────────────── #
    golangci_body = (_TEMPLATES / "golangci.yml").read_text(encoding="utf-8")
    diff = sdk.idempotent_write(
        ".golangci.yml",
        golangci_body,
        project_dir=project_dir,
        reconcile=False,
        inspect=args.inspect,
    )
    diffs.append(diff)
    if diff.kind in ("create", "modify"):
        files_written.append(diff.path)

    # ── 4. Append Go .gitignore block ──────────────────────────────────────── #
    gitignore = project_dir / ".gitignore"
    gi_block = (_TEMPLATES / "gitignore-block.txt").read_text(encoding="utf-8")
    if not args.inspect:
        appended = sdk.append_if_absent(
            gitignore, "*.test", gi_block, warnings, "Go .gitignore"
        )
        if appended:
            files_written.append(".gitignore")
            diffs.append(sdk.Diff(path=".gitignore", kind="modify", preview="(Go gitignore block appended)"))
        else:
            diffs.append(sdk.Diff(path=".gitignore", kind="skip", preview="(*.test already present)"))
    else:
        existing_gi = gitignore.read_text(encoding="utf-8") if gitignore.exists() else ""
        if "*.test" not in existing_gi:
            diffs.append(sdk.Diff(path=".gitignore", kind="modify", preview="(would append Go gitignore block)"))
        else:
            diffs.append(sdk.Diff(path=".gitignore", kind="skip", preview="(*.test already present)"))

    # ── 5. Append Go pre-commit hooks ──────────────────────────────────────── #
    precommit = project_dir / ".pre-commit-config.yaml"
    pc_block = (_TEMPLATES / "precommit-block.yaml").read_text(encoding="utf-8")
    if precommit.exists():
        if not args.inspect:
            appended = sdk.append_if_absent(
                precommit, "tekwizely/pre-commit-golang", pc_block, warnings, "Go pre-commit hooks"
            )
            if appended:
                files_written.append(".pre-commit-config.yaml")
                diffs.append(sdk.Diff(path=".pre-commit-config.yaml", kind="modify", preview="(Go hooks appended)"))
            else:
                diffs.append(sdk.Diff(path=".pre-commit-config.yaml", kind="skip", preview="(Go hooks already present)"))
        else:
            existing_pc = precommit.read_text(encoding="utf-8")
            if "tekwizely/pre-commit-golang" not in existing_pc:
                diffs.append(sdk.Diff(path=".pre-commit-config.yaml", kind="modify", preview="(would append Go hooks)"))
            else:
                diffs.append(sdk.Diff(path=".pre-commit-config.yaml", kind="skip", preview="(Go hooks already present)"))
    else:
        diffs.append(sdk.Diff(
            path=".pre-commit-config.yaml",
            kind="skip",
            preview="(.pre-commit-config.yaml absent — run precommit-setup first)",
        ))

    result = sdk.ModuleResult(
        module_id="lang-go",
        step_id=args.step,
        status="ok",
        files_written=files_written,
        diffs=diffs,
        warnings=warnings,
    )
    sdk.emit_result(result)
    return 0


def _do_scaffold(sdk, inputs, args) -> int:
    """scaffold step: run `go mod init <module_path>` (G4-gated).

    Separated from `write` (spec 004 FR-013) so the soft G4 gate can skip JUST
    the external-generator run while the deterministic `write` step's layout
    files (cmd/main.go, .golangci.yml, .gitignore, pre-commit hooks) already
    landed. go mod init does not depend on any file from the write step.
    """
    module_path: str = inputs.get_str("module_path", default="")

    project_dir_env = os.environ.get("PROJECT_DIR")
    project_dir = Path(project_dir_env).resolve() if project_dir_env else Path.cwd().resolve()

    warnings: list[str] = []
    diffs = []
    files_written: list[str] = []

    # ── 1. Derive module path (must match what write step derived) ─────────── #
    if not module_path:
        raw_name = inputs.get_str("project_name", default="") or project_dir.name
        module_path = _derive_module_path(project_dir, warnings, project_name=raw_name.strip())

    # ── 2. go mod init ─────────────────────────────────────────────────────── #
    go_mod = project_dir / "go.mod"
    if not go_mod.exists():
        if not args.inspect:
            sdk.run_tool(
                ["go", "mod", "init", module_path],
                cwd=project_dir,
                warnings=warnings,
                label="go mod init",
            )
        else:
            warnings.append(f"inspect: would run go mod init {module_path}")
    else:
        diffs.append(sdk.Diff(path="go.mod", kind="skip", preview="(go.mod already exists)"))

    result = sdk.ModuleResult(
        module_id="lang-go",
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
    ap = argparse.ArgumentParser(description="lang-go module")
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
    inputs = sdk.load_frozen_inputs(args.plan, module_id="lang-go")
    return handler(sdk, inputs, args)


if __name__ == "__main__":
    raise SystemExit(main())
