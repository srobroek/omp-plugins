#!/usr/bin/env python3
# Adapted from srobroek/agentic-packages, packages/adr-as-beads/scripts/render_adrs.py.
#
# A prek `entry:` must resolve inside the repository being committed. This script and
# templates/pre-commit-adr.yaml therefore ship together. This copy also owns the package-specific
# index markers and reconciliation behavior below; those changes are not present upstream.
# Port applicable upstream fixes deliberately instead of replacing this file wholesale.
"""Render MADR files from beads `decision` beads.

The bead is the record; the file is a projection of it. Nothing here is a source
of truth, so this never edits a bead and never syncs: it reads the local Dolt
store through `bd export` and writes markdown.

`bd export` rather than `bd list --type decision --json`, which omits `design`,
`notes`, `dependencies`, and `spec_id` -- the fields an ADR is made of. Rather
than `bd show` per bead too: show carries everything but costs ~0.45s each,
where one export costs ~0.45s total and is byte-identical across runs.

Only CLOSED decisions render. A `deferred` bead is a proposed decision nobody
has settled, and an `open` one is being drafted right now; writing either to
docs/adr/ would publish a choice that has not been made.

Exit codes: 0 on success or any environment gap (no `bd`, no database, no
decisions), 1 only when rendering itself fails. A missing tool must not block a
commit -- see the hook-contract fail-open rule.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ADR_DIR = Path("docs/adr")

# The index `docs/adr` ships carries a table for the records. Left alone it keeps the
# empty placeholder row while numbered files accumulate beside it, so the one artefact a
# reader opens first is the one that says there are no decisions.
#
# Only the rows between these markers are rewritten. The prose above them explains the
# convention and is the project's to edit, and the template row a hand-written record
# would use survives.
INDEX_FILE = ADR_DIR / "index.md"
GENERATED_MARKER = "<!-- Generated from a beads decision bead. Edit the bead, not this file:"
INDEX_BEGIN = "<!-- BEGIN GENERATED: decisions -->"
INDEX_END = "<!-- END GENERATED: decisions -->"

# Bare `bd` inherits the caller's pager and interactive prompts. A git hook has
# no tty, so an unset pager can hang the commit rather than fail it.
BD_ENV_FLAGS = {"BD_NO_PAGER": "1", "BD_NON_INTERACTIVE": "1"}

# MADR 4.0.0 section order. The bead field each one reads is resolved in
# `render_one`; a section with nothing behind it is omitted rather than emitted
# with a placeholder, because a placeholder reads as an answered question.
_SLUG_STRIP = re.compile(r"[^a-z0-9]+")


def slugify(title: str) -> str:
    """Kebab-case a title for the filename, collapsing runs of punctuation."""
    return _SLUG_STRIP.sub("-", title.lower()).strip("-") or "untitled"


def run_bd(args: list[str], cwd: Path) -> subprocess.CompletedProcess[str] | None:
    """Run a bd subcommand, returning None when bd is absent or errors.

    Absence is the common case in CI and on a fresh clone, and it is not a
    failure: the committed markdown is already correct there, since whoever
    committed it had the database.
    """
    if shutil.which("bd") is None:
        return None
    import os

    env = dict(os.environ)
    env.update(BD_ENV_FLAGS)
    try:
        return subprocess.run(  # noqa: S603
            ["bd", *args],
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None


def export_decisions(repo: Path) -> list[dict] | None:
    """Return every decision bead, or None when the database is unreachable.

    `bd export` writes to a path rather than stdout, so this uses a temp file
    and reads it back. The export is JSONL: one bead per line.
    """
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "beads.jsonl"
        result = run_bd(["export", "--output", str(out)], repo)
        if result is None or result.returncode != 0 or not out.is_file():
            return None
        rows = []
        for line in out.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                # One malformed line must not discard every other decision.
                continue
    return [r for r in rows if r.get("issue_type") == "decision"]


def sections_from(bead: dict) -> dict[str, str]:
    """Split a bead description on its `## ` headings.

    `bd lint` enforces `## Decision`, `## Rationale`, and
    `## Alternatives Considered` on a decision bead, so the description is
    already sectioned markdown. Anything before the first heading is preamble
    and becomes the context section.
    """
    text = (bead.get("description") or "").strip()
    if not text:
        return {}
    parts = re.split(r"^##\s+(.+?)\s*$", text, flags=re.MULTILINE)
    out: dict[str, str] = {}
    preamble = parts[0].strip()
    if preamble:
        out["_preamble"] = preamble
    for name, body in zip(parts[1::2], parts[2::2]):
        out[name.strip()] = body.strip()
    return out


def supersession(bead: dict) -> tuple[list[str], list[str]]:
    """Return (supersedes, superseded_by) bead ids from typed edges.

    `bd supersede <old> --with <new>` records the edge on the OLD bead pointing
    at the new one, so a bead's own `supersedes` dependency means it has been
    replaced. Reading the edge rather than a metadata key keeps the file and the
    bead from disagreeing, which is what a hand-maintained field allowed.
    """
    superseded_by = [
        dep.get("depends_on_id") or dep.get("id")
        for dep in bead.get("dependencies") or []
        if dep.get("dependency_type") == "supersedes" or dep.get("type") == "supersedes"
    ]
    return [], [d for d in superseded_by if d]


def render_one(bead: dict, number: int) -> str:
    """Render one bead as a MADR document."""
    title = (bead.get("title") or "Untitled decision").strip()
    sections = sections_from(bead)
    _, superseded_by = supersession(bead)

    status = "superseded" if superseded_by else "accepted"
    date = (bead.get("closed_at") or bead.get("updated_at") or "")[:10]

    # Frontmatter opens the file. A leading HTML comment pushes `---` off line 1, and a
    # frontmatter parser then reads the block as body text, so `status`, `date`, and
    # `bead` go invisible to anything that indexes these records. The provenance note
    # follows the block instead.
    lines = [
        "---",
        f"number: {number}",
        # JSON string quoting is also valid YAML and keeps colons, hashes,
        # booleans, and newlines in a title from corrupting frontmatter.
        f"title: {json.dumps(title, ensure_ascii=False)}",
        f"status: {status}",
        f"date: {date}",
        f"bead: {bead.get('id')}",
    ]
    if spec := bead.get("spec_id"):
        lines.append(f"spec: {spec}")
    if superseded_by:
        lines.append(f"superseded-by: {', '.join(superseded_by)}")
    lines += [
        "---",
        "",
        "<!-- Generated from a beads decision bead. Edit the bead, not this file:",
        f"     bd show {bead.get('id')} -->",
        "",
        f"# {title}",
        "",
    ]

    if superseded_by:
        lines += [
            f"> Superseded by {', '.join(superseded_by)}. Kept because it records"
            " what was believed at the time.",
            "",
        ]

    context = sections.get("Context and Problem Statement") or sections.get("_preamble")
    if context:
        lines += ["## Context and Problem Statement", "", context, ""]
    if drivers := sections.get("Decision Drivers"):
        lines += ["## Decision Drivers", "", drivers, ""]
    if options := sections.get("Alternatives Considered") or sections.get(
        "Considered Options"
    ):
        lines += ["## Considered Options", "", options, ""]

    outcome = sections.get("Decision") or sections.get("Decision Outcome")
    rationale = sections.get("Rationale")
    if outcome or rationale:
        lines += ["## Decision Outcome", ""]
        if outcome:
            lines += [outcome, ""]
        if rationale:
            lines += ["### Rationale", "", rationale, ""]

    if consequences := sections.get("Consequences"):
        lines += ["### Consequences", "", consequences, ""]
    if confirmation := sections.get("Confirmation") or bead.get("acceptance_criteria"):
        lines += ["### Confirmation", "", confirmation, ""]

    # `design` holds rationale, evidence, unknowns, bounds, and alternatives per
    # the carrier doctrine, and notes hold the running narrative. Both are ADR
    # substance rather than metadata, so they render rather than being dropped.
    if design := (bead.get("design") or "").strip():
        lines += ["## More Information", "", design, ""]
    if notes := (bead.get("notes") or "").strip():
        if not design:
            lines += ["## More Information", ""]
        lines += [notes, ""]

    return "\n".join(lines).rstrip() + "\n"


def render_index(entries: list[tuple[int, str, str, str]]) -> str:
    """The generated row block for docs/adr/index.md.

    Newest last, matching what the shipped index says the order is. A row links the
    file and names the bead, so a reader can reach either the record or its source.
    """
    lines = [INDEX_BEGIN, "| ADR | Title | Status | Bead |", "|---|---|---|---|"]
    for number, title, status, bead in entries:
        slug = f"{number:04d}-{slugify(title)}.md"
        lines.append(f"| [{number:04d}]({slug}) | {title} | {status} | `{bead}` |")
    lines.append(INDEX_END)
    return "\n".join(lines)


def update_index(repo: Path, entries: list[tuple[int, str, str, str]], *, write: bool) -> Path | None:
    """Rewrite the index's generated rows. Returns the path when it is stale.

    Absent markers are not an error: `docs/adr` may not have rendered, or a project may
    have replaced the index with its own. Injecting a table into a file that never asked
    for one would be worse than leaving it alone, so this reports nothing in that case.
    """
    path = repo / INDEX_FILE
    if not path.is_file():
        return None

    current = path.read_text(encoding="utf-8")
    if INDEX_BEGIN not in current or INDEX_END not in current:
        return None

    head, _, rest = current.partition(INDEX_BEGIN)
    _, _, tail = rest.partition(INDEX_END)
    updated = head + render_index(entries) + tail
    if updated == current:
        return None
    if write:
        path.write_text(updated, encoding="utf-8")
    return path


def render_all(repo: Path, *, write: bool = True) -> tuple[list[Path], str | None]:
    """Reconcile every closed decision and renderer-owned projection.

    ``write=False`` is the --check path and must not touch the tree. A reachable
    database with no closed decisions is still authoritative: generated ADR files
    and index rows are removed, while files without the generated marker survive.
    """
    beads = export_decisions(repo)
    if beads is None:
        return [], "no beads database reachable"

    closed = [b for b in beads if b.get("status") == "closed"]

    # Number by creation order, not bead id: `adr-11` must not become 0011 with
    # ten gaps. Ties break on id so the numbering is stable across runs.
    closed.sort(key=lambda b: ((b.get("created_at") or ""), b.get("id") or ""))

    target = repo / ADR_DIR
    if write and closed:
        target.mkdir(parents=True, exist_ok=True)

    changed: list[Path] = []
    desired: set[Path] = set()
    entries: list[tuple[int, str, str, str]] = []
    for index, bead in enumerate(closed, start=1):
        body = render_one(bead, index)
        title = (bead.get("title") or "Untitled decision").strip()
        path = target / f"{index:04d}-{slugify(title)}.md"
        desired.add(path)

        # The index row is collected for every decision, not only the stale ones: the
        # table has to list all of them, and a run where one file changed still needs
        # the complete set.
        _, superseded_by = supersession(bead)
        entries.append(
            (
                index,
                title,
                "superseded" if superseded_by else "accepted",
                bead.get("id") or "",
            )
        )

        # Compare before writing, so an unrelated commit does not restage every ADR.
        if path.is_file() and path.read_text(encoding="utf-8") == body:
            continue
        changed.append(path)
        if write:
            path.write_text(body, encoding="utf-8")

    # The marker is the ownership boundary. A hand-authored markdown file in the
    # same directory is never removed, even when there are no decisions left.
    if target.is_dir():
        for path in sorted(target.glob("*.md")):
            if path in desired or path.name == INDEX_FILE.name or not path.is_file():
                continue
            if GENERATED_MARKER not in path.read_text(encoding="utf-8"):
                continue
            changed.append(path)
            if write:
                path.unlink()

    if stale_index := update_index(repo, entries, write=write):
        changed.append(stale_index)
    return changed, None


def stage(paths: list[Path], repo: Path) -> str | None:
    """Stage what was written, so it lands in the triggering commit.

    Required, not a convenience: prek fails a commit outright when a hook
    modifies a tracked file and leaves it unstaged, and silently omits a new
    untracked one. Staging is what makes a writing hook viable.

    Returns a description of the failure, or None when the files are staged.
    Swallowing the failure produced exactly the outcome the paragraph above
    warns about, with prek reporting a hook that modified files while the real
    cause stayed invisible.
    """
    if not paths:
        return None
    try:
        result = subprocess.run(  # noqa: S603
            ["git", "add", "--", *[str(p) for p in paths]],
            cwd=repo,
            capture_output=True,
            check=False,
            timeout=30,
            text=True,
        )
    except subprocess.TimeoutExpired:
        return "git add did not finish within 30s"
    except OSError as exc:
        return f"git could not be run: {exc}"
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip() or f"exit {result.returncode}"
        return f"git add failed: {detail}"
    return None


def main(argv: list[str]) -> int:
    check_only = "--check" in argv
    repo = Path.cwd()

    try:
        written, skipped = render_all(repo, write=not check_only)
    except Exception as exc:  # noqa: BLE001
        print(f"render-adrs: {exc}", file=sys.stderr)
        return 1

    if skipped:
        # A clone without the database cannot establish the desired set, so leave the
        # projections alone rather than guessing and deleting renderer-owned files.
        return 0

    if check_only:
        if written:
            print(
                "render-adrs: these renderer-owned files are stale relative to their beads:",
                file=sys.stderr,
            )
            for path in written:
                print(f"  {path}", file=sys.stderr)
            print("Run the renderer and commit the result.", file=sys.stderr)
            return 1
        return 0

    failure = stage(written, repo)
    for path in written:
        print(f"render-adrs: {'removed' if not path.exists() else 'wrote'} {path}")
    if failure is not None:
        print(f"render-adrs: {failure}", file=sys.stderr)
        print(
            "The rendered files exist but are unstaged, which prek reports as a hook that modified files.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
