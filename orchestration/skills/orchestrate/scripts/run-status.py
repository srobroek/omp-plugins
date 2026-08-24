#!/usr/bin/env python3
"""orchestrate: standardised run status report (stdlib-only).

Every status answer takes the same shape, so a reader compares runs instead of
re-learning a format. Rolls an epic up through its features to their tasks, then
names what is claimable now, what is blocked and by what, and who holds what.

Invoke this when asked for run status; do not hand-assemble a summary from
`bd list`, which loses blockers and the feature rollup.

  scripts/run-status.py                          # live epics, one line per feature
  scripts/run-status.py --epic <id>              # one epic, features + counts
  scripts/run-status.py --epic <id> --full       # ... plus tasks and descriptions
  scripts/run-status.py --feature <id>           # one architect domain in detail
  scripts/run-status.py --actor <name>           # what this actor holds
  scripts/run-status.py --json                   # machine-readable, same data

`bd blocked` supplies blockers directly rather than walking the dependency graph,
because it already resolves which of a bead's dependencies are still open.

Reads only. Never mutates a bead.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from collections import defaultdict
from typing import Any

BD = os.environ.get("BD_BIN", "bd")
# bd calls are read-only here, but an embedded Dolt read can still stall; the
# report is worthless if it hangs a status request.
TIMEOUT = 30

STATUS_MARK = {
    "open": "○",
    "in_progress": "◐",
    "blocked": "◌",
    "closed": "●",
    "deferred": "◇",
}
TYPE_ORDER = {"epic": 0, "feature": 1, "task": 2, "bug": 3, "decision": 4, "chore": 5}


def bd_json(*args: str) -> Any:
    """Run bd with a JSON envelope and return the payload, or None."""
    try:
        proc = subprocess.run(
            [BD, *args, "--json"],
            capture_output=True,
            text=True,
            timeout=TIMEOUT,
            env={
                **os.environ,
                "BD_JSON_ENVELOPE": "1",
                "BD_NO_PAGER": "1",
                "BD_NON_INTERACTIVE": "1",
            },
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0 or not proc.stdout.strip():
        return None
    # bd may print a warning banner before the payload, so slice from the first
    # brace or bracket rather than trusting byte 0.
    text = proc.stdout
    start = min((i for i in (text.find("{"), text.find("[")) if i != -1), default=-1)
    if start < 0:
        return None
    try:
        payload = json.loads(text[start:])
    except json.JSONDecodeError:
        return None
    if isinstance(payload, dict) and "data" in payload:
        payload = payload["data"]
    return payload


def as_list(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [b for b in payload if isinstance(b, dict)]
    if isinstance(payload, dict):
        return [payload]
    return []


def meta(bead: dict[str, Any]) -> dict[str, Any]:
    value = bead.get("metadata")
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def load() -> tuple[list[dict[str, Any]], dict[str, list[str]]]:
    """Every bead plus a blocked-id -> blocker-ids map."""
    beads = as_list(bd_json("list", "--status", "all"))
    blocked: dict[str, list[str]] = {}
    for item in as_list(bd_json("blocked")):
        raw = item.get("blocked_by")
        if isinstance(raw, list):
            ids = [b.get("id") if isinstance(b, dict) else str(b) for b in raw]
        elif isinstance(raw, str):
            ids = [raw]
        else:
            ids = []
        blocked[item["id"]] = [i for i in ids if i]
    return beads, blocked


def children_of(beads: list[dict[str, Any]], parent: str) -> list[dict[str, Any]]:
    kids = [b for b in beads if b.get("parent") == parent]
    kids.sort(key=lambda b: (TYPE_ORDER.get(b.get("issue_type"), 9), b.get("id", "")))
    return kids


def tally(beads: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = defaultdict(int)
    for bead in beads:
        counts[str(bead.get("status"))] += 1
    return dict(counts)


def progress(counts: dict[str, int]) -> str:
    total = sum(counts.values())
    done = counts.get("closed", 0)
    if not total:
        return "no children"
    pct = round(100 * done / total)
    return f"{done}/{total} closed ({pct}%)"


def descendants(beads: list[dict[str, Any]], root: str) -> list[dict[str, Any]]:
    """Every bead under root, at any depth."""
    by_parent: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for bead in beads:
        by_parent[str(bead.get("parent"))].append(bead)
    out: list[dict[str, Any]] = []
    stack = [root]
    while stack:
        for kid in by_parent.get(stack.pop(), []):
            out.append(kid)
            stack.append(kid["id"])
    return out


def wrap(text: str, width: int, indent: str) -> list[str]:
    """Wrap on words without pulling in textwrap's paragraph handling."""
    lines: list[str] = []
    current = ""
    for word in text.split():
        if current and len(current) + 1 + len(word) > width:
            lines.append(indent + current)
            current = word
        else:
            current = f"{current} {word}".strip()
    if current:
        lines.append(indent + current)
    return lines


