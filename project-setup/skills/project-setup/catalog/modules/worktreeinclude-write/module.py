# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""worktreeinclude-write — write .worktreeinclude from .gitignore analysis.

Reads the project's .gitignore and classifies each pattern:
- Small config/secret files that SHOULD be copied into worktrees
  (e.g. .env, .envrc, config/secrets.json)
- Large directories or build artefacts that should NOT be copied
  (e.g. node_modules/, .venv/, target/, .next/)

Writes a .worktreeinclude listing only the copyable patterns, with
a brief comment explaining why each was included.

Runs after gitignore-generate so .gitignore is guaranteed to exist.

Invoked by the runner as:
    uv run module.py --plan <frozen_plan.json> --step write [--inspect]
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import re
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# Pattern classification
# ---------------------------------------------------------------------------

# Patterns in .gitignore that represent LARGE directories or binary/build
# artefacts — these should NOT be copied into worktrees.
_LARGE_DIR_PATTERNS: frozenset[str] = frozenset(
    {
        # dependency trees
        "node_modules",
        "node_modules/",
        ".npm",
        ".yarn",
        ".pnp",
        ".pnpm-store",
        # Python virtualenvs / caches
        ".venv",
        ".venv/",
        "venv",
        "venv/",
        "__pycache__",
        "__pycache__/",
        ".pytest_cache",
        ".ruff_cache",
        ".mypy_cache",
        ".pyc",
        "*.pyc",
        ".fastembed_cache",
        # Rust
        "target",
        "target/",
        # Go
        "vendor",
        "vendor/",
        # build outputs
        "dist",
        "dist/",
        "build",
        "build/",
        ".next",
        ".next/",
        ".nuxt",
        ".nuxt/",
        "out",
        "out/",
        ".output",
        ".output/",
        # coverage / test artefacts
        "coverage",
        "coverage/",
        ".coverage",
        "htmlcov",
        "htmlcov/",
        ".nyc_output",
        # editor / OS junk
        ".DS_Store",
        "Thumbs.db",
        # Terraform state
        ".terraform",
        ".terraform/",
        "*.tfstate",
        "*.tfstate.*",
        # CDK
        "cdk.out",
        "cdk.out/",
        # misc large caches
        ".cache",
        ".cache/",
        ".gradle",
        ".gradle/",
        ".mvn",
        ".mvn/",
        "*.class",
        "*.jar",
        "*.war",
        # repomix snapshots (added by gitignore-generate custom block)
        "repomix.xml",
        "repomix.md",
        "repomix.json",
        "repomix.txt",
    }
)

# Patterns that represent small secret/config files commonly wanted in worktrees.
# These are heuristic "positive" anchors; the algorithm also considers any
# pattern in the gitignore that names a small config-file shape.
_SMALL_FILE_ANCHORS: list[tuple[str, str]] = [
    # pattern → reason comment
    (".env", "local environment variables (small, project-specific)"),
    (".env.*", "environment variable overlays (.env.local, .env.production, …)"),
    (".envrc", "direnv environment config"),
    (".envrc.*", "direnv environment config overlays"),
    ("config/secrets.json", "project secret config file"),
    ("config/secrets.yaml", "project secret config file"),
    ("config/secrets.toml", "project secret config file"),
    ("config/local.json", "local override config"),
    ("config/local.yaml", "local override config"),
    ("config/local.toml", "local override config"),
    (".netrc", "network credentials"),
    (".npmrc", "npm registry config (may carry tokens)"),
    (".pypirc", "PyPI upload credentials"),
    ("credentials.json", "service credentials"),
    ("credentials.yaml", "service credentials"),
    ("service_account.json", "GCP service account key"),
    (".gcloud-credentials.json", "GCP credentials"),
    ("*.pem", "TLS/SSH private key"),
    ("*.key", "private key file"),
    ("id_rsa", "SSH private key"),
    ("id_ed25519", "SSH private key"),
]

# Regex: a pattern is "small-file-shaped" if it has no trailing slash
# (not a directory glob), does not start with *, and looks like a file path
# or a dotfile.  We accept dotfiles and paths with at most one path separator.
_SMALL_FILE_RE = re.compile(
    r"^"
    r"(?!.*/$)"                # must not end with / (not a directory pattern)
    r"(?!.*\*\*/)"             # not a double-star glob (recursive, usually large)
    r"(?!#)"                   # not a comment line
    r"("
    r"  \.[a-zA-Z0-9_.-]+"    # .dotfile
    r"  |"
    r"  [a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+"   # path/to/file
    r"  |"
    r"  [a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+"     # file.ext (no leading dot)
    r")"
    r"$",
    re.VERBOSE,
)


def _normalise(pattern: str) -> str:
    """Strip leading ! (negation) and leading / (anchored)."""
    p = pattern.strip()
    if p.startswith("!"):
        p = p[1:]
    if p.startswith("/"):
        p = p[1:]
    return p


