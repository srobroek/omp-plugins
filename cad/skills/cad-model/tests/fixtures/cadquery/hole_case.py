"""Test fixture: one hole-recognition case per PARAMS["case"], CadQuery.

Every case is a 40 x 30 x 20 block on x, y, z >= 0. Bores run along z on (20, 15) unless the case
says otherwise. test_holes.py lists each case and the holes it must produce.
"""

import math

import cadquery as cq

from cadmodel.safe import safe_cut, safe_intersect

KERNEL = "cadquery"
PARAMS = {"case": "opposed_blind"}
X, Y = 20.0, 15.0
DRILL_HALF_ANGLE = math.radians(59.0)  # 118 degree drill point


def block() -> cq.Solid:
    return cq.Solid.makeBox(40, 30, 20)


def drill(d: float, z0: float, z1: float) -> cq.Solid:
    return cq.Solid.makeCylinder(d / 2, z1 - z0, cq.Vector(X, Y, z0))


def along_x(d: float, x0: float, x1: float, y: float, z: float) -> cq.Solid:
    return cq.Solid.makeCylinder(d / 2, x1 - x0, cq.Vector(x0, y, z), cq.Vector(1, 0, 0))


def cone(r0: float, r1: float, z0: float, z1: float) -> cq.Solid:
    return cq.Solid.makeCone(r0, r1, z1 - z0, cq.Vector(X, Y, z0))


def lead_in(degrees: float, length: float) -> cq.Shape:
    """A 4 mm through bore whose top `length` mm widens at `degrees` half-angle."""
    z0 = 20 - length
    return safe_cut(block(), drill(4, -1, 21), cone(2, 2 + (21 - z0) * math.tan(math.radians(degrees)), z0, 21))


def round_rim(shape: cq.Shape, z: float, r: float, radius: float) -> cq.Shape:
    """`shape` with every circular edge of radius `r` at height `z` filleted."""
    solid = shape.Solids()[0]
    edges = [e for e in solid.Edges()
             if e.geomType() == "CIRCLE" and abs(e.radius() - r) < 1e-6 and abs(e.startPoint().z - z) < 1e-6]
    return solid.fillet(radius, edges)


def half_bore(d: float, x0: float) -> cq.Shape:
    """The half of a through bore of diameter `d` on x >= x0 within 20 mm, as its own cutting tool."""
    return safe_intersect(drill(d, -1, 21), cq.Solid.makeBox(20, 30, 24, cq.Vector(x0, 0, -2)))


def build(params: dict) -> cq.Shape:
    case = params["case"]
    if case == "opposed_blind":
        return safe_cut(block(), drill(4, -1, 5), drill(4, 15, 21))
    if case == "clevis":
        slot = cq.Solid.makeBox(10, 32, 16, cq.Vector(15, -1, 5))
        return safe_cut(block(), slot, along_x(4, -1, 41, 15, 12))
    if case == "split_channel":
        return safe_cut(safe_cut(block(), along_x(6, -1, 20, 15, 20)), along_x(6, 20, 41, 15, 20))
    if case == "seam_split":
        return safe_cut(safe_cut(block(), half_bore(1.6, 0)), half_bore(1.6, 20))
    if case == "lead_in_15":
        return lead_in(15, 3)
    if case == "lead_in_3":
        return lead_in(3, 2)
    if case == "rounded_mouth":
        return round_rim(safe_cut(block(), drill(4, -1, 21)), 20, 2, 1)
    if case == "drill_point":
        tip = 12 - 2 / math.tan(DRILL_HALF_ANGLE)
        return safe_cut(block(), drill(4, 12, 21), cone(0, 2, tip, 12))
    if case == "ball_end":
        ball = cq.Solid.makeSphere(2, cq.Vector(X, Y, 12), angleDegrees1=-90, angleDegrees2=90)
        return safe_cut(block(), drill(4, 12, 21), ball)
    if case == "corner_radius":
        return round_rim(safe_cut(block(), drill(6, 12, 21)), 12, 3, 1)
    if case == "counterbore":
        return safe_cut(block(), drill(5, -1, 21), drill(9, 17, 21))
    raise ValueError(f"unknown case {case!r}")
