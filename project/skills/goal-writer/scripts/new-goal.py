#!/usr/bin/env python3
"""Create a scaffolded goal markdown file.

The script writes to the shared goal store by default:
~/.local/state/agentic-tools/goals/

It uses only the Python standard library. Unlike the handover store, goals are
KEPT, not replaced: a project accumulates many goals over time, so the filename
carries a goal-slug (`<project-slug>__<goal-slug>.md`). Two goals only collide
when their titles slugify identically.

The composed goal body (the nine template sections) is read from stdin; the
script prepends YAML frontmatter and writes the file with user-private
permissions. With no stdin, it scaffolds an empty body.
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

DEFAULT_GOAL_DIR = Path.home() / ".local" / "state" / "agentic-tools" / "goals"


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


def slug(value: str, fallback: str = "goal") -> str:
    value = value.strip().lower()
    value = re.sub(r"[\\/\s]+", "-", value)
    value = re.sub(r"[^a-z0-9._-]+", "-", value)
    value = re.sub(r"-{2,}", "-", value)
    return value.strip(".-_") or fallback


def discover(cwd: Path) -> dict[str, str]:
    repo_root = run_git(["rev-parse", "--show-toplevel"], cwd)
    worktree = repo_root or str(cwd)
    project = Path(worktree).name
    return {
        "project": project,
        "repo_root": repo_root or str(cwd),
    }


def _yaml_scalar(value: str) -> str:
    """Quote a frontmatter scalar so embedded newlines/quotes can't inject keys.

    json.dumps emits a double-quoted string with \\n, \\", and \\\\ escaped. A
    JSON string is a valid YAML 1.1/1.2 flow (double-quoted) scalar, so the
    result parses back as the original single value -- a newline in the source
    prompt or repo_root stays inside the value instead of starting a new key.
    """
    return json.dumps(str(value))


SCAFFOLD_BODY = """## Goal

TODO

## Context / why now

TODO

## Outcomes

- TODO

## Results (deliverables)

- TODO

## KPIs

| metric | acceptance band | target | measurement method |
|---|---|---|---|
| TODO | TODO | TODO | TODO |

## Measurement

TODO

## Validation

TODO

## Exit conditions

- [ ] TODO

## Out of scope / non-goals

- TODO
"""


def build_content(
    *, project: str, goal: str, repo_root: str, source_prompt: str, body: str
) -> str:
    created = (
        datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    )
    body = body.strip() or SCAFFOLD_BODY.strip()
    return f"""---
project: {_yaml_scalar(project)}
goal: {_yaml_scalar(goal)}
repo_root: {_yaml_scalar(repo_root)}
source_prompt: {_yaml_scalar(source_prompt)}
created: {_yaml_scalar(created)}
---

# Goal: {goal}

{body}
"""


class GoalWriteError(Exception):
    """Raised when the goal file cannot be written (e.g. out-dir is a file)."""


def write_private(path: Path, content: str) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        # A path component already exists as a file (FileExistsError /
        # NotADirectoryError, both OSError subclasses). Surface a clean message
        # instead of an uncaught traceback.
        raise GoalWriteError(
            f"cannot create goal directory {path.parent}: {exc}"
        ) from exc
    try:
        path.parent.chmod(0o700)
    except OSError:
        pass

    try:
        fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    except OSError as exc:
        raise GoalWriteError(
            f"cannot write goal into {path.parent}: {exc}"
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
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_GOAL_DIR, help="Goal output directory")
    parser.add_argument("--title", required=True, help="Goal title (drives the goal-slug and heading)")
    parser.add_argument("--project", help="Project slug/name for frontmatter and filename")
    parser.add_argument("--repo-root", help="Repo root for frontmatter")
    parser.add_argument("--source-prompt", default="", help="Original vague goal prompt, verbatim")
    parser.add_argument(
        "--body-file",
        type=Path,
        help="File holding the composed body; defaults to stdin, then a scaffold",
    )
    return parser.parse_args(argv)


def _read_body(args: argparse.Namespace) -> str:
    if args.body_file is not None:
        try:
            return args.body_file.read_text(encoding="utf-8")
        except OSError as exc:
            raise GoalWriteError(f"cannot read --body-file {args.body_file}: {exc}") from exc
    if not sys.stdin.isatty():
        return sys.stdin.read()
    return ""


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    cwd = args.cwd.resolve()
    discovered = discover(cwd)

    project = args.project or discovered["project"]
    repo_root = args.repo_root or discovered["repo_root"]

    try:
        body = _read_body(args)
    except GoalWriteError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    filename = f"{slug(project)}__{slug(args.title)}.md"
    path = args.out_dir.expanduser() / filename
    content = build_content(
        project=project,
        goal=args.title,
        repo_root=repo_root,
        source_prompt=args.source_prompt,
        body=body,
    )
    try:
        write_private(path, content)
    except GoalWriteError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
