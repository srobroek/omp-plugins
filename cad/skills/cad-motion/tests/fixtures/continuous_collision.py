# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["cadquery-ocp-novtk==8.0.1.1.0", "pyyaml>=6.0"]
# ///
"""A between-sample collision for cad-motion's continuous check; kernel-free except `main`.

Usage: uv run --script continuous_collision.py OUT_DIR   (writes OUT_DIR/<PN>.step per part)

Two 1 mm cubes over a separate ground plate TST-0401 (z -5..-4: its joint-connected pairs are
excluded, and apart anyway): the obstacle TST-0402, x 9.5..10.5, y and z -0.5..0.5 (centre
(10, 0, 0)), fixed to the plate, and TST-0403, the same cube modelled in place, turning about +Z
through the origin on J-001 over [-10, 10] deg. At either end the turning cube's centre lies
10 sin 10 = 1.736 mm off the obstacle's in y and the cubes are ENDPOINT_DISTANCE_MM (0.660 mm)
apart, above the pair's MINIMUM_MM; at 0 deg they coincide, sharing 1 mm^3. A sweep of the two ends
(`--steps 2 --grid 0`) passes; the between-sample check's first midpoint, 0 deg, finds the
collision.

Both cubes span z -0.5..0.5 and turn about Z, so the pair's distance and overlap are their two
squares' in XY, the overlap times the 1 mm height: `distance_mm`, `overlap_mm3` and `box_gap_mm`
(the gap of the two axis-aligned boxes, a lower bound) compute them in closed form for tests that
need the kernel's answers without the kernel.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

SIDE = 1.0
CENTRE = (10.0, 0.0, 0.0)
SWEEP_DEG = (-10.0, 10.0)
MINIMUM_MM = 0.1
GROUND, OBSTACLE, TURNING = "TST-0401", "TST-0402", "TST-0403"
PARTS = {  # PN -> (title, model frame, box low, box high), every part modelled in place
    GROUND: ("Ground plate", "assembly_zero", (0.0, -5.0, -5.0), (20.0, 5.0, -4.0)),
    OBSTACLE: ("Obstacle cube", "assembly_zero", (9.5, -0.5, -0.5), (10.5, 0.5, 0.5)),
    TURNING: ("Turning cube", "assembly_zero", (9.5, -0.5, -0.5), (10.5, 0.5, 0.5)),
}
Point = tuple[float, float]


def record() -> dict:
    """The assembly.yaml mapping: the turning cube on revolute J-001, nominal at one end, the
    obstacle on fixed J-002, both on the plate."""
    return {
        "subassemblies": [{"id": "continuous", "title": "Between-sample collision", "parts": list(PARTS)}],
        "joints": [
            {"id": "J-001", "type": "revolute", "parent": GROUND, "child": TURNING, "axis": [0, 0, 1],
             "origin": [0, 0, 0], "min": SWEEP_DEG[0], "max": SWEEP_DEG[1], "nominal": SWEEP_DEG[0]},
            {"id": "J-002", "type": "fixed", "parent": GROUND, "child": OBSTACLE, "axis": [0, 0, 1],
             "origin": [0, 0, 0], "min": 0, "max": 0, "nominal": 0},
        ],
    }


def interfaces(minimum: float = MINIMUM_MM) -> dict:
    """The interfaces.yaml mapping: the cubes at least `minimum` mm apart."""
    return {"interfaces": [{"id": "IF-001", "from": OBSTACLE, "to": TURNING, "type": "clearance",
                            "description": "The turning cube clears the obstacle.", "pair": [OBSTACLE, TURNING],
                            "min_clearance_mm": minimum}]}


def squares(angle_deg: float) -> tuple[list[Point], list[Point]]:
    """(the obstacle's square, the turning cube's at `angle_deg`), counter-clockwise, in XY."""
    half = SIDE / 2
    local = [(-half, -half), (half, -half), (half, half), (-half, half)]
    theta = math.radians(angle_deg)
    c, s = math.cos(theta), math.sin(theta)
    ox, oy = CENTRE[0], CENTRE[1]
    tx, ty = c * ox - s * oy, s * ox + c * oy
    obstacle = [(ox + x, oy + y) for x, y in local]
    turning = [(tx + c * x - s * y, ty + s * x + c * y) for x, y in local]
    return obstacle, turning


def overlap_mm3(angle_deg: float) -> float:
    """The cubes' shared volume at `angle_deg`."""
    obstacle, turning = squares(angle_deg)
    return _area(_clip(turning, obstacle)) * SIDE


