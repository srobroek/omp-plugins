#!/usr/bin/env python3
"""Deterministic helpers for a user-journeys directory (stdlib only).

Subcommands:
  index <journeys-dir>              Regenerate INDEX.md from journey files.
  lint  <journeys-dir>              Validate structure, not semantic readiness.
  prune <journeys-dir> --keep N     Prune runs/ to the newest N per journey
                                    (dry-run unless --yes).

Format spec: FORMAT.md in the journeys directory.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

STEP_HEADING = re.compile(r"^### (S\d+[a-z]?) — .+ \{#(S\d+[a-z]?)\}\s*$")
DELTA_ENTRY = re.compile(r"^- \*\*Δ(\d+)\*\* (\d{4}-\d{2}-\d{2}) · (.+?) · behavior-change\s*$")
JOURNEY_ID = re.compile(r"^J\d+$")
STEP_REF = re.compile(r"\+?(S\d+[a-z]?)")
RESULTS = {"pass", "fail", "blocked", "skipped"}
STATUSES = {"draft", "active", "deprecated"}
REQUIRED_KEYS = ("id", "title", "version", "status", "last_reviewed")


def parse_frontmatter(text: str) -> dict:
    """Parse the minimal YAML subset the format uses (scalars, inline
    lists/dicts, no nesting). Returns {} when no frontmatter block."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    fm: dict = {}
    for line in lines[1:]:
        if line.strip() == "---":
            return fm
        if not line.strip() or line.lstrip().startswith("#") or ":" not in line:
            continue
        key, _, raw = line.partition(":")
        key, raw = key.strip(), raw.split(" #")[0].strip()
        if raw.startswith("[") and raw.endswith("]"):
            inner = raw[1:-1].strip()
            fm[key] = [v.strip() for v in inner.split(",") if v.strip()] if inner else []
        elif raw.startswith("{") and raw.endswith("}"):
            entries = {}
            inner = raw[1:-1].strip()
            for part in filter(None, (p.strip() for p in inner.split(","))):
                k, _, v = part.partition(":")
                entries[k.strip()] = v.strip()
            fm[key] = entries
        else:
            fm[key] = raw
    return {}  # unterminated frontmatter


def safe_path(path: Path, base: Path) -> None:
    """Refuse a symlink at or below `base`, and refuse a path that escapes it.

    Mirrors safePath in journeys-tool.ts. Only the managed tree is
    attacker-shaped; components above `base` are the user's own filesystem
    layout. Walking those refused every temp directory on macOS, where `/tmp`
    and `/var` are themselves symlinks, and would refuse any real checkout
    reached through a symlinked home or work directory.

    Normalisation is lexical on purpose. Path.resolve() would follow symlinks
    and so erase the very thing being detected: a symlinked run file would
    resolve to its target and then test as a regular file.
    """
    root = Path(os.path.normpath(base.absolute()))
    absolute = Path(os.path.normpath(path.absolute()))
    try:
        inside = absolute.relative_to(root)
    except ValueError:
        raise ValueError(f"outside the managed root: {absolute}") from None
    if root.is_symlink():
        raise ValueError(f"unsafe symlink: {root}")
    current = root
    for part in inside.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError(f"unsafe symlink: {current}")


def safe_journey_paths(root: Path) -> None:
    safe_path(root, root)
    safe_path(root / "INDEX.md", root)
    safe_path(root / "TRACKER.md", root)
    for directory in root.iterdir():
        safe_path(directory, root)
        if not directory.is_dir():
            continue
        safe_path(directory / "journey.md", root)
        runs = directory / "runs"
        safe_path(runs, root)
        if not runs.exists():
            continue
        if not runs.is_dir():
            raise ValueError(f"not a runs directory: {runs}")
        for run in runs.glob("*.md"):
            safe_path(run, root)
            if not run.is_file():
                raise ValueError(f"not a run file: {run}")


def journey_dirs(root: Path) -> list[Path]:
    return sorted(d for d in root.iterdir() if d.is_dir() and (d / "journey.md").exists())


