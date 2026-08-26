#!/usr/bin/env python3
"""Failure-path matrix for the third-party catalog validator.

Every case here is a shape a hand-edited `scripts/third-party-plugins.json` could take.
The validator must reject each one loudly. The dangerous case is a PRESENT but malformed
file being read as an empty advertisement list: the build would succeed and quietly
republish the catalog without entries consumers install by name.
"""

from __future__ import annotations

import importlib.util
import json
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

spec = importlib.util.spec_from_file_location("build_catalog", REPO / "scripts" / "build-catalog.py")
build_catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build_catalog)

GOOD_SOURCE = {"source": "github", "repo": "owner/repo", "ref": "main"}
GOOD_ENTRY = {"name": "ok", "description": "d", "version": "0.1.0", "source": GOOD_SOURCE}


def entry(**overrides: object) -> dict[str, object]:
    merged = dict(GOOD_ENTRY)
    merged.update(overrides)
    return merged


MUST_REJECT: list[tuple[str, object]] = [
    ("empty object, no plugins key", {}),
    ("plugins key misspelled", {"plugin": [GOOD_ENTRY]}),
    ("plugins is not a list", {"plugins": {}}),
    ("top level is a list", [GOOD_ENTRY]),
    ("top level is a string", "plugins"),
    ("entry is not an object", {"plugins": ["ok"]}),
    ("missing name", {"plugins": [{k: v for k, v in GOOD_ENTRY.items() if k != "name"}]}),
    ("empty name", {"plugins": [entry(name="")]}),
    ("whitespace name", {"plugins": [entry(name="   ")]}),
    ("non-string name", {"plugins": [entry(name=7)]}),
    ("name carries @", {"plugins": [entry(name="ok@mkt")]}),
    ("name carries a slash", {"plugins": [entry(name="own/ok")]}),
    ("name carries whitespace", {"plugins": [entry(name="not ok")]}),
    ("duplicate names", {"plugins": [GOOD_ENTRY, entry(description="other")]}),
    ("missing description", {"plugins": [{k: v for k, v in GOOD_ENTRY.items() if k != "description"}]}),
    ("missing version", {"plugins": [{k: v for k, v in GOOD_ENTRY.items() if k != "version"}]}),
    ("non-string version", {"plugins": [entry(version=1)]}),
    ("missing source", {"plugins": [{k: v for k, v in GOOD_ENTRY.items() if k != "source"}]}),
    ("source is a string", {"plugins": [entry(source="github")]}),
    ("npm source kind", {"plugins": [entry(source={"source": "npm", "package": "p"})]}),
    ("unknown source kind", {"plugins": [entry(source={"source": "svn", "repo": "r"})]}),
    ("github without repo", {"plugins": [entry(source={"source": "github"})]}),
    ("github repo not a string", {"plugins": [entry(source={"source": "github", "repo": True})]}),
    ("github repo empty", {"plugins": [entry(source={"source": "github", "repo": ""})]}),
    ("git-subdir without path", {"plugins": [entry(source={"source": "git-subdir", "url": "u"})]}),
    ("git-subdir without url", {"plugins": [entry(source={"source": "git-subdir", "path": "p"})]}),
    ("git-subdir path not a string", {"plugins": [entry(source={"source": "git-subdir", "url": "u", "path": 1})]}),
    ("url kind without url", {"plugins": [entry(source={"source": "url"})]}),
    ("not valid json", "{{{"),
]

MUST_ACCEPT: list[tuple[str, object]] = [
    ("empty advertisement list", {"plugins": []}),
    ("one github entry", {"plugins": [GOOD_ENTRY]}),
    ("one git-subdir entry", {"plugins": [entry(source={"source": "git-subdir", "url": "u", "path": "p"})]}),
    ("one url entry", {"plugins": [entry(source={"source": "url", "url": "https://x/y.git"})]}),
    ("comment key alongside plugins", {"$comment": "note", "plugins": [GOOD_ENTRY]}),
]

failures: list[str] = []
original = build_catalog.THIRD_PARTY


def run(payload: object) -> tuple[bool, str]:
    """Point the validator at a temp file holding `payload`; return (raised, message)."""
    with tempfile.TemporaryDirectory() as tmp:
        probe = Path(tmp) / "third-party-plugins.json"
        probe.write_text(payload if isinstance(payload, str) else json.dumps(payload), encoding="utf-8")
        build_catalog.THIRD_PARTY = probe
        try:
            build_catalog.third_party()
            return False, ""
        except SystemExit as err:
            return True, str(err)
        finally:
            build_catalog.THIRD_PARTY = original


for label, payload in MUST_REJECT:
    raised, message = run(payload)
    if raised:
        print(f"OK   rejected: {label}")
    else:
        print(f"FAIL accepted: {label}")
        failures.append(f"accepted {label!r}")

for label, payload in MUST_ACCEPT:
    raised, message = run(payload)
    if raised:
        print(f"FAIL rejected valid: {label} -- {message}")
        failures.append(f"rejected valid {label!r}: {message}")
    else:
        print(f"OK   accepted: {label}")

# The absent-file case must stay permissive, so a fresh checkout still builds.
with tempfile.TemporaryDirectory() as tmp:
    build_catalog.THIRD_PARTY = Path(tmp) / "does-not-exist.json"
    try:
        result = build_catalog.third_party()
        ok = result == []
        print(f"{'OK  ' if ok else 'FAIL'} absent file returns no entries: {result!r}")
        if not ok:
            failures.append("absent file did not return []")
    except SystemExit as err:
        print(f"FAIL absent file raised: {err}")
        failures.append(f"absent file raised: {err}")
    finally:
        build_catalog.THIRD_PARTY = original

print()
if failures:
    for line in failures:
        print(f"FAIL {line}")
    raise SystemExit(1)
print(f"PASS: {len(MUST_REJECT)} rejected, {len(MUST_ACCEPT)} accepted, absent file permissive")
