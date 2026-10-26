"""Test fixture: swing arm, build123d. Uses safe_fuse and safe_cut."""

from build123d import Align, Box, Cylinder, Pos

from cadmodel.safe import safe_cut, safe_fuse

KERNEL = "build123d"
PARAMS = {"length": 60.0, "width": 20.0, "thickness": 5.0, "z0": 20.0, "bore": 6.0, "boss": 4.0}
LOW = (Align.MIN, Align.MIN, Align.MIN)
UP = (Align.CENTER, Align.CENTER, Align.MIN)


def build(params: dict):
    w, t, z0 = params["width"], params["thickness"], params["z0"]
    plate = Pos(-w / 2, -w / 2, z0) * Box(params["length"] + w / 2, w, t, align=LOW)
    boss = Pos(params["length"] - 10, 0, z0 + t) * Cylinder(params["boss"], t, align=UP)
    body = safe_fuse(plate, boss)
    return safe_cut(body, Pos(0, 0, z0) * Cylinder(params["bore"] / 2, t, align=UP))
