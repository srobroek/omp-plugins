"""OCP measurements and Booleans shared by the kernel runners, safe edits, check, and diff.

Everything takes and returns raw `TopoDS_Shape` values; `to_topods` lowers a CadQuery or build123d
value to one. Only APIs present in both OCP 7.9 (CadQuery 2.8) and OCP 8.0 (build123d 0.13) are used.
"""

from __future__ import annotations

import io
from typing import Any, Iterable

from cadmodel.motion import load_pose

FUZZY_MM = load_pose().FUZZY_MM  # the Boolean fuzzy value of cad-motion's interference rule


class GeometryError(ValueError):
    """An OCP operation failed or produced an unusable shape."""


def to_topods(value: Any) -> Any:
    """The `TopoDS_Shape` behind a raw, CadQuery, or build123d value; `None` when there is none.

    Accepts a raw shape, any kernel object with `.wrapped` (cq.Shape, build123d Shape/Part), a
    cq.Workplane (all stack objects, as one compound when several), or a build123d builder
    (`.part`).
    """
    from OCP.TopoDS import TopoDS_Shape

    if isinstance(value, TopoDS_Shape):
        return value
    wrapped = getattr(value, "wrapped", None)
    if isinstance(wrapped, TopoDS_Shape):
        return wrapped
    vals = getattr(value, "vals", None)
    if callable(vals) and callable(getattr(value, "newObject", None)):
        shapes = [s for s in (to_topods(item) for item in vals()) if s is not None]
        if not shapes:
            return None
        return shapes[0] if len(shapes) == 1 else compound(shapes)
    part = getattr(value, "part", None)
    if part is not None and part is not value:
        return to_topods(part)
    return None


def compound(shapes: Iterable[Any]) -> Any:
    from OCP.BRep import BRep_Builder
    from OCP.TopoDS import TopoDS_Compound

    builder = BRep_Builder()
    result = TopoDS_Compound()
    builder.MakeCompound(result)
    for shape in shapes:
        builder.Add(result, shape)
    return result


def subshapes(shape: Any, kind: str) -> list[Any]:
    """Sub-shape occurrences of `kind` (SOLID, SHELL, FACE, WIRE, EDGE, VERTEX).

    Occurrences, not distinct shapes: OCP 8.0 has no TopTools map classes. Solids, shells, and
    faces occur once each in a manifold part; edges and vertices repeat, so callers only take
    maxima or status sets over them.
    """
    from OCP import TopAbs
    from OCP.TopExp import TopExp_Explorer

    explorer = TopExp_Explorer(shape, getattr(TopAbs, f"TopAbs_{kind}"))
    found = []
    while explorer.More():
        found.append(explorer.Current())
        explorer.Next()
    return found


def count(shape: Any, kind: str) -> int:
    return len(subshapes(shape, kind))


def _volume_props(shape: Any) -> Any:
    return load_pose().volume_properties(shape)  # the one volume rule, shared with cad-motion


def volume(shape: Any) -> float:
    return _volume_props(shape).Mass()


def mass_properties(shape: Any) -> tuple[float, tuple[float, float, float]]:
    """(volume mm^3, centre of volume)."""
    props = _volume_props(shape)
    centre = props.CentreOfMass()
    return props.Mass(), (centre.X(), centre.Y(), centre.Z())


def area(shape: Any) -> float:
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    props = GProp_GProps()
    BRepGProp.SurfaceProperties_s(shape, props)
    return props.Mass()


