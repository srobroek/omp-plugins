#!/usr/bin/env python3
"""Assert a bd formula pours the DAG it claims, for one selection.

Catches the silent failures: a join that lost its sequencing, a gate that
vanished, an unrecognised gate type that will never close, and a literal
{{brace}} in a field that does not take substitution.

Runs against `bd mol pour --dry-run` and, with --deep, against a real pour in a
throwaway workspace. Never verifies with `bd formula show`, which shows only a
child formula's own steps.

Usage:
  assert-formula.py <formula> [--var k=v ...] [--expect-steps N] [--expect-gates N] [--deep]

Exit 0 if every assertion passes, 1 otherwise. Failures print the assertion and
the observed value.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys

VALID_GATE_TYPES = {"human", "timer", "gh:run", "gh:pr"}
# `bead` is deliberately absent: multi-rig routing was removed, so a bead gate
# can never close. It is a permanent stall, not a usable type.


def run(cmd: list[str], cwd: str | None = None) -> tuple[int, str]:
    p = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def cook_check(formula: str, varargs: list[str]) -> list[str]:
    """Validate with cook, not pour.

    `bd mol pour` reports every formula error as "not found as formula or proto
    ID", naming a file that exists. In a composed set one broken fragment
    poisons every consumer with that message. Cook gives the real error.
    """
    rc, out = run(["bd", "cook", formula, "--dry-run", *varargs])
    if rc != 0:
        return [f"cook failed — the real error:\n{out.strip()}"]
    return []


def parse_dry_run(out: str) -> tuple[list[str], list[str]]:
    """Return (step_lines, gate_titles) from a pour --dry-run listing."""
    steps, gates = [], []
    for line in out.splitlines():
        m = re.match(r"^\s+- (.*?) \(from ([^)]+)\)\s*$", line)
        if not m:
            continue
        title, origin = m.group(1), m.group(2)
        # Gate step ids are prefixed with `gate-`, so checking the origin for
        # `.gate-` misclassifies an ordinary step such as `gate-runner`.
        # Beads gives gate beads the stable `Gate: <type>` title instead.
        if title.startswith("Gate:") and ".gate-" in origin:
            gates.append(title)
        else:
            steps.append(f"{title} <- {origin}")
    return steps, gates


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("formula")
    ap.add_argument("--var", action="append", default=[])
    ap.add_argument("--expect-steps", type=int)
    ap.add_argument("--expect-gates", type=int)
    ap.add_argument("--deep", action="store_true",
                    help="also pour for real and assert every step has a blocks edge")
    ap.add_argument("--workspace", default=None,
                    help="repo to run in; defaults to cwd")
    args = ap.parse_args()

    varargs: list[str] = []
    for v in args.var:
        varargs += ["--var", v]

    failures: list[str] = []

    failures += cook_check(args.formula, varargs)
    if failures:
        for f in failures:
            print(f"FAIL {f}")
        return 1

    rc, out = run(["bd", "mol", "pour", args.formula, "--dry-run", *varargs],
                  cwd=args.workspace)
    if rc != 0:
        print(f"FAIL pour --dry-run failed:\n{out.strip()}")
        return 1

    steps, gates = parse_dry_run(out)
    # The root bead is listed as `(from <formula>)` with no dotted step id; every
    # real step is `(from <formula>.<step-id>)`. Filter on the dot, not the name.
    body = [s for s in steps if "." in s.split(" <- ", 1)[1]]

    print(f"selection: {' '.join(args.var) or '(defaults)'}")
    print(f"  steps poured: {len(body)}   gates: {len(gates)}")

    if args.expect_steps is not None and len(body) != args.expect_steps:
        failures.append(f"step count {len(body)} != expected {args.expect_steps}")
    if args.expect_gates is not None and len(gates) != args.expect_gates:
        failures.append(f"gate count {len(gates)} != expected {args.expect_gates}")

    for g in gates:
        t = g.replace("Gate:", "").strip()
        if t not in VALID_GATE_TYPES:
            failures.append(
                f"gate type {t!r} is not in {sorted(VALID_GATE_TYPES)} — it is accepted at "
                f"cook, poured as an open gate, then SKIPPED by `bd gate check`, so the step "
                f"waits forever")

    # Literal braces anywhere in the listing mean a var was used in a field that
    # does not take substitution (labels, assignee, metadata).
    if "{{" in out:
        for line in out.splitlines():
            if "{{" in line:
                failures.append(f"unsubstituted {{{{var}}}} in pour output: {line.strip()}")

    if args.deep:
        failures += deep_assert(args.formula, varargs, args.workspace)

    for f in failures:
        print(f"FAIL {f}")
    if not failures:
        print("  OK")
    return 1 if failures else 0


def deep_assert(formula: str, varargs: list[str], workspace: str | None) -> list[str]:
    """Pour for real and assert every step with declared needs has a blocks edge.

    This is the anchor-rule check and it cannot be done from --dry-run output:
    a step whose entire `needs` list was filtered keeps a parent-child edge and
    loses its blocks edge, and the dry-run listing shows both identically.
    """
    out_fail: list[str] = []
    rc, out = run(["bd", "mol", "pour", formula, *varargs], cwd=workspace)
    if rc != 0:
        return [f"real pour failed: {out.strip()}"]

    m = re.search(r"Root issue: (\S+)", out)
    if not m:
        return ["could not find the poured root id"]
    root = m.group(1)

    rc, mout = run(["bd", "mol", "show", root, "--json"], cwd=workspace)
    if rc != 0:
        return [f"mol show failed: {mout.strip()}"]

    try:
        mol = json.loads(mout)
    except json.JSONDecodeError:
        return ["mol show did not return JSON"]

    # `bd mol show --json` reports `issues` and `dependencies`; it has no `steps`
    # or `children` key. Reading those meant iterating an empty list, so this
    # check passed unconditionally and reported OK for a formula with a broken
    # DAG. Four separate agents cited a "--deep passed" result that proved
    # worthless. Fail loudly instead of silently when the shape is not what this
    # expects, so the next schema change cannot make the check vacuous again.
    issues = mol.get("issues")
    if not isinstance(issues, list) or not issues:
        return ["mol show returned no `issues` array; cannot verify the anchor rule"]

    # An entry point is an issue nothing else points at. Derive it from the
    # dependency edges the same payload carries rather than shelling out per
    # step: `bd show` output was being scanned for "DEPENDS ON", which cost one
    # subprocess per step and depended on human-readable formatting.
    blocked = {
        edge.get("issue_id")
        for edge in (mol.get("dependencies") or [])
        if edge.get("issue_id")
    }
    titles = {i.get("id"): (i.get("title") or i.get("id")) for i in issues}
    zero_dep = [titles[i] for i in titles if i not in blocked]

    # Exactly one entry point is expected. More than one means a join lost its
    # sequencing and became immediately ready.
    if len(zero_dep) > 1:
        out_fail.append(
            f"{len(zero_dep)} steps have no dependency, so more than one entry point exists — "
            f"a join whose optional predecessors were all filtered lost its sequencing "
            f"(anchor rule): {zero_dep}")
    return out_fail


if __name__ == "__main__":
    sys.exit(main())