def first_sentence(text: str, limit: int = 240) -> str:
    flat = " ".join((text or "").split())
    if not flat:
        return ""
    for stop in (". ", " -- "):
        head = flat.split(stop)[0]
        if len(head) < len(flat):
            flat = head + ("." if stop == ". " else "")
            break
    return flat[:limit] + ("…" if len(flat) > limit else "")


def line(bead: dict[str, Any], blocked: dict[str, list[str]], width: int) -> str:
    mark = STATUS_MARK.get(str(bead.get("status")), "?")
    info = meta(bead)
    bits = []
    if info.get("stage"):
        bits.append(f"stage={info['stage']}")
    if bead.get("assignee"):
        bits.append(f"@{bead['assignee']}")
    elif info.get("role"):
        bits.append(f"role={info['role']}")
    # A child inherits its parent's blockers, so naming the parent again on every
    # task is noise. Report only blockers that are not this bead's own ancestry.
    own = [i for i in blocked.get(bead["id"], []) if i != bead.get("parent")]
    if own:
        bits.append("blocked-by " + ",".join(own))
    tail = f"  [{' '.join(bits)}]" if bits else ""
    title = str(bead.get("title") or "")
    room = width - len(tail) - 16
    if room > 10 and len(title) > room:
        title = title[: room - 1] + "…"
    return f"  {mark} {bead['id']:<10} {title}{tail}"


