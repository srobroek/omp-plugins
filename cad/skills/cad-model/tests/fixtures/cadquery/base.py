"""Test fixture: base block, CadQuery. Uses safe_intersect and safe_cut on a valid path."""

import cadquery as cq

from cadmodel.safe import safe_cut, safe_intersect

KERNEL = "cadquery"
PARAMS = {"size": 40.0, "height": 20.0, "bore": 6.0}


def build(params: dict) -> cq.Shape:
    s, h, r = params["size"], params["height"], params["bore"] / 2
    blank = cq.Solid.makeBox(s, s, h + 10, cq.Vector(-s / 2, -s / 2, 0))
    trim = cq.Solid.makeBox(s + 20, s + 20, h, cq.Vector(-s / 2 - 10, -s / 2 - 10, 0))
    body = safe_intersect(blank, trim)
    return safe_cut(body, cq.Solid.makeCylinder(r, h, cq.Vector(0, 0, 0)))
