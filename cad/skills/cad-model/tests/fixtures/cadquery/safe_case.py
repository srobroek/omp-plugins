"""Test fixture: one safe-edit refusal per PARAMS["case"], CadQuery.

cut, fuse, intersect: a stand-in kernel Boolean returns a physically impossible result (the
injected fault the safe edits exist to catch). intersect_disjoint, invalid_input: real inputs
the safe edits refuse without any injection.
"""

import cadquery as cq
from OCP.BRep import BRep_Builder
from OCP.TopoDS import TopoDS_Shell, TopoDS_Solid

from cadmodel import occ
from cadmodel.safe import safe_cut, safe_fuse, safe_intersect

KERNEL = "cadquery"
PARAMS = {"case": "cut"}
REAL = occ.boolean


def faulty(operation_used: str, extra=None):
    def boolean(operation, argument, tools, fuzzy=occ.FUZZY_MM):
        return REAL(operation_used, argument, [*tools, *([extra] if extra is not None else [])], fuzzy)
    return boolean


def open_shell(box: cq.Solid) -> cq.Shape:
    builder = BRep_Builder()
    shell, solid = TopoDS_Shell(), TopoDS_Solid()
    builder.MakeShell(shell)
    for face in box.Faces()[:-1]:
        builder.Add(shell, face.wrapped)
    builder.MakeSolid(solid)
    builder.Add(solid, shell)
    return cq.Shape.cast(solid)


def build(params: dict) -> cq.Shape:
    a = cq.Solid.makeBox(10, 10, 10)
    b = cq.Solid.makeBox(10, 10, 10, cq.Vector(5, 0, 0))
    far = cq.Solid.makeBox(10, 10, 10, cq.Vector(100, 0, 0))
    case = params["case"]
    occ.boolean = {"cut": faulty("fuse"), "fuse": faulty("fuse", far.wrapped), "intersect": faulty("fuse")}.get(case, REAL)
    try:
        if case == "cut":
            return safe_cut(a, b)
        if case == "fuse":
            return safe_fuse(a, b)
        if case == "intersect":
            return safe_intersect(a, b)
        if case == "intersect_disjoint":
            return safe_intersect(a, far)
        return safe_cut(open_shell(a), b)
    finally:
        occ.boolean = REAL
