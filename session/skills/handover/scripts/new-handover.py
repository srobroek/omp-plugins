#!/usr/bin/env python3
"""Create a scaffolded handover markdown file.

The script writes to the shared handover store by default:
~/.local/state/agentic-tools/handovers/

It uses only the Python standard library and replaces the active handover for
the same project/branch-or-task slug.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path

DEFAULT_HANDOVER_DIR = Path.home() / ".local" / "state" / "agentic-tools" / "handovers"


def run_git(args: list[str], cwd: Path) -> str | None:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=cwd,
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError:
        return None

    if result.returncode != 0:
        return None

    value = result.stdout.strip()
    return value or None


def slug(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[\\/\s]+", "-", value)
    value = re.sub(r"[^a-z0-9._-]+", "-", value)
    value = re.sub(r"-{2,}", "-", value)
    return value.strip(".-_") or "handover"


def discover(cwd: Path) -> dict[str, str]:
    repo_root = run_git(["rev-parse", "--show-toplevel"], cwd)
    branch = run_git(["branch", "--show-current"], cwd)

    if not branch:
        short_sha = run_git(["rev-parse", "--short", "HEAD"], cwd)
        branch = f"detached-{short_sha}" if short_sha else "unknown-branch"

    worktree = repo_root or str(cwd)
    project = Path(worktree).name

    return {
        "project": project,
        "repo_root": repo_root or str(cwd),
        "worktree": worktree,
        "branch": branch,
    }


def _yaml_scalar(value: str) -> str:
    """Quote a frontmatter scalar so embedded newlines/quotes can't inject keys.

    json.dumps emits a double-quoted string with \\n, \\", and \\\\ escaped. A
    JSON string is a valid YAML 1.1/1.2 flow (double-quoted) scalar, so the
    result parses back as the original single value -- a newline in repo_root or
    branch stays inside the value instead of starting a new frontmatter key.
    """
    return json.dumps(str(value))


def build_content(
    *,
    project: str,
    repo_root: str,
    worktree: str,
    branch: str,
    task: str,
    beads: list[str] | None = None,
) -> str:
    updated = datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    # json.dumps of a list of strings is a valid YAML flow sequence, with the
    # same injection-safety argument as _yaml_scalar.
    beads_line = f"beads: {json.dumps([str(b) for b in beads])}\n" if beads else ""
    frontmatter = f"""---
project: {_yaml_scalar(project)}
repo_root: {_yaml_scalar(repo_root)}
worktree: {_yaml_scalar(worktree)}
branch: {_yaml_scalar(branch)}
task: {_yaml_scalar(task)}
{beads_line}updated: {_yaml_scalar(updated)}
---

# Handover: {project} / {task or branch}
"""
    if beads:
        bead_items = "\n".join(f"- {b}: TODO where work stopped" for b in beads)
        return frontmatter + f"""
## Summary

- TODO

## Read First

- TODO

## Active Beads

{bead_items}

Task state lives in beads: run `bd ready` and `bd list --status in_progress`.

## Decisions

- TODO

## Runtime State

None known

## Avoid / Do Not Redo

None

## Next Session Prompt

TODO: Continue from this handover. Run `bd show` on the active beads and fresh git status, then proceed with the next concrete step.
"""
    return frontmatter + """
## Summary

- TODO

## Read First

- TODO

## Changed Areas

- TODO

## Complete

- TODO

## Incomplete

- TODO

## Blockers

None known

## Decisions

- TODO

## Verification / Commands

Not run

## Runtime State

None known

## Avoid / Do Not Redo

None

## Next Session Prompt

TODO: Continue from this handover. First inspect the referenced files and fresh git status, then proceed with the next concrete step.
"""


class HandoverWriteError(Exception):
    """Raised when the handover file cannot be written (e.g. out-dir is a file)."""


def write_private(path: Path, content: str) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        # A path component already exists as a file (FileExistsError /
        # NotADirectoryError, both OSError subclasses). Surface a clean message
        # instead of an uncaught traceback.
        raise HandoverWriteError(
            f"cannot create handover directory {path.parent}: {exc}"
        ) from exc
    try:
        path.parent.chmod(0o700)
    except OSError:
        pass

    try:
        fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    except OSError as exc:
        raise HandoverWriteError(
            f"cannot write handover into {path.parent}: {exc}"
        ) from exc
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
        try:
            tmp_path.chmod(0o600)
        except OSError:
            pass
        tmp_path.replace(path)
        try:
            path.chmod(0o600)
        except OSError:
            pass
    finally:
        if tmp_path.exists():
            tmp_path.unlink()


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cwd", type=Path, default=Path.cwd(), help="Project directory to inspect")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_HANDOVER_DIR, help="Handover output directory")
    parser.add_argument("--project", help="Project slug/name for frontmatter and filename")
    parser.add_argument("--branch", help="Branch name for frontmatter and filename")
    parser.add_argument("--task", help="Task/spec/issue id for frontmatter and filename")
    parser.add_argument("--repo-root", help="Repo root for frontmatter")
    parser.add_argument("--worktree", help="Worktree path for frontmatter")
    parser.add_argument(
        "--beads",
        help="Comma-separated active bead IDs; switches the body to the narrative-only beads layout",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    cwd = args.cwd.resolve()
    discovered = discover(cwd)

    project = args.project or discovered["project"]
    branch = args.branch or discovered["branch"]
    task = args.task or branch
    repo_root = args.repo_root or discovered["repo_root"]
    worktree = args.worktree or discovered["worktree"]

    beads = [b.strip() for b in (args.beads or "").split(",") if b.strip()]

    filename = f"{slug(project)}__{slug(task)}.md"
    path = args.out_dir.expanduser() / filename
    content = build_content(
        project=project,
        repo_root=repo_root,
        worktree=worktree,
        branch=branch,
        task=task,
        beads=beads or None,
    )
    try:
        write_private(path, content)
    except HandoverWriteError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
