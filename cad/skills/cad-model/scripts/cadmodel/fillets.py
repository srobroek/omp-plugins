"""Opt-in per-edge fillet fallback for authored CAD model scripts."""

from __future__ import annotations

import logging
import math
from typing import Any


_LOG = logging.getLogger("cadmodel.fillets")


def _is_not_done(error: BaseException) -> bool:
    """Recognize OCP's StdFail_NotDone without importing OCP for non-kernel callers."""
    if type(error).__name__ == "StdFail_NotDone":
        return True
    try:
        from OCP.StdFail import StdFail_NotDone
    except ImportError:
        return False
    return isinstance(error, StdFail_NotDone)


def fillet_edge(shape: Any, edge: Any, radius: float, *, functional: bool = False,
                retries: int = 2, name: str = "edge") -> Any:
    """Fillet one edge, halving the radius after ``StdFail_NotDone``.

    A non-functional edge is left sharp if every attempt fails; a functional edge
    re-raises the final kernel exception. ``retries`` counts attempts after the
    requested radius, so the default tries radius, radius/2, and radius/4.
    """
    if not math.isfinite(radius) or radius <= 0:
        raise ValueError("fillet radius must be finite and positive")
    if isinstance(retries, bool) or not isinstance(retries, int) or retries < 0:
        raise ValueError("fillet retries must be a non-negative integer")

    last_error: Exception | None = None
    for attempt in range(retries + 1):
        candidate_radius = radius / (2 ** attempt)
        try:
            return shape.fillet(candidate_radius, [edge])
        except Exception as error:
            if not _is_not_done(error):
                raise
            last_error = error

    assert last_error is not None
    if functional:
        raise last_error
    _LOG.warning("skipped non-functional fillet on %s after %d attempts (requested radius %.6g mm)",
                 name, retries + 1, radius)
    return shape
