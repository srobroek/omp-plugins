"""Test fixture: one safe-edit refusal per PARAMS["case"], build123d.

cut, fuse, intersect: a stand-in kernel Boolean returns a physically impossible result (the
injected fault the safe edits exist to catch). intersect_disjoint, invalid_input: real inputs
the safe edits refuse without any injection.
"""

from build123d import Align, Box, Pos, Solid
from OCP.BRep import BRep_Builder
from OCP.TopoDS import TopoDS_Shell, TopoDS_Solid

from cadmodel import occ
from cadmodel.safe import safe_cut, safe_fuse, safe_intersect

KERNEL = "build123d"
PARAMS = {"case": "cut"}
REAL = occ.boolean
LOW = (Align.MIN, Align.MIN, Align.MIN)


def faulty(operation_used: str, extra=None):
    def boolean(operation, argument, tools, fuzzy=occ.FUZZY_MM):
        return REAL(operation_used, argument, [*tools, *([extra] if extra is not None else [])], fuzzy)
    return boolean


def open_shell(box) -> Solid:
    builder = BRep_Builder()
    shell, solid = TopoDS_Shell(), TopoDS_Solid()
    builder.MakeShell(shell)
    for face in list(box.faces())[:-1]:
        builder.Add(shell, face.wrapped)
    builder.MakeSolid(solid)
    builder.Add(solid, shell)
    return Solid(solid)


def build(params: dict):
    a = Box(10, 10, 10, align=LOW)
    b = Pos(5, 0, 0) * Box(10, 10, 10, align=LOW)
    far = Pos(100, 0, 0) * Box(10, 10, 10, align=LOW)
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
