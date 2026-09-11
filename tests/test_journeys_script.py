"""Regression tests for the journey-init helper script.

`journeys.py` is a function-for-function port of `project/extensions/journeys-tool.ts`,
so a defect found in one copy is a candidate in the other. These cover the two that
were confirmed in the Python copy and had no protection: an unguarded duplicate-id
write, and frontmatter parsing that could not distinguish a malformed block from an
empty one.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "project"
    / "skills"
    / "journey-init"
    / "scripts"
    / "journeys.py"
)


def load_journeys() -> ModuleType:
    """Import the script by path; it ships as a standalone file, not a package."""
    spec = importlib.util.spec_from_file_location("journeys_under_test", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_journey(root: Path, name: str, body: str) -> Path:
    jdir = root / name
    jdir.mkdir(parents=True)
    (jdir / "journey.md").write_text(body, encoding="utf-8")
    return jdir


def test_journeys_without_an_id_do_not_collide(tmp_path: Path) -> None:
    """Two journeys that omit `id:` must not be reported as duplicates.

    Both read as "", so an unconditional `seen_ids[jid] = rel` made the second one
    report ``duplicate id `` `` beside the `missing id` error that already named the
    real problem.
    """
    journeys = load_journeys()
    write_journey(tmp_path, "J1-alpha", "---\ntitle: alpha\n---\n")
    write_journey(tmp_path, "J2-beta", "---\ntitle: beta\n---\n")

    errors: list[str] = []
    seen: dict = {}
    for jdir in journeys.journey_dirs(tmp_path):
        journeys.lint_journey(jdir, errors, seen)

    assert not [e for e in errors if "duplicate id" in e]
    # The real defect is still reported, once per journey.
    assert len([e for e in errors if "missing `id`" in e]) == 2


def test_a_shared_id_is_still_reported(tmp_path: Path) -> None:
    """Guarding the empty case must not stop real collisions being caught."""
    journeys = load_journeys()
    write_journey(tmp_path, "J1-alpha", "---\nid: J1\ntitle: alpha\n---\n")
    write_journey(tmp_path, "J1-beta", "---\nid: J1\ntitle: beta\n---\n")

    errors: list[str] = []
    seen: dict = {}
    for jdir in journeys.journey_dirs(tmp_path):
        journeys.lint_journey(jdir, errors, seen)

    assert [e for e in errors if "duplicate id `J1`" in e]


def test_unterminated_frontmatter_is_distinguishable_from_empty() -> None:
    """The parser must not use one value for "malformed" and "empty".

    An empty dict meant both, so any caller probing truthiness treated a truncated
    file as a file whose fields were simply absent.
    """
    journeys = load_journeys()

    assert journeys.parse_frontmatter("---\nid: J1\n") is None, "unterminated"
    assert journeys.parse_frontmatter("no frontmatter here\n") is None, "absent"
    assert journeys.parse_frontmatter("---\n---\n") == {}, "terminated but empty"
    assert journeys.parse_frontmatter("---\nid: J1\n---\n") == {"id": "J1"}


def test_index_reports_an_unreadable_run_instead_of_placeholders(tmp_path: Path) -> None:
    """A truncated run file must be named in the index, not rendered as `? ?`.

    `latest_run` wrote `_file` onto the empty dict, making failure truthy, so
    `cmd_index` could not tell a malformed run from one missing optional fields and
    published `? ?` with exit 0.
    """
    journeys = load_journeys()
    jdir = write_journey(
        tmp_path,
        "J1-alpha",
        "---\nid: J1\ntitle: alpha\nstatus: active\nversion: 1\n"
        "last_reviewed: 2026-01-01\n---\n",
    )
    runs = jdir / "runs"
    runs.mkdir()
    # Every field a reader wants is present; only the terminator is missing.
    (runs / "r.md").write_text(
        "---\njourney: J1\ndate: 2026-09-11\nresult: pass\nmode: full\n",
        encoding="utf-8",
    )

    # `index` generates and `lint` validates, so the status stays 0; the defect was
    # that nothing was reported, which the marked row and the stderr line fix.
    assert journeys.cmd_index(tmp_path) == 0
    row = next(
        line
        for line in (tmp_path / "INDEX.md").read_text(encoding="utf-8").splitlines()
        if line.startswith("| [J1]")
    )
    assert "unreadable" in row
    assert "? ?" not in row


def test_index_is_unchanged_for_a_well_formed_run(tmp_path: Path) -> None:
    """The reporting change must not alter output for valid input."""
    journeys = load_journeys()
    jdir = write_journey(
        tmp_path,
        "J1-alpha",
        "---\nid: J1\ntitle: alpha\nstatus: active\nversion: 1\n"
        "last_reviewed: 2026-01-01\n---\n",
    )
    runs = jdir / "runs"
    runs.mkdir()
    (runs / "r.md").write_text(
        "---\njourney: J1\ndate: 2026-09-11\nresult: pass\nmode: full\n---\n",
        encoding="utf-8",
    )

    assert journeys.cmd_index(tmp_path) == 0
    row = next(
        line
        for line in (tmp_path / "INDEX.md").read_text(encoding="utf-8").splitlines()
        if line.startswith("| [J1]")
    )
    assert "2026-09-11 pass (full)" in row

def test_a_run_with_no_frontmatter_is_not_treated_as_lost_data(tmp_path: Path) -> None:
    """Absent and unterminated are different conditions and must stay different.

    A run file with no block at all declared nothing, so nothing was discarded -
    that is a lint concern. Only a truncated block means fields were present in the
    file and thrown away. Conflating them made `index` fail on ordinary fixtures
    that seed runs as plain text, which is exactly what journeys-tool.test.ts does.
    """
    journeys = load_journeys()
    jdir = write_journey(
        tmp_path,
        "J1-alpha",
        "---\nid: J1\ntitle: alpha\nstatus: active\nversion: 1\n"
        "last_reviewed: 2026-01-01\n---\n",
    )
    runs = jdir / "runs"
    runs.mkdir()
    (runs / "2026-01-01.md").write_text("old", encoding="utf-8")

    assert journeys.frontmatter_is_unterminated("old") is False
    assert journeys.frontmatter_is_unterminated("---\nid: J1\n") is True
    # No block at all: the index still publishes and still succeeds.
    assert journeys.cmd_index(tmp_path) == 0