def latest_run(jdir: Path) -> dict | None:
    runs = sorted((jdir / "runs").glob("*.md")) if (jdir / "runs").is_dir() else []
    if not runs:
        return None
    fm = parse_frontmatter(runs[-1].read_text(encoding="utf-8"))
    fm["_file"] = runs[-1].name
    return fm


def open_findings(root: Path) -> dict:
    """Count open findings per journey from TRACKER.md (local reporter)."""
    tracker = root / "TRACKER.md"
    counts: dict = {}
    if not tracker.exists():
        return counts
    for chunk in tracker.read_text(encoding="utf-8").split("<!-- journey-finding")[1:]:
        jid = re.search(r"journey:\s*(\S+)", chunk[:400])
        status = re.search(r"status:\s*(\w+)", chunk[:800])
        if jid and (not status or status.group(1) == "open"):
            counts[jid.group(1)] = counts.get(jid.group(1), 0) + 1
    return counts


def cmd_index(root: Path) -> int:
    safe_journey_paths(root)
    rows = []
    findings = open_findings(root)
    for jdir in journey_dirs(root):
        fm = parse_frontmatter((jdir / "journey.md").read_text(encoding="utf-8"))
        run = latest_run(jdir)
        if run:
            mode = str(run.get("mode", "full")).split("(")[0]
            last = f"{run.get('date', '?')} {run.get('result', '?')} ({mode})"
        else:
            last = "never"
        n_open = findings.get(fm.get("id", ""), 0)
        rows.append(
            "| [{id}]({d}/journey.md) | {t} | {st} | v{v} | {su} | {ifc} | {lr} | {last} | {op} |".format(
                id=fm.get("id", "?"), d=jdir.name, t=fm.get("title", "?"),
                st=fm.get("status", "?"), v=fm.get("version", "?"),
                su=", ".join(fm.get("surfaces", [])) or "—",
                ifc=", ".join(fm.get("interfaces", [])) or "—",
                lr=fm.get("last_reviewed", "?"), last=last,
                op=str(n_open) if n_open else "—",
            )
        )
    body = "\n".join(
        [
            "# Journey index",
            "",
            "Generated by `journeys.py index` — do not hand-edit.",
            "",
            "| id | title | status | version | surfaces | interfaces | last_reviewed | last run | open findings |",
            "|---|---|---|---|---|---|---|---|---|",
            *rows,
            "",
        ]
    )
    (root / "INDEX.md").write_text(body, encoding="utf-8")
    print(f"INDEX.md: {len(rows)} journeys")
    return 0