def distance_mm(angle_deg: float) -> float:
    """The cubes' minimum distance at `angle_deg`: 0 where they meet; else, the squares being convex
    and apart, the least vertex-to-edge distance either way."""
    obstacle, turning = squares(angle_deg)
    if _area(_clip(turning, obstacle)) > 0:
        return 0.0
    return min(_to_segment(p, a, b) for points, other in ((obstacle, turning), (turning, obstacle))
               for p in points for a, b in _edges(other))


def box_gap_mm(angle_deg: float) -> float:
    """The gap between the cubes' axis-aligned boxes at `angle_deg`, a lower bound on their distance."""
    obstacle, turning = squares(angle_deg)
    gaps = []
    for axis in range(2):
        low_a, high_a = min(p[axis] for p in obstacle), max(p[axis] for p in obstacle)
        low_b, high_b = min(p[axis] for p in turning), max(p[axis] for p in turning)
        gaps.append(max(0.0, low_b - high_a, low_a - high_b))
    return math.hypot(*gaps)


def _edges(points: list[Point]) -> list[tuple[Point, Point]]:
    return list(zip(points, points[1:] + points[:1]))


def _to_segment(p: Point, a: Point, b: Point) -> float:
    ax, ay = b[0] - a[0], b[1] - a[1]
    t = max(0.0, min(1.0, ((p[0] - a[0]) * ax + (p[1] - a[1]) * ay) / (ax * ax + ay * ay)))
    return math.hypot(p[0] - a[0] - t * ax, p[1] - a[1] - t * ay)


def _left_of(a: Point, b: Point, p: Point) -> float:
    """Twice the signed area of (a, b, p): positive with p left of a -> b."""
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])


def _crossing(p: Point, q: Point, a: Point, b: Point) -> Point:
    """Where segment p -> q crosses the line a -> b."""
    t = _left_of(a, b, p) / (_left_of(a, b, p) - _left_of(a, b, q))
    return (p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]))


def _clip(subject: list[Point], clip: list[Point]) -> list[Point]:
    """Sutherland-Hodgman: `subject` within the convex counter-clockwise polygon `clip`."""
    output = subject
    for a, b in _edges(clip):
        points, output = output, []
        for p, q in _edges(points) if points else []:
            if _left_of(a, b, q) >= 0:
                if _left_of(a, b, p) < 0:
                    output.append(_crossing(p, q, a, b))
                output.append(q)
            elif _left_of(a, b, p) >= 0:
                output.append(_crossing(p, q, a, b))
    return output


def _area(points: list[Point]) -> float:
    return abs(sum(p[0] * q[1] - q[0] * p[1] for p, q in _edges(points))) / 2 if len(points) > 2 else 0.0


ENDPOINT_DISTANCE_MM = distance_mm(SWEEP_DEG[1])


def main(out: Path) -> int:
    """Write each part's STEP AP242 into `out`, through build_fixtures.py's writer."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import build_fixtures  # noqa: E402 - needs OCP, this script's environment

    shapes = {pn: build_fixtures.box(*low, *high) for pn, (_, _, low, high) in PARTS.items()}
    build_fixtures.write_set(out, shapes, {pn: title for pn, (title, *_) in PARTS.items()})
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    sys.exit(main(Path(sys.argv[1])))
