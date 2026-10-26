"""Test fixture: swing arm, CadQuery. Uses safe_fuse and safe_cut on a Workplane."""

import cadquery as cq

from cadmodel.safe import safe_cut, safe_fuse

KERNEL = "cadquery"
PARAMS = {"length": 60.0, "width": 20.0, "thickness": 5.0, "z0": 20.0, "bore": 6.0, "boss": 4.0}


def build(params: dict) -> cq.Workplane:
    w, t, z0 = params["width"], params["thickness"], params["z0"]
    plate = cq.Workplane().add(cq.Solid.makeBox(params["length"] + w / 2, w, t, cq.Vector(-w / 2, -w / 2, z0)))
    boss = cq.Solid.makeCylinder(params["boss"], t, cq.Vector(params["length"] - 10, 0, z0 + t))
    body = safe_fuse(plate, boss)
    return safe_cut(body, cq.Solid.makeCylinder(params["bore"] / 2, t, cq.Vector(0, 0, z0)))