def lint_journey(jdir: Path, errors: list[str], seen_ids: dict) -> None:
    path = jdir / "journey.md"
    text = path.read_text(encoding="utf-8")
    rel = f"{jdir.name}/journey.md"
    fm = parse_frontmatter(text)
    if not fm:
        errors.append(f"{rel}: missing or unterminated frontmatter")
        return
    for key in REQUIRED_KEYS:
        if key not in fm:
            errors.append(f"{rel}: frontmatter missing `{key}`")
    jid = fm.get("id", "")
    if jid and not JOURNEY_ID.match(jid):
        errors.append(f"{rel}: id `{jid}` does not match J<n>")
    if jid in seen_ids:
        errors.append(f"{rel}: duplicate id `{jid}` (also {seen_ids[jid]})")
    seen_ids[jid] = rel
    if jid and not jdir.name.startswith(f"{jid}-"):
        errors.append(f"{rel}: directory `{jdir.name}` does not start with `{jid}-`")
    if fm.get("status") and fm["status"] not in STATUSES:
        errors.append(f"{rel}: status `{fm['status']}` not in {sorted(STATUSES)}")
    if fm.get("version") and not str(fm["version"]).isdigit():
        errors.append(f"{rel}: version `{fm['version']}` is not an integer")

    step_ids: list[str] = []
    for n, line in enumerate(text.splitlines(), 1):
        if line.startswith("### ") and "{#" in line:
            m = STEP_HEADING.match(line)
            if not m:
                errors.append(f"{rel}:{n}: malformed step heading (want `### S<id> — title {{#S<id>}}`)")
                continue
            if m.group(1) != m.group(2):
                errors.append(f"{rel}:{n}: heading id {m.group(1)} != anchor {m.group(2)}")
            if m.group(1) in step_ids:
                errors.append(f"{rel}:{n}: duplicate step id {m.group(1)}")
            step_ids.append(m.group(1))
        elif line.startswith("### S"):
            errors.append(f"{rel}:{n}: step heading missing `{{#S<id>}}` anchor")

    version = int(fm["version"]) if str(fm.get("version", "")).isdigit() else None
    for n, line in enumerate(text.splitlines(), 1):
        m = DELTA_ENTRY.match(line)
        if not m:
            continue
        if version is not None and int(m.group(1)) > version:
            errors.append(f"{rel}:{n}: delta Δ{m.group(1)} exceeds journey version {version}")
        for ref in STEP_REF.findall(m.group(3)):
            if ref not in step_ids:
                errors.append(f"{rel}:{n}: delta Δ{m.group(1)} references unknown step {ref}")

    for run in sorted((jdir / "runs").glob("*.md")) if (jdir / "runs").is_dir() else []:
        rfm = parse_frontmatter(run.read_text(encoding="utf-8"))
        rrel = f"{jdir.name}/runs/{run.name}"
        if not rfm:
            errors.append(f"{rrel}: missing frontmatter")
            continue
        if rfm.get("journey") != jid:
            errors.append(f"{rrel}: journey `{rfm.get('journey')}` != `{jid}`")
        if rfm.get("result") not in {"pass", "fail", "blocked"}:
            errors.append(f"{rrel}: result `{rfm.get('result')}` not pass|fail|blocked")
        for sid, res in (rfm.get("steps") or {}).items():
            if res not in RESULTS:
                errors.append(f"{rrel}: step {sid} result `{res}` not in {sorted(RESULTS)}")
            if sid not in step_ids:
                errors.append(f"{rrel}: unknown step id {sid}")


def cmd_lint(root: Path) -> int:
    safe_journey_paths(root)
    errors: list[str] = []
    seen: dict = {}
    dirs = journey_dirs(root)
    if not dirs:
        print(f"no journeys found under {root}", file=sys.stderr)
    for jdir in dirs:
        lint_journey(jdir, errors, seen)
    for err in errors:
        print(f"ERROR {err}")
    print(f"structural lint: {len(dirs)} journeys, {len(errors)} errors; semantic readiness not assessed")
    return 1 if errors else 0


def cmd_prune(root: Path, keep: int, yes: bool, journey: str | None = None) -> int:
    if type(keep) is not int or keep < 0 or keep > 9007199254740991:
        print("keep must be a finite nonnegative safe integer", file=sys.stderr)
        return 2
    safe_journey_paths(root)
    doomed: list[Path] = []
    dirs = journey_dirs(root)
    selected = dirs if journey is None else [jdir for jdir in dirs if jdir.name == journey]
    if journey is not None and len(selected) != 1:
        print(f"unknown journey directory: {journey}", file=sys.stderr)
        return 2
    for jdir in selected:
        runs = sorted((jdir / "runs").glob("*.md")) if (jdir / "runs").is_dir() else []
        doomed.extend(runs[:-keep] if keep else runs)
    for path in doomed:
        print(f"{'delete' if yes else 'would delete'} {path.relative_to(root)}")
        if yes:
            path.unlink()
    print(f"prune: {len(doomed)} run files {'deleted' if yes else 'to delete (use --yes)'}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("index", "lint", "prune"):
        p = sub.add_parser(name)
        p.add_argument("journeys_dir", type=Path)
        if name == "prune":
            p.add_argument("--keep", type=int, default=20)
            p.add_argument("--yes", action="store_true")
            p.add_argument("--journey", help="selected journey directory name; omit only for an explicitly authorized directory-wide prune")
    args = ap.parse_args(argv)
    root = args.journeys_dir.absolute()
    if not root.is_dir():
        print(f"not a directory: {root}", file=sys.stderr)
        return 2
    try:
        if args.cmd == "index":
            return cmd_index(root)
        if args.cmd == "lint":
            return cmd_lint(root)
        return cmd_prune(root, args.keep, args.yes, args.journey)
    except (OSError, ValueError) as exc:
        print(f"ERROR {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