def report(args: argparse.Namespace) -> int:
    beads, blocked = load()
    if not beads:
        print("no beads found (is this a beads workspace?)", file=sys.stderr)
        return 1

    by_id = {b["id"]: b for b in beads}
    width = shutil.get_terminal_size((100, 24)).columns

    if args.actor:
        # assignee is the claim of record, but `bd update --status` does not set it
        # (only `--claim` does), so an actor's worktree binding is a second, often
        # more truthful signal of what it owns.
        held = [
            b
            for b in beads
            if b.get("assignee") == args.actor or meta(b).get("actor") == args.actor
        ]
        available = [
            b
            for b in beads
            if not b.get("assignee")
            and b.get("status") == "open"
            and b["id"] not in blocked
            and meta(b).get("role") == args.actor_role
        ]
        print(f"\nActor: {args.actor}")
        print(f"\nHolds ({len(held)}):")
        for bead in held or []:
            print(line(bead, blocked, width))
        if not held:
            print("  (nothing claimed)")
        if args.actor_role:
            print(f"\nClaimable as role={args.actor_role} ({len(available)}):")
            for bead in available[:20]:
                print(line(bead, blocked, width))
        return 0

    if args.feature:
        roots = [by_id[args.feature]] if args.feature in by_id else []
    elif args.epic:
        roots = [by_id[args.epic]] if args.epic in by_id else []
    else:
        # Default to live work: a fully closed epic is history, and printing it
        # buries the thing a status request is actually asking about.
        roots = [
            b
            for b in beads
            if b.get("issue_type") == "epic"
            and not b.get("parent")
            and (args.all or tally(descendants(beads, b["id"])).get("closed", 0)
                 < sum(tally(descendants(beads, b["id"])).values()))
        ]
        roots.sort(key=lambda b: b.get("id", ""))

    if not roots:
        print("no matching epic or feature", file=sys.stderr)
        return 1

    for root in roots:
        kin = descendants(beads, root["id"])
        counts = tally(kin)
        print(f"\n{'=' * min(width, 78)}")
        print(f"{root.get('issue_type','?').upper()}  {root['id']}  {root.get('title','')}")
        print(f"  {progress(counts)}" + (f"   {counts}" if args.full else ""))
        blocked_kin = [b for b in kin if b["id"] in blocked]
        ready = [
            b
            for b in kin
            if b.get("status") == "open" and b["id"] not in blocked and not b.get("assignee")
        ]
        active = [b for b in kin if b.get("status") == "in_progress"]
        print(f"  ready {len(ready)}   active {len(active)}   blocked {len(blocked_kin)}")

        for child in children_of(beads, root["id"]):
            kid_kin = descendants(beads, child["id"])
            print()
            print(line(child, blocked, width))
            if kid_kin:
                print(f"      {progress(tally(kid_kin))}")
            if args.full and child.get("description"):
                for text in wrap(first_sentence(child["description"]), width - 8, "      "):
                    print(text)
            for grand in children_of(beads, child["id"]):
                print("  " + line(grand, blocked, width))
                if args.full and grand.get("description"):
                    for text in wrap(
                        first_sentence(grand["description"]), width - 10, "        "
                    ):
                        print(text)

        if active:
            print(f"\n  IN PROGRESS ({len(active)}):")
            for bead in active:
                print(line(bead, blocked, width))
        if blocked_kin:
            print(f"\n  BLOCKED ({len(blocked_kin)}):")
            for bead in blocked_kin:
                names = ", ".join(
                    f"{i} ({by_id[i].get('status')})" if i in by_id else i
                    for i in blocked[bead["id"]]
                )
                print(f"  {STATUS_MARK['blocked']} {bead['id']:<10} waits on {names}")
    print()
    return 0


def report_json(args: argparse.Namespace) -> int:
    beads, blocked = load()
    if not beads:
        print("[]")
        return 1
    roots = (
        [b for b in beads if b["id"] in {args.epic, args.feature}]
        if (args.epic or args.feature)
        else [b for b in beads if b.get("issue_type") == "epic" and not b.get("parent")]
    )
    out = []
    for root in roots:
        kin = descendants(beads, root["id"])
        out.append(
            {
                "id": root["id"],
                "type": root.get("issue_type"),
                "title": root.get("title"),
                "counts": tally(kin),
                "ready": [b["id"] for b in kin if b.get("status") == "open" and b["id"] not in blocked],
                "active": [
                    {"id": b["id"], "assignee": b.get("assignee")}
                    for b in kin
                    if b.get("status") == "in_progress"
                ],
                "blocked": {b["id"]: blocked[b["id"]] for b in kin if b["id"] in blocked},
                "children": [
                    {
                        "id": c["id"],
                        "type": c.get("issue_type"),
                        "title": c.get("title"),
                        "metadata": meta(c),
                        "counts": tally(descendants(beads, c["id"])),
                    }
                    for c in children_of(beads, root["id"])
                ],
            }
        )
    print(json.dumps(out, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Standardised beads status report.",
        epilog="Reads only; never mutates a bead.",
    )
    parser.add_argument("--epic", help="report one epic by id")
    parser.add_argument("--feature", help="report one feature (architect domain) by id")
    parser.add_argument("--actor", help="report what this actor holds")
    parser.add_argument("--actor-role", help="with --actor, also list claimable role work")
    parser.add_argument("--full", action="store_true", help="include tasks and descriptions")
    parser.add_argument(
        "--all", action="store_true", help="include fully-closed epics (default hides them)"
    )
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    args = parser.parse_args()

    if shutil.which(BD) is None:
        print(f"{BD} not on PATH", file=sys.stderr)
        return 1
    return report_json(args) if args.json else report(args)


if __name__ == "__main__":
    raise SystemExit(main())
