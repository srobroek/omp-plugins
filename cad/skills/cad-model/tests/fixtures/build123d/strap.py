"""Test fixture: a TPU strap, build123d. Installed, it is bent round a quarter arc on the base block's top
face; it is printed flat (build_manufacture). PARAMS["flat"] picks the flat state: `flat` keeps the
developed length (equal volume); `long` is 10 % longer; `split` is two separate pieces; `open` is
the flat blank as an open shell, an invalid B-rep.
"""

import math

from build123d import Plane, Solid
from OCP.BRep import BRep_Builder
from OCP.TopoDS import TopoDS_Shell, TopoDS_Solid

from cadmodel import occ
from cadmodel.safe import safe_cut

KERNEL = "build123d"
PARAMS = {"inner_radius": 8.0, "thickness": 2.0, "width": 10.0, "angle": 90.0, "z0": 20.0, "flat": "flat"}


def build(params: dict):
    r, t, w, z0 = params["inner_radius"], params["thickness"], params["width"], params["z0"]
    plane = Plane.XY.offset(z0)
    outer = Solid.make_cylinder(r + t, w, plane, params["angle"])
    return safe_cut(outer, Solid.make_cylinder(r, w, plane))


def open_shell(box: Solid) -> Solid:
    builder = BRep_Builder()
    shell, solid = TopoDS_Shell(), TopoDS_Solid()
    builder.MakeShell(shell)
    for face in list(box.faces())[:-1]:
        builder.Add(shell, face.wrapped)
    builder.MakeSolid(solid)
    builder.Add(solid, shell)
    return Solid(solid)


def build_manufacture(params: dict):
    """The flat blank: the developed length of the neutral arc, thickness along Y, width along Z."""
    r, t, w, z0 = params["inner_radius"], params["thickness"], params["width"], params["z0"]
    length = math.radians(params["angle"]) * (r + t / 2)
    kind = params["flat"]
    if kind == "long":
        length *= 1.1
    if kind == "split":
        pieces = [Solid.make_box(length / 2, t, w, Plane((x, 0, z0))) for x in (0.0, length / 2 + 1.0)]
        return occ.compound([piece.wrapped for piece in pieces])
    box = Solid.make_box(length, t, w, Plane((0, 0, z0)))
    return open_shell(box) if kind == "open" else box