def bbox(shape: Any) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    """Tight axis-aligned box from the exact geometry, without tolerance enlargement."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib

    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape, box, False, False)
    if box.IsVoid():
        raise GeometryError("shape has no extent")
    low, high = box.CornerMin(), box.CornerMax()  # Get() has no Python binding in OCP 8.0
    return (low.X(), low.Y(), low.Z()), (high.X(), high.Y(), high.Z())


def oriented_bbox(shape: Any) -> tuple[tuple[float, float, float], tuple[tuple[float, float, float], ...]]:
    """The tight OBB's three extents and axis unit vectors in the shape's frame."""
    from OCP.Bnd import Bnd_OBB
    from OCP.BRepBndLib import BRepBndLib

    box = Bnd_OBB()
    BRepBndLib.AddOBB_s(shape, box, True, True, False)
    if box.IsVoid():
        raise GeometryError("shape has no extent")
    vectors = tuple(tuple(float(getattr(direction, axis)()) for axis in ("X", "Y", "Z"))
                    for direction in (box.XDirection(), box.YDirection(), box.ZDirection()))
    return (2.0 * box.XHSize(), 2.0 * box.YHSize(), 2.0 * box.ZHSize()), vectors


def is_valid(shape: Any) -> bool:
    from OCP.BRepCheck import BRepCheck_Analyzer

    return (not shape.IsNull()) and BRepCheck_Analyzer(shape).IsValid()


def check_statuses(shape: Any) -> list[str]:
    """Why BRepCheck rejects `shape`: `invalid <kind> xN` per sub-shape kind, plus shell closure.

    Empty when valid. OCP 8.0 cannot convert BRepCheck_Result.Status() lists, so per-entity
    status names are not read; BRepCheck_Shell.Closed returns one status that both OCPs bind.
    """
    from OCP.BRepCheck import BRepCheck_Analyzer, BRepCheck_NoError, BRepCheck_Shell

    analyzer = BRepCheck_Analyzer(shape)
    if analyzer.IsValid():
        return []
    found = []
    for kind in ("SOLID", "SHELL", "FACE", "WIRE", "EDGE", "VERTEX"):
        bad = sum(1 for sub in subshapes(shape, kind) if not analyzer.IsValid(sub))
        if bad:
            found.append(f"invalid {kind.lower()} x{bad}")
    for shell in subshapes(shape, "SHELL"):
        status = BRepCheck_Shell(downcast(shell, "SHELL")).Closed(False)
        if status != BRepCheck_NoError:
            found.append(getattr(status, "name", str(status)).removeprefix("BRepCheck_"))
    return sorted(set(found)) or ["invalid"]


def downcast(shape: Any, kind: str) -> Any:
    """`shape` as TopoDS_<Kind>: OCP 7.9 spells the cast `TopoDS.Face_s`, OCP 8.0 `TopoDS.Face`."""
    from OCP.TopoDS import TopoDS

    name = kind.capitalize()
    return (getattr(TopoDS, f"{name}_s", None) or getattr(TopoDS, name))(shape)


def max_tolerance(shape: Any) -> float:
    from OCP.BRep import BRep_Tool

    return max((BRep_Tool.Tolerance_s(downcast(sub, kind))
                for kind in ("FACE", "EDGE", "VERTEX") for sub in subshapes(shape, kind)), default=0.0)


def face_areas(shape: Any) -> list[float]:
    return [abs(area(face)) for face in subshapes(shape, "FACE")]


def copy(shape: Any) -> Any:
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Copy

    copied = BRepBuilderAPI_Copy(shape, True, False).Shape()
    if copied.IsNull():
        raise GeometryError("shape copy returned a null shape")
    return copied


def _messages(operation: Any, method: str) -> list[str]:
    stream = io.BytesIO()
    try:
        getattr(operation, method)(stream)
    except Exception:  # noqa: BLE001 - the message dump is diagnostic only
        return []
    return [line.strip() for line in stream.getvalue().decode("utf-8", "replace").splitlines() if line.strip()]


OPERATIONS = ("cut", "fuse", "common")


def boolean(operation: str, argument: Any, tools: Iterable[Any], fuzzy: float = FUZZY_MM) -> Any:
    """Non-destructive BOPAlgo Boolean of copies of the inputs; raises GeometryError on kernel errors."""
    from OCP.BOPAlgo import BOPAlgo_BOP, BOPAlgo_COMMON, BOPAlgo_CUT, BOPAlgo_FUSE

    kinds = {"cut": BOPAlgo_CUT, "fuse": BOPAlgo_FUSE, "common": BOPAlgo_COMMON}
    op = BOPAlgo_BOP()
    shape_list = load_pose().shape_list
    op.SetArguments(shape_list([copy(argument)]))
    op.SetTools(shape_list([copy(tool) for tool in tools]))
    op.SetOperation(kinds[operation])
    op.SetNonDestructive(True)
    op.SetFuzzyValue(fuzzy)
    try:
        op.Perform()
    except Exception as error:  # noqa: BLE001 - OCP raises Standard_Failure subclasses
        raise GeometryError(f"{operation} failed in the kernel: {error}") from error
    if op.HasErrors():
        detail = "; ".join(_messages(op, "DumpErrors")) or "unknown kernel error"
        raise GeometryError(f"{operation} failed in the kernel: {detail}")
    result = op.Shape()
    if result.IsNull():
        raise GeometryError(f"{operation} returned a null shape")
    return result


def occupied(shape: Any, fuzzy: float = FUZZY_MM) -> tuple[Any, float]:
    """(shape, volume) with overlapping solid members counted once.

    A multi-solid shape is partitioned by one General Fuse into non-overlapping cells, so a
    compound whose members overlap does not double-count the space they share.
    """
    from OCP.BOPAlgo import BOPAlgo_CellsBuilder

    solids = subshapes(shape, "SOLID")
    if len(solids) <= 1:
        return shape, volume(shape)
    cells = BOPAlgo_CellsBuilder()
    cells.SetNonDestructive(True)
    cells.SetFuzzyValue(fuzzy)
    for solid in solids:
        cells.AddArgument(copy(solid))
    try:
        cells.Perform()
    except Exception as error:  # noqa: BLE001
        raise GeometryError(f"occupied-volume partition failed: {error}") from error
    if cells.HasErrors():
        raise GeometryError("occupied-volume partition failed: " + ("; ".join(_messages(cells, "DumpErrors")) or "unknown"))
    cells.RemoveAllFromResult()
    cells.AddAllToResult()
    result = cells.Shape()
    if result.IsNull() or not is_valid(result):
        raise GeometryError("occupied-volume partition is not a valid B-rep")
    return result, volume(result)


def volume_slack(*volumes: float) -> float:
    """Kernel noise allowed in a volume bound: 1e-7 relative, at least 1e-6 mm^3."""
    return max(1e-6, max((abs(v) for v in volumes), default=0.0) * 1e-7)

