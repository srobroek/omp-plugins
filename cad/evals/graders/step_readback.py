# /// script
# requires-python = ">=3.11,<3.14"
# dependencies = ["cadquery-ocp-novtk>=8.0.1,<8.1"]
# ///
"""Read a STEP file back through OCCT and report its measurable geometry.

Usage: uv run --script step_readback.py <file.step>

stdout: {"solids": int, "volume_mm3": float, "bbox_mm": [dx, dy, dz],
         "holes": [{"diameter_mm": float, "axis": [dx, dy, dz], "through": [x, y, z]}]}
A hole is one concave cylindrical surface (material outward normal pointing at its
axis), deduplicated by diameter and axis line, so a hole split into two half-faces
counts once. Convex cylinders such as rounded link ends are not holes.

Exit 0 = read; 1 = the file is not a readable STEP solid; 2 = usage or OCCT crash.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    path = Path(argv[1])
    if not path.is_file():
        print(f"no such file: {path}", file=sys.stderr)
        return 1
    shape = _read(path)
    if shape is None:
        return 1
    json.dump(measure(shape), sys.stdout, sort_keys=True)
    sys.stdout.write("\n")
    return 0


def _read(path: Path):
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.STEPControl import STEPControl_Reader

    reader = STEPControl_Reader()
    if reader.ReadFile(str(path)) != IFSelect_RetDone:
        print(f"STEP reader rejected {path}", file=sys.stderr)
        return None
    reader.TransferRoots()
    shape = reader.OneShape()
    if shape is None or shape.IsNull():
        print(f"STEP file {path} transferred no shape", file=sys.stderr)
        return None
    return shape


def measure(shape) -> dict:
    from OCP.BRepBndLib import BRepBndLib
    from OCP.BRepGProp import BRepGProp
    from OCP.Bnd import Bnd_Box
    from OCP.GProp import GProp_GProps
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer

    solids = 0
    explorer = TopExp_Explorer(shape, TopAbs_SOLID)
    while explorer.More():
        solids += 1
        explorer.Next()

    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, props)

    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape, box, False, False)
    if box.IsVoid():
        extents = [0.0, 0.0, 0.0]
    else:
        lo, hi = box.CornerMin(), box.CornerMax()
        extents = [hi.X() - lo.X(), hi.Y() - lo.Y(), hi.Z() - lo.Z()]

    return {
        "solids": solids,
        "volume_mm3": round(abs(props.Mass()), 4),
        "bbox_mm": [round(v, 4) for v in extents],
        "holes": _holes(shape),
    }


def _holes(shape) -> list[dict]:
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepGProp import BRepGProp_Face
    from OCP.GeomAbs import GeomAbs_Cylinder
    from OCP.gp import gp_Pnt, gp_Vec
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    seen: dict[tuple, dict] = {}
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        face = TopoDS.Face(explorer.Current())  # OCP 8 binding; 7.x named it Face_s
        explorer.Next()
        surface = BRepAdaptor_Surface(face)
        if surface.GetType() != GeomAbs_Cylinder:
            continue
        cylinder = surface.Cylinder()
        axis = cylinder.Axis()
        origin, direction = axis.Location(), axis.Direction()
        u = (surface.FirstUParameter() + surface.LastUParameter()) / 2
        v = (surface.FirstVParameter() + surface.LastVParameter()) / 2
        point, normal = gp_Pnt(), gp_Vec()
        BRepGProp_Face(face).Normal(u, v, point, normal)  # material-outward normal
        along = gp_Vec(direction)
        to_axis = gp_Vec(point, origin)
        to_axis = to_axis.Subtracted(along.Multiplied(to_axis.Dot(along)))
        if normal.Dot(to_axis) <= 0:
            continue  # convex: an outer rounded edge, not a hole
        diameter = round(2 * cylinder.Radius(), 3)
        key = (diameter, *_axis_key(origin, direction))
        seen.setdefault(key, {"diameter_mm": diameter, "axis": list(key[1:4]), "through": list(key[4:7])})
    return sorted(seen.values(), key=lambda h: (h["diameter_mm"], h["axis"]))


def _axis_key(origin, direction) -> tuple:
    """Canonical axis line: unit direction with a positive leading component,
    plus the line's closest point to the origin, both rounded."""
    d = [direction.X(), direction.Y(), direction.Z()]
    lead = next(c for c in d if abs(c) > 1e-9)
    if lead < 0:
        d = [-c for c in d]
    p = [origin.X(), origin.Y(), origin.Z()]
    along = sum(pc * dc for pc, dc in zip(p, d, strict=True))
    foot = [pc - along * dc for pc, dc in zip(p, d, strict=True)]
    return tuple(round(c, 3) + 0.0 for c in d) + tuple(round(c, 2) + 0.0 for c in foot)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception as exc:  # an OCCT crash is an infrastructure failure, not a grade
        print(f"step_readback crashed: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(2)
