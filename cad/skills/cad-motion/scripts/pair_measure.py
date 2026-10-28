"""Pair measurements for cad-motion `sweep.py` and cad-model `check`.

The one measuring module of both tools. A request asks for the (minimum distance mm, overlap volume
mm^3) of two part definitions: definition `b` placed by `placement` in the frame of definition `a`
(sweep: a at its definition frame) or of `a` placed by `a_placement` (check: both in world
coordinates). Every measurement is pose.py's `interference` rule on the definition shapes moved by
`pose.placed`; nothing is copied, meshed or rebuilt per request. Each measurement is given the gap
between the two placed bounding boxes (`box_gap`), so a pair whose boxes are apart skips the
kernel's containment test, which cannot succeed there.

With `reuse` (sweep), a measurement is reused within the run by the two definitions and the
placement rounded to 1e-6 per matrix entry, so a joint sweep measures only the pairs that joint
moves and two same-PN pairs in one relative placement share one measurement. The reused value
belongs to the first request of the rounded key in request order. A reused distance that lies
within the request's placement bound of one of its clearance `thresholds` is measured again: moving
b from the measured placement to the requested one moves none of its points farther than
|dR|_F r + |dt| (r: the radius of b's bounding box about its origin), so the distance changes by at
most that, and a reused value never carries a verdict across a threshold.

`measure` returns one outcome per request, in request order: `(distance, volume)`, a `Failure`
(the kernel raised; its message), or None when the deadline stopped the run before the request.
Stdlib only; OCP is imported when a shape is touched.
"""

from __future__ import annotations

import importlib.util
import itertools
import math
import sys
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any


def _load(name: str, path: Path) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


pose = sys.modules.get("cad_motion_pose") or _load("cad_motion_pose", Path(__file__).with_name("pose.py"))


@dataclass(frozen=True)
class Request:
    """Definition `b` placed by `placement`, against definition `a` at its definition frame or
    placed by `a_placement`; `thresholds` are the clearance thresholds (mm) the caller compares the
    distance with."""

    a: str
    b: str
    placement: Any
    a_placement: Any = None
    thresholds: tuple[float, ...] = ()


@dataclass(frozen=True)
class Failure:
    """A request the kernel could not measure: the error's message, else its type name."""

    message: str


Outcome = tuple[float, float] | Failure


class PairMeasurer:
    """Measures requests on `shapes` (definition key -> TopoDS_Shape)."""

    def __init__(self, shapes: Mapping[str, Any], reuse: bool = False) -> None:
        self.shapes = dict(shapes)
        self.reuse = reuse
        self.radii = {key: max(math.hypot(*corner) for corner in itertools.product(*zip(*box_corners(shape))))
                      for key, shape in self.shapes.items()} if reuse else {}
        # The corners of each definition's bounding box, enlarged by its shape tolerances: the box
        # holds the shape, so its placed corners' axis-aligned hull holds the placed shape.
        self.corners = {key: list(itertools.product(*zip(*box_corners(shape, tolerance=True))))
                        for key, shape in self.shapes.items()}
        self.measured = 0  # kernel measurements
        self.reused = 0  # requests answered by an earlier measurement
        self.rechecks = 0  # reuse candidates measured again: a threshold lies within their placement bound

    def measure(self, requests: Sequence[Request], deadline: float = math.inf,
                stop_on_failure: bool = False) -> list[Outcome | None]:
        """One outcome per request, in request order; None for the requests the deadline left
        unmeasured, and for those after a failure when `stop_on_failure`."""
        outcomes: list[Outcome | None] = [None] * len(requests)
        reused: dict[tuple[Any, ...], tuple[Any, Outcome]] = {}  # rounded key -> (measured placement, outcome)
        for index, request in enumerate(requests):
            if time.monotonic() > deadline:
                break
            key = None
            if self.reuse and request.a_placement is None:
                key = (request.a, request.b, *(round(v, 6) for row in request.placement.rows(9) for v in row))
                earlier = reused.get(key)
                if earlier is not None:
                    placement, outcome = earlier
                    if self._safe_reuse(request, placement, outcome):
                        self.reused += 1
                        outcomes[index] = outcome
                        continue
                    self.rechecks += 1
            outcome = self._measure_one(request)
            outcomes[index] = outcome
            if isinstance(outcome, Failure):
                if stop_on_failure:
                    break
                continue
            if key is not None:
                reused.setdefault(key, (request.placement, outcome))
        return outcomes

    def _safe_reuse(self, request: Request, placement: Any, outcome: Outcome) -> bool:
        """Whether `outcome`, measured at `placement`, answers `request` on the same side of every
        threshold: no threshold lies within the placement bound of its distance."""
        bound = (math.dist([v for row in placement.rot for v in row], [v for row in request.placement.rot for v in row])
                 * self.radii[request.b] + math.dist(placement.trans, request.placement.trans))
        return not bound or all(abs(outcome[0] - threshold) > bound for threshold in request.thresholds)

    def box_gap(self, request: Request) -> float:
        """The distance between the axis-aligned hulls of the two placed bounding boxes: a lower
        bound on the distance between the placed shapes."""
        low_a, high_a = _hull(self.corners[request.a], request.a_placement)
        low_b, high_b = _hull(self.corners[request.b], request.placement)
        return math.sqrt(sum(max(0.0, low_b[k] - high_a[k], low_a[k] - high_b[k]) ** 2 for k in range(3)))

    def _measure_one(self, request: Request) -> Outcome:
        self.measured += 1
        shape_a = self.shapes[request.a]
        if request.a_placement is not None:
            shape_a = pose.placed(shape_a, request.a_placement)
        try:
            return pose.interference(shape_a, pose.placed(self.shapes[request.b], request.placement),
                                     box_gap=self.box_gap(request))
        except Exception as error:  # noqa: BLE001 - OCP raises Standard_Failure on broken input
            return Failure(str(error) or type(error).__name__)


def _hull(corners: list[tuple[float, float, float]], rigid: Any) -> tuple[list[float], list[float]]:
    """(min, max) of `corners` moved by `rigid` (None: not moved)."""
    moved = corners if rigid is None else [rigid.apply(corner) for corner in corners]
    return [min(p[k] for p in moved) for k in range(3)], [max(p[k] for p in moved) for k in range(3)]


def box_corners(shape: Any, tolerance: bool = False) -> tuple[list[float], list[float]]:
    """(min, max) corners of `shape`'s optimal bounding box from its exact geometry; with `tolerance`
    enlarged by the shape's vertex, edge and face tolerances."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib

    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape, box, False, tolerance)
    low, high = box.CornerMin(), box.CornerMax()
    return [low.X(), low.Y(), low.Z()], [high.X(), high.Y(), high.Z()]
