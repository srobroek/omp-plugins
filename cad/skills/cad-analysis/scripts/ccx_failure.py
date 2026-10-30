"""Classify a failed CalculiX ccx run into an actionable no-result error."""

from __future__ import annotations

import re
import signal
from typing import Any

# SPOOLES 2.2's I2Ohash_insert, unpatched in the CalculiX ccx that FreeCAD bundles, multiplies two
# front indices in 32-bit arithmetic: a factorisation with more than 46,340 fronts (46,341**2 >
# 2**31 - 1) indexes outside its hash table and crashes in FrontMtx_postProcess.
SPOOLES_MAX_FRONTS = 46_340
# Every front holds at least one node's three displacement equations.
_MIN_EQUATIONS_PER_FRONT = 3
_CRASH_SIGNALS = {signal.SIGSEGV, signal.SIGBUS, signal.SIGILL, signal.SIGFPE, signal.SIGABRT}
_JACOBIAN_ELEMENT = re.compile(r"nonpositive jacobian determinant in element (\d+)", re.IGNORECASE)


def ccx_failure(returncode: int, stdout: str, *, spooles_started: bool, node_count: int) -> dict[str, Any] | None:
    """Return the no-result error for a finished ccx run, or None when ccx exited cleanly.

    `spooles_started` reports whether ccx created `spooles.out`, which it does on entering the
    SPOOLES factorisation; `node_count` is the mesh node count, three equations per node.
    """
    if returncode == 0:
        return None
    dof = 3 * node_count
    errors = _error_messages(stdout)
    details: dict[str, Any] = {
        "returncode": returncode, "node_count": node_count, "degrees_of_freedom": dof,
        "stage": "spooles_factorisation" if spooles_started else "before_equation_solver", "errors": errors[:20],
    }
    crash = _signal(returncode)
    if crash is not None:
        details["signal"] = crash.name
        return {"code": "solver_crashed", "message": _crash_message(crash, spooles_started, dof), "details": details}
    return {"code": "solver_failed", "message": _stop_message(returncode, errors), "details": details}


def _signal(returncode: int) -> signal.Signals | None:
    """The signal that ended ccx: negative for a direct child, 128+N through a shell wrapper."""
    number = -returncode if returncode < 0 else returncode - 128 if 128 < returncode < 160 else None
    try:
        return signal.Signals(number) if number else None
    except ValueError:
        return None


def _error_messages(stdout: str) -> list[str]:
    """Distinct ccx *ERROR messages, each joined with its continuation lines, in first-seen order."""
    lines = stdout.splitlines()
    messages: list[str] = []
    for index, line in enumerate(lines):
        if "*ERROR" not in line:
            continue
        parts = [line]
        for follow in lines[index + 1:]:
            if not follow.strip() or "*ERROR" in follow or "*WARNING" in follow:
                break
            parts.append(follow)
        message = " ".join(" ".join(parts).split())
        if message not in messages:
            messages.append(message)
    return messages


def _crash_message(crash: signal.Signals, spooles_started: bool, dof: int) -> str:
    if crash == signal.SIGKILL:
        return (f"CalculiX ccx was killed by SIGKILL while solving {dof:,} degrees of freedom, usually by the "
                "operating system reclaiming memory; increase mesh_size to reduce the node count.")
    if crash not in _CRASH_SIGNALS:
        return f"CalculiX ccx was terminated by {crash.name} while solving {dof:,} degrees of freedom."
    if not spooles_started:
        return (f"CalculiX ccx crashed with {crash.name} before reaching the SPOOLES equation solver, while reading "
                f"or assembling {dof:,} degrees of freedom; rerun ccx on GmshMesh.inp in the run directory to "
                "reproduce it.")
    if dof > SPOOLES_MAX_FRONTS * _MIN_EQUATIONS_PER_FRONT:
        return (f"CalculiX ccx crashed with {crash.name} inside the SPOOLES equation solver on {dof:,} degrees of "
                f"freedom: SPOOLES in this ccx build overflows a 32-bit hash index once the factorisation has more "
                f"than {SPOOLES_MAX_FRONTS:,} fronts, which solid tetrahedral meshes reach near 1,000,000 degrees of "
                "freedom. Increase mesh_size to reduce the node count, which falls roughly with its cube.")
    return (f"CalculiX ccx crashed with {crash.name} inside the SPOOLES equation solver on {dof:,} degrees of "
            f"freedom, too few for SPOOLES's {SPOOLES_MAX_FRONTS:,}-front overflow, so the ccx build is suspect; "
            "rerun ccx on GmshMesh.inp in the run directory to reproduce it.")


def _stop_message(returncode: int, errors: list[str]) -> str:
    elements = sorted({int(match) for message in errors for match in _JACOBIAN_ELEMENT.findall(message)})
    if elements:
        shown = ", ".join(str(element) for element in elements[:10]) + (", ..." if len(elements) > 10 else "")
        return (f"CalculiX ccx rejected the mesh: {len(elements)} element(s) have a nonpositive Jacobian "
                f"({shown}). Gmsh produced distorted second-order elements, typically where mesh_size is coarse "
                "for the local wall thickness or curvature; reduce mesh_size.")
    if errors:
        more = f" (+{len(errors) - 3} more)" if len(errors) > 3 else ""
        return f"CalculiX ccx stopped with exit status {returncode}: " + "; ".join(errors[:3]) + more
    return f"CalculiX ccx stopped with exit status {returncode} without an *ERROR message."
