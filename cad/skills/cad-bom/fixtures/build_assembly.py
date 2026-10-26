# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["cadquery-ocp-novtk==8.0.1.1.0"]
# ///
"""Write the cad-bom test assembly as a STEP AP242 file.

Usage: uv run --script build_assembly.py OUT.step

Product tree (instances per parent):
    ASM-0001 Test assembly
      BASE-0001 Base plate      x1
      PIN-0001 Dowel pin        x2   repeated part: one product, two instances
      SUB-0001 Hinge            x1
        PIN-0001 Dowel pin      x1
        BRK-0002 Bracket        x1
      fasteners                 x1   phantom group: no part number
        SCR-0001 Screw          x2
"""

from __future__ import annotations

import sys

from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.IFSelect import IFSelect_RetDone
from OCP.Interface import Interface_Static
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.STEPControl import STEPControl_AsIs
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDocStd import TDocStd_Document
from OCP.TopLoc import TopLoc_Location
from OCP.XCAFApp import XCAFApp_Application
from OCP.XCAFDoc import XCAFDoc_DocumentTool
from OCP.gp import gp_Trsf, gp_Vec


def main(out: str) -> int:
    doc = TDocStd_Document(TCollection_ExtendedString("MDTV-XCAF"))
    XCAFApp_Application.GetApplication_s().InitDocument(doc)
    tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())

    def named(label, name: str):
        TDataStd_Name.Set_s(label, TCollection_ExtendedString(name))
        return label

    def assembly(name: str):
        return named(tool.NewShape(), name)

    def part(name: str, shape):
        return named(tool.AddShape(shape, False), name)

    def place(parent, child, x: float) -> None:
        moved = gp_Trsf()
        moved.SetTranslation(gp_Vec(x, 0.0, 0.0))
        tool.AddComponent(parent, child, TopLoc_Location(moved))

    base = part("BASE-0001 Base plate", BRepPrimAPI_MakeBox(60.0, 20.0, 5.0).Shape())
    pin = part("PIN-0001 Dowel pin", BRepPrimAPI_MakeCylinder(2.0, 12.0).Shape())
    bracket = part("BRK-0002 Bracket", BRepPrimAPI_MakeBox(10.0, 10.0, 2.0).Shape())
    screw = part("SCR-0001 Screw", BRepPrimAPI_MakeCylinder(1.5, 8.0).Shape())

    hinge = assembly("SUB-0001 Hinge")
    place(hinge, pin, 0.0)
    place(hinge, bracket, 5.0)
    fasteners = assembly("fasteners")
    place(fasteners, screw, 0.0)
    place(fasteners, screw, 8.0)

    top = assembly("ASM-0001 Test assembly")
    place(top, base, 0.0)
    place(top, pin, 10.0)
    place(top, pin, 30.0)
    place(top, hinge, 40.0)
    place(top, fasteners, 50.0)
    tool.UpdateAssemblies()

    writer = STEPCAFControl_Writer()  # registers the STEP statics, so set the schema after it exists
    writer.SetNameMode(True)
    if not Interface_Static.SetCVal_s("write.step.schema", "AP242DIS"):
        print("build_assembly: cannot select the AP242 schema", file=sys.stderr)
        return 2
    if not writer.Transfer(doc, STEPControl_AsIs) or writer.Write(out) != IFSelect_RetDone:
        print(f"build_assembly: cannot write {out}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
