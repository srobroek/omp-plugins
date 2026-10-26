"""Test fixture: swing arm whose solid is an open shell (one face missing), CadQuery. Invalid B-rep."""

import cadquery as cq
from OCP.BRep import BRep_Builder
from OCP.TopoDS import TopoDS_Shell, TopoDS_Solid

KERNEL = "cadquery"
PARAMS = {"length": 60.0, "width": 20.0, "thickness": 5.0, "z0": 20.0}


def build(params: dict) -> cq.Shape:
    w, t, z0 = params["width"], params["thickness"], params["z0"]
    box = cq.Solid.makeBox(params["length"] + w / 2, w, t, cq.Vector(-w / 2, -w / 2, z0))
    builder = BRep_Builder()
    shell, solid = TopoDS_Shell(), TopoDS_Solid()
    builder.MakeShell(shell)
    for face in box.Faces()[:-1]:
        builder.Add(shell, face.wrapped)
    builder.MakeSolid(solid)
    builder.Add(solid, shell)
    return cq.Shape.cast(solid)
