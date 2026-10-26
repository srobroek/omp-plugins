"""Test fixture: swing arm whose solid is an open shell (one face missing), build123d. Invalid B-rep."""

from build123d import Align, Box, Pos, Solid
from OCP.BRep import BRep_Builder
from OCP.TopoDS import TopoDS_Shell, TopoDS_Solid

KERNEL = "build123d"
PARAMS = {"length": 60.0, "width": 20.0, "thickness": 5.0, "z0": 20.0}


def build(params: dict):
    w, t, z0 = params["width"], params["thickness"], params["z0"]
    box = Pos(-w / 2, -w / 2, z0) * Box(params["length"] + w / 2, w, t, align=(Align.MIN, Align.MIN, Align.MIN))
    builder = BRep_Builder()
    shell, solid = TopoDS_Shell(), TopoDS_Solid()
    builder.MakeShell(shell)
    for face in list(box.faces())[:-1]:
        builder.Add(shell, face.wrapped)
    builder.MakeSolid(solid)
    builder.Add(solid, shell)
    return Solid(solid)
