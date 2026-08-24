#!/usr/bin/env python3
"""Query each dependency's registry for the latest version and classify the bump.

Input: ``ecosystem<TAB>name<TAB>version`` lines, either on stdin (when
``RESEARCH_USE_STDIN=1``) or from ``detect.py`` run against a project directory.

Output: one JSON record per dependency on stdout, and a summary on stderr:

    {"ecosystem":"pypi","name":"requests","installed":"2.28.0",
     "latest":"2.32.3","class":"MINOR-CHECK","status":"OK"}

status values:
  OK            classified successfully
  CURRENT       installed == latest; omit from the upgrade plan
  UNRESOLVABLE  404, auth, or network error; skipped gracefully
  DISCONFIRMED  every PyPI file for the candidate is yanked; skipped

Test seam: set ``DEP_UPDATE_FIXTURE_DIR`` to a directory of
``<ecosystem>_<name>.json`` files. Registry reads then come from those files and
a missing fixture simulates being offline, so the suite makes no network call.

Usage: ``research.py [project-dir]``
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
USER_AGENT = "dep-update-skill (+https://github.com/srobroek/agentic-packages)"
TIMEOUT_SECONDS = 10

_VERSION_HEAD = re.compile(r"^(\d+)(?:\.(\d+))?(?:\.(\d+))?")
_PRERELEASE = re.compile(r"(a|b|rc|alpha|beta|dev|post)[\d.]", re.IGNORECASE)


def note(message: str = "") -> None:
    print(message, file=sys.stderr)


def fetch_json(ecosystem: str, name: str, url: str) -> dict:
    """Fetch registry JSON, honouring the fixture directory for offline tests."""
    fixture_dir = os.environ.get("DEP_UPDATE_FIXTURE_DIR", "")
    if fixture_dir:
        safe_name = name.replace("/", "__").replace("@", "__at__")
        fixture = Path(fixture_dir) / f"{ecosystem}_{safe_name}.json"
        if fixture.exists():
            return json.loads(fixture.read_text(encoding="utf-8"))
        raise urllib.error.URLError("fixture not found (offline simulation)")
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        return json.load(response)


def normalize_version(raw: str) -> tuple[int, int, int] | None:
    """Leading (major, minor, patch) of a version, or None when non-numeric.

    A non-string is unorderable rather than an error: registry JSON is untrusted
    input, and every caller already handles None.
    """
    if not isinstance(raw, str):
        return None
    match = _VERSION_HEAD.match(raw.lstrip("v"))
    if not match:
        return None
    return (
        int(match.group(1)),
        int(match.group(2) or 0),
        int(match.group(3) or 0),
    )


def is_prerelease(raw: str) -> bool:
    return isinstance(raw, str) and bool(_PRERELEASE.search(raw))


def classify(installed: str, latest: str) -> str:
    """PATCH-SAFE, MINOR-CHECK, MAJOR-ADVISORY, or CURRENT."""
    cur = normalize_version(installed)
    lat = normalize_version(latest)
    if cur is None or lat is None:
        # Conservative fallback: a version this parser cannot order is never
        # reported as a safe patch.
        return "MINOR-CHECK"
    if cur == lat:
        return "CURRENT"
    if lat[0] > cur[0]:
        return "MAJOR-ADVISORY"
    if lat[0] == cur[0] and lat[1] > cur[1]:
        return "MINOR-CHECK"
    if lat[:2] == cur[:2] and lat[2] > cur[2]:
        return "PATCH-SAFE"
    # Latest is older than installed, e.g. installed is a pre-release ahead of
    # the latest stable.
    return "CURRENT"


def pick_stable(latest: str, installed: str, versions: list[str]) -> str:
    """Latest stable version, unless the installed version is itself a pre-release."""
    if not is_prerelease(latest) or is_prerelease(installed):
        return latest
    # An unorderable candidate is not a fallback: sorting `["", "x", "nan"]` by
    # `normalize_version(v) or (0,0,0)` made them all equal and returned the first,
    # so a registry serving junk keys reported "" as the latest version.
    stable = [
        v
        for v in versions
        if isinstance(v, str) and not is_prerelease(v) and normalize_version(v)
    ]
    if not stable:
        return latest
    stable.sort(key=normalize_version, reverse=True)
    return stable[0]


def query_registry(ecosystem: str, name: str, installed: str) -> dict:
    """One dependency's registry record. Never raises: every failure is a status."""
    result = {"ecosystem": ecosystem, "name": name, "installed": installed}
    try:
        if ecosystem == "pypi":
            data = fetch_json(ecosystem, name, f"https://pypi.org/pypi/{name}/json")
            latest = data["info"]["version"]
            if not isinstance(latest, str) or not latest:
                # A registry serving `"version": null` crashed the whole run: the
                # TypeError surfaced from pick_stable, which runs AFTER this try
                # block, so "never raises: every failure is a status" did not hold
                # for the one field every later step depends on.
                result.update(status="UNRESOLVABLE", reason="no info.version")
                return result
            releases = data.get("releases") or {}
            files = releases.get(latest) or []
            if files and all(f.get("yanked", False) for f in files):
                result.update(
                    status="DISCONFIRMED",
                    latest=latest,
                    reason="all files for latest are yanked on PyPI",
                )
                result["class"] = "DISCONFIRMED"
                return result
            candidates = list(releases)
        elif ecosystem in ("npm", "node"):
            data = fetch_json(ecosystem, name, f"https://registry.npmjs.org/{name}")
            latest = (data.get("dist-tags") or {}).get("latest", "")
            if not isinstance(latest, str) or not latest:
                result.update(status="UNRESOLVABLE", reason="no dist-tags.latest")
                return result
            candidates = list(data.get("versions") or {})
        else:
            result.update(
                status="UNRESOLVABLE",
                reason=(
                    f"registry fetch not implemented for {ecosystem} "
                    "(advisory-only)"
                ),
            )
            return result
    except urllib.error.HTTPError as exc:
        reason = "auth-required" if exc.code in (401, 403) else f"HTTP {exc.code}"
        result.update(status="UNRESOLVABLE", reason=reason)
        return result
    except urllib.error.URLError as exc:
        result.update(status="UNRESOLVABLE", reason=f"network error: {exc.reason}")
        return result
    except Exception as exc:  # noqa: BLE001 - fail open with the reason attached
        result.update(status="UNRESOLVABLE", reason=str(exc))
        return result

    latest = pick_stable(latest, installed, candidates)
    verdict = classify(installed, latest)
    result.update(
        latest=latest,
        status="CURRENT" if verdict == "CURRENT" else "OK",
    )
    result["class"] = verdict
    return result


