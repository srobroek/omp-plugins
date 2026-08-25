# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""justfile-write — write a skeleton justfile.

Preserves the verbatim justfile heredoc from project-setup.sh Step 8
(lines 616–643). If use_just=false the step is a skip (emits files_written=[]).

reconcile=false: justfile is never overwritten on re-run (the legacy script
behaviour: `if $USE_JUST && [ ! -f justfile ]`).

Invoked by the runner as:
    uv run module.py --plan <frozen_plan.json> --step write [--inspect]
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import sys
from pathlib import Path

# Verbatim justfile body from project-setup.sh Step 8 (lines 619–641).
# Used when language is empty/unknown — fail-loud stubs so CI is never
# silently green for unconfigured commands.
_JUSTFILE = """\
default:
    @just --list

# Run tests
test:
    @echo "ERROR: no test command configured — edit this justfile to add one (e.g. uv run pytest, bun test)" && exit 1

# Lint and format
lint:
    pre-commit run --all-files

# Build
build:
    @echo "ERROR: no build command configured — edit this justfile to add one" && exit 1

# Start dev server
dev:
    @echo "ERROR: no dev command configured — edit this justfile to add one" && exit 1

# Clean build artifacts
clean:
    @echo "TODO: configure clean command"
"""

# Language-specific recipe bodies.  Values that are NOT known → fail-loud stub.
# Rules:
#   - test/build: real idiomatic command when known, else fail-loud stub.
#   - dev: fail-loud stub unless the command is unambiguous (no entrypoint needed).
#   - lint: pre-commit run --all-files is universal; kept for all languages.
#   - clean: always a hint-stub (no-op cost; build artefact dirs vary per project).
#   - NEVER emit an exit-0 "TODO" echo for test or build.
_LANG_RECIPES: dict[str, dict[str, str]] = {
    "python": {
        "test": "uv run pytest",
        "build": "uv build",
        "dev": (
            "@echo \"INFO: configure a dev command for your project "
            "(e.g. uv run uvicorn app.main:app --reload)\" && exit 1"
        ),
    },
    "go": {
        "test": "go test ./...",
        "build": "go build ./...",
        "dev": "@echo \"INFO: configure a dev command (e.g. go run ./cmd/...)\" && exit 1",
    },
    "rust": {
        "test": "cargo test",
        "build": "cargo build --release",
        "dev": "@echo \"INFO: configure a dev command (e.g. cargo run)\" && exit 1",
    },
    "ts": {
        "test": "npm test",
        "build": "@echo \"ERROR: no build command configured — edit this justfile to add one\" && exit 1",
        "dev": "@echo \"INFO: configure a dev command (e.g. npm run dev)\" && exit 1",
    },
}


def _render_justfile(language: str) -> str:
    """Return a justfile body with recipes appropriate for *language*.

    When *language* is empty or not in the known set the canonical fail-loud
    stub body is returned unchanged.  When it IS known, the test/build/dev
    recipe bodies are swapped to idiomatic commands for that language; lint and
    clean are unchanged.
    """
    lang = language.strip().lower()
    recipes = _LANG_RECIPES.get(lang)
    if recipes is None:
        return _JUSTFILE

    return (
        "default:\n"
        "    @just --list\n"
        "\n"
        "# Run tests\n"
        "test:\n"
        f"    {recipes['test']}\n"
        "\n"
        "# Lint and format\n"
        "lint:\n"
        "    pre-commit run --all-files\n"
        "\n"
        "# Build\n"
        "build:\n"
        f"    {recipes['build']}\n"
        "\n"
        "# Start dev server\n"
        "dev:\n"
        f"    {recipes['dev']}\n"
        "\n"
        "# Clean build artifacts\n"
        "clean:\n"
        "    @echo \"TODO: configure clean command\"\n"
    )


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
def main() -> int:
    ap = argparse.ArgumentParser(description="justfile-write module")
    ap.add_argument("--plan", required=True, help="path to the frozen plan.json")
    ap.add_argument("--step", required=True, help="step id to run")
    ap.add_argument("--inspect", action="store_true", help="dry pass: preview, no write")
    args = ap.parse_args()

    sdk = _load_sdk()
    inputs = sdk.load_frozen_inputs(args.plan, module_id="justfile-write")

    use_just = inputs.get_bool("use_just", default=True)

    if not use_just:
        # Explicit skip: user opted out of justfile creation.
        result = sdk.ModuleResult(
            module_id="justfile-write",
            step_id=args.step,
            status="ok",
            files_written=[],
            diffs=[],
            message="use_just=false: justfile creation skipped",
        )
        sdk.emit_result(result)
        return 0

    language = inputs.get_str("language", default="")
    body = _render_justfile(language)

    diff = sdk.idempotent_write(
        "justfile",
        body,
        reconcile=False,  # write-if-absent; never overwrite on re-run
        inspect=args.inspect,
    )

    files_written = [diff.path] if diff.kind in ("create", "modify") else []
    result = sdk.ModuleResult(
        module_id="justfile-write",
        step_id=args.step,
        status="ok",
        files_written=files_written,
        diffs=[diff],
    )
    sdk.emit_result(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
