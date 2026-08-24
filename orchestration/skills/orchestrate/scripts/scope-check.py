#!/usr/bin/env python3
"""orchestrate: scope-glob disjointness check (stdlib-only).

Beads owns deps/status but knows nothing about file scopes. This script is the
scope gate coders/orchestrator run BEFORE `bd update <bead> --claim`: it reads
the candidate bead's `scope` metadata and every in-flight (`in_progress`)
`orc-node` bead's `scope` via `bd`, and reports whether the candidate's globs
are disjoint from everything already being worked on. Disjoint scope is what
lets parallel worktree coders run without merge collisions.

Overlap rule (conservative): two glob sets overlap if any glob's non-wildcard
prefix contains or matches the other's; when the prefixes are equal the globs
themselves are compared, so per-extension splits of one directory stay
concurrent. False positives (serialize work that would have been safe) are
acceptable; false negatives are not.

Usage:
    scope-check.py --candidate <bead-id> [--epic <epic-id>] [--bd <path-to-bd>]

Exit codes: 0 disjoint (safe to claim), 1 conflict (conflicting beads on
stdout), 2 usage/bd error.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import subprocess
import sys


def _die(msg: str, code: int = 2) -> None:
    print(f"scope-check.py: {msg}", file=sys.stderr)
    sys.exit(code)


def _deep_wildcard(glob: str) -> bool:
    """Whether a wildcard sits above the glob's last path segment, which makes
    the segment-wise text comparison in `_scopes_overlap` unsound: `src/a*/f.py`
    and `src/*b/f.py` share `src/ab/f.py` while matching in neither direction.
    Covers `**`, which fnmatch does not treat as spanning separators."""
    return "*" in glob.rsplit("/", 1)[0]


def _scopes_overlap(a: list[str], b: list[str]) -> bool:
    """Two scope-glob sets overlap if any pair of their globs can name a common
    path.

    Neither glob is a concrete path, so a pair sharing a directory is compared
    by fnmatching each against the other as text; a match in one direction is
    enough, since `src/api/*` subsumes `src/api/*.py` but not the reverse. Pairs
    that text comparison cannot settle are reported as overlapping: a false
    positive only serializes work that was safe to parallelize, a false negative
    puts two agents on one file.
    """
    for ga in a:
        pa = ga.split("*", 1)[0].rstrip("/")
        for gb in b:
            pb = gb.split("*", 1)[0].rstrip("/")
            if not pa or not pb:
                return True  # a bare '**' owns everything -> always conflicts
            if pa.startswith(pb + "/") or pb.startswith(pa + "/"):
                return True
            if pa == pb:
                if "*" not in ga or "*" not in gb:
                    return True  # a wildcard-free scope owns that whole path
                if _deep_wildcard(ga) or _deep_wildcard(gb):
                    return True
                if fnmatch.fnmatch(ga, gb) or fnmatch.fnmatch(gb, ga):
                    return True
                continue
            if fnmatch.fnmatch(pa, gb) or fnmatch.fnmatch(pb, ga):
                return True
            # sibling prefixes diverging mid-segment: the wildcard that ended the
            # shorter prefix can still expand across the longer one
            if (pa.startswith(pb) and _deep_wildcard(gb)) or (
                pb.startswith(pa) and _deep_wildcard(ga)
            ):
                return True
    return False


def _bd_json(bd: str, *args: str) -> object:
    proc = subprocess.run(
        [bd, *args, "--json"],
        capture_output=True,
        text=True,
        env={**os.environ, "BD_JSON_ENVELOPE": ""},
    )
    if proc.returncode != 0:
        _die(f"`{bd} {' '.join(args)}` failed: {proc.stderr.strip()}")
    try:
        data = json.loads(proc.stdout)
    except ValueError:
        _die(f"unparsable JSON from `{bd} {' '.join(args)}`")
    # tolerate BD_JSON_ENVELOPE=1 leaking in from the caller's environment
    if isinstance(data, dict) and "data" in data:
        data = data["data"]
    return data


def _scope_of(bead: dict) -> list[str]:
    meta = bead.get("metadata") or {}
    scope = meta.get("scope") or []
    if isinstance(scope, str):  # tolerate a comma-joined string
        scope = [s.strip() for s in scope.split(",") if s.strip()]
    return scope


def check(bd: str, candidate: str, epic: str | None) -> int:
    shown = _bd_json(bd, "show", candidate)
    beads = shown if isinstance(shown, list) else [shown]
    if not beads:
        _die(f"unknown bead {candidate}")
    cand_scope = _scope_of(beads[0])
    if not cand_scope:
        _die(f"bead {candidate} has no scope metadata")

    args = ["list", "--label", "orc-node", "--status", "in_progress"]
    if epic:
        args += ["--parent", epic]
    inflight = _bd_json(bd, *args)

    conflicts = []
    for bead in inflight:
        if bead.get("id") == candidate:
            continue
        other = _scope_of(bead)
        if other and _scopes_overlap(cand_scope, other):
            conflicts.append((bead["id"], other))

    if conflicts:
        for bid, scope in conflicts:
            print(f"conflict: {candidate} {cand_scope} overlaps {bid} {scope}")
        return 1
    print(f"disjoint: {candidate} {cand_scope} vs {len(inflight)} in-flight bead(s)")
    return 0


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="scope-check.py", description=__doc__)
    p.add_argument("--candidate", required=True, help="bead id about to be claimed")
    p.add_argument(
        "--epic", help="restrict the in-flight sweep to one run epic's children"
    )
    p.add_argument("--bd", default="bd", help="bd binary (default: from PATH)")
    args = p.parse_args(argv)
    sys.exit(check(args.bd, args.candidate, args.epic))


if __name__ == "__main__":
    main()