def _is_large(pattern: str) -> bool:
    """Return True if the pattern clearly represents a large dir/artefact."""
    p = _normalise(pattern)
    # Exact match in the large-dir set
    if p in _LARGE_DIR_PATTERNS:
        return True
    # Ends with / → directory
    if p.endswith("/"):
        return True
    # glob covering a build-output extension
    if re.match(r"^\*\.(pyc|class|o|a|so|dll|exe|zip|tar|gz|tgz|bz2|xz|whl|egg)$", p):
        return True
    return False


def _derive_includes(gitignore_text: str) -> list[tuple[str, str]]:
    """Parse gitignore_text and return (pattern, comment) pairs to include.

    Strategy:
    1. Walk the gitignore lines.
    2. Skip blank lines, comments, negation lines (!...), and large patterns.
    3. For the remainder, check if the pattern matches a known anchor or looks
       like a small config file by _SMALL_FILE_RE.
    4. Return the found set, deduplicated, in a stable order: anchors first
       (in anchor declaration order), then discovered extras alphabetically.
    """
    anchor_map: dict[str, str] = {p: c for p, c in _SMALL_FILE_ANCHORS}

    lines = gitignore_text.splitlines()
    anchors_found: list[tuple[str, str]] = []
    anchors_seen: set[str] = set()
    extras_found: list[str] = []
    extras_seen: set[str] = set()

    for line in lines:
        raw = line.strip()
        # Skip blank lines, comments, and negation patterns
        if not raw or raw.startswith("#") or raw.startswith("!"):
            continue

        normed = _normalise(raw)

        # Skip large patterns
        if _is_large(raw):
            continue

        # Check known anchors (exact match on the normalised pattern)
        if normed in anchor_map and normed not in anchors_seen:
            anchors_found.append((normed, anchor_map[normed]))
            anchors_seen.add(normed)
            continue

        # Check small-file shape
        if _SMALL_FILE_RE.match(normed) and normed not in extras_seen:
            extras_found.append(normed)
            extras_seen.add(normed)

    # Combine: anchors in declaration order, then extras alphabetically
    result: list[tuple[str, str]] = list(anchors_found)
    for p in sorted(extras_found):
        result.append((p, "gitignored config/key file — copy into worktrees"))

    return result


def _build_worktreeinclude(includes: list[tuple[str, str]]) -> str:
    """Render the .worktreeinclude file content."""
    if not includes:
        # No patterns found — write a minimal file with a note
        return (
            "# .worktreeinclude — files to copy when creating git worktrees\n"
            "#\n"
            "# No copyable config/secret patterns were detected in .gitignore.\n"
            "# Add gitignored file patterns here (one per line) to have them\n"
            "# copied automatically by worktree helpers (e.g. git-worktree-copy,\n"
            "# worktree shell functions, or agent worktree tooling).\n"
            "#\n"
            "# Example:\n"
            "#   .env\n"
            "#   .envrc\n"
            "#   config/secrets.json\n"
        )

    lines: list[str] = [
        "# .worktreeinclude — files to copy when creating git worktrees",
        "#",
        "# Patterns listed here are gitignored but small enough to copy safely.",
        "# Generated by project-setup worktreeinclude-write from .gitignore.",
        "#",
        "# Usage: git worktree add <path> && cp-worktreeinclude <path>",
        "# (or use your team's worktree bootstrap script / agent hook)",
        "#",
    ]
    for pattern, comment in includes:
        lines.append(f"# {comment}")
        lines.append(pattern)
    lines.append("")  # trailing newline
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# SDK loader (identical boilerplate to every other module)
# ---------------------------------------------------------------------------

def _load_sdk():
    """Load the runner SDK. Fast path: import sdk (executor puts runner dir on
    PYTHONPATH — spec 005). Fallback: load by file path for direct invocation."""
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


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="worktreeinclude-write module")
    ap.add_argument("--plan", required=True, help="path to the frozen plan.json")
    ap.add_argument("--step", required=True, help="step id to run")
    ap.add_argument("--inspect", action="store_true", help="dry pass: preview, no write")
    args = ap.parse_args()

    sdk = _load_sdk()
    # No module-specific inputs; all logic derives from .gitignore on disk.
    sdk.load_frozen_inputs(args.plan, module_id="worktreeinclude-write")

    warnings: list[str] = []

    # Resolve project dir (same logic as sdk.idempotent_write)
    env_pd = os.environ.get("PROJECT_DIR")
    project_dir = Path(env_pd).resolve() if env_pd else Path.cwd().resolve()

    # Read .gitignore (must exist — order constraint: after gitignore-generate)
    gitignore_path = project_dir / ".gitignore"
    if gitignore_path.is_file():
        gitignore_text = gitignore_path.read_text(encoding="utf-8")
    else:
        gitignore_text = ""
        warnings.append(
            ".gitignore not found — worktreeinclude-write runs after gitignore-generate; "
            "writing .worktreeinclude with empty include list."
        )

    includes = _derive_includes(gitignore_text)
    body = _build_worktreeinclude(includes)

    diff = sdk.idempotent_write(
        ".worktreeinclude",
        body,
        reconcile=False,
        inspect=args.inspect,
    )

    files_written = [diff.path] if diff.kind in ("create", "modify") else []
    result = sdk.ModuleResult(
        module_id="worktreeinclude-write",
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
