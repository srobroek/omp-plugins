"""Test fixture: base block, build123d. Uses safe_intersect and safe_cut on a valid path."""

from build123d import Align, Box, Cylinder, Pos

from cadmodel.safe import safe_cut, safe_intersect

KERNEL = "build123d"
PARAMS = {"size": 40.0, "height": 20.0, "bore": 6.0}
LOW = (Align.MIN, Align.MIN, Align.MIN)


def build(params: dict):
    s, h, r = params["size"], params["height"], params["bore"] / 2
    blank = Pos(-s / 2, -s / 2, 0) * Box(s, s, h + 10, align=LOW)
    trim = Pos(-s / 2 - 10, -s / 2 - 10, 0) * Box(s + 20, s + 20, h, align=LOW)
    body = safe_intersect(blank, trim)
    return safe_cut(body, Cylinder(r, h, align=(Align.CENTER, Align.CENTER, Align.MIN)))