def read_dependency_lines(target: str) -> list[str]:
    """Dependency lines from stdin, or from the sibling detector."""
    if os.environ.get("RESEARCH_USE_STDIN", "0") == "1":
        return sys.stdin.read().splitlines()
    # The detector ships beside this script in the same skill directory, so it
    # resolves relative to __file__ rather than to any repository layout.
    proc = subprocess.run(
        [sys.executable, str(SCRIPT_DIR / "detect.py"), target],
        capture_output=True,
        text=True,
    )
    return proc.stdout.splitlines()


def main(argv: list[str]) -> int:
    target = argv[1] if len(argv) > 1 else "."
    if not Path(target).is_dir():
        note(f"research.py: '{target}' is not a directory")
        return 2

    note("dep-update/research: querying registries...")
    note()

    tallies = {"OK": 0, "CURRENT": 0, "UNRESOLVABLE": 0, "DISCONFIRMED": 0}
    total = 0
    for line in read_dependency_lines(target):
        fields = line.split("\t")
        if len(fields) < 2 or not fields[0] or not fields[1]:
            continue
        ecosystem, name = fields[0], fields[1]
        installed = fields[2] if len(fields) > 2 else ""
        total += 1
        record = query_registry(ecosystem, name, installed)
        print(json.dumps(record), flush=True)
        # The status is already in hand; the shell predecessor spawned a second
        # python3 per dependency to re-read it out of the JSON it just produced.
        status = record.get("status", "?")
        if status in tallies:
            tallies[status] += 1

    ok = tallies["OK"]
    current = tallies["CURRENT"]
    unresolvable = tallies["UNRESOLVABLE"] + tallies["DISCONFIRMED"]

    note()
    note(f"dep-update/research: {total} dep(s) queried")
    note(f"  classified:    {ok}")
    note(f"  already-current: {current}")
    note(f"  unresolvable:  {unresolvable}")

    if total > 0 and ok == 0 and current == 0 and unresolvable == total:
        note()
        note(
            "WARNING: all registry queries failed - no registry access or all "
            "deps are private."
        )
        note(
            "No upgrade plan can be produced. Check your network connection "
            "and retry."
        )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
