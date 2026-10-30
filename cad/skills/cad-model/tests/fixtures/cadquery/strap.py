"""Test fixture: a TPU strap, CadQuery. Installed, it is bent round a quarter arc on the base block's top
face; it is printed flat (build_manufacture). PARAMS["flat"] picks the flat state: `flat` keeps the
developed length (equal volume); `long` is 10 % longer; `split` is two separate pieces; `open` is
the flat blank as an open shell, an invalid B-rep.
"""

import math

import cadquery as cq
from OCP.BRep import BRep_Builder
from OCP.TopoDS import TopoDS_Shell, TopoDS_Solid

from cadmodel import occ
from cadmodel.safe import safe_cut

KERNEL = "cadquery"
PARAMS = {"inner_radius": 8.0, "thickness": 2.0, "width": 10.0, "angle": 90.0, "z0": 20.0, "flat": "flat"}


def build(params: dict) -> cq.Shape:
    r, t, w, z0 = params["inner_radius"], params["thickness"], params["width"], params["z0"]
    base, up = cq.Vector(0, 0, z0), cq.Vector(0, 0, 1)
    outer = cq.Solid.makeCylinder(r + t, w, base, up, params["angle"])
    return safe_cut(outer, cq.Solid.makeCylinder(r, w, base, up))


def open_shell(box: cq.Solid) -> cq.Shape:
    builder = BRep_Builder()
    shell, solid = TopoDS_Shell(), TopoDS_Solid()
    builder.MakeShell(shell)
    for face in box.Faces()[:-1]:
        builder.Add(shell, face.wrapped)
    builder.MakeSolid(solid)
    builder.Add(solid, shell)
    return cq.Shape.cast(solid)


def build_manufacture(params: dict):
    """The flat blank: the developed length of the neutral arc, thickness along Y, width along Z."""
    r, t, w, z0 = params["inner_radius"], params["thickness"], params["width"], params["z0"]
    length = math.radians(params["angle"]) * (r + t / 2)
    kind = params["flat"]
    if kind == "long":
        length *= 1.1
    if kind == "split":
        pieces = [cq.Solid.makeBox(length / 2, t, w, cq.Vector(x, 0, z0)) for x in (0.0, length / 2 + 1.0)]
        return occ.compound([piece.wrapped for piece in pieces])
    box = cq.Solid.makeBox(length, t, w, cq.Vector(0, 0, z0))
    return open_shell(box) if kind == "open" else box
