"""View geometry across the FreeCAD boundary: TechDraw views as plain data for sheet composition.

``serialize_view`` and ``project_anchor`` run inside freecadcmd on a recomputed TechDraw view of a
page that has a template; ``ViewGeometry`` is plain data that ``drawing_document.py`` reads in the
uv environment. Nothing here imports FreeCAD at module level, so both sides import this file, and
no FreeCAD object ever crosses the boundary: a job script writes ``ViewGeometry.to_dict()`` to its
JSON result and the compositor reads it back with ``ViewGeometry.from_dict``.

Coordinates are sheet millimetres with Y pointing down, like the SVG sheet. A view's local
geometry is relative to its centre (the TechDraw view origin), already scaled and rotated; a sheet
point is ``centre_mm + local``. Hidden edges are present only when the job enabled them on the view
(``HardHidden``); visible and hidden edges stay separate layers so each keeps its line type.
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

VIEW_ID = re.compile(r"[a-z][a-z0-9_-]*")
KINDS = {"TechDraw::DrawViewPart": "part", "TechDraw::DrawProjGroupItem": "part",
         "TechDraw::DrawViewSection": "section", "TechDraw::DrawViewDetail": "detail"}
CURVE_DEFLECTION_MM = 0.002   # chord error of a discretised non-circular edge, in sheet millimetres
PLACES = 4                    # decimals of sheet millimetres in path data


@dataclass(frozen=True)
class Circle:
    """A full circle of a view's local geometry, such as a bore seen along its axis."""

    centre: tuple[float, float]
    radius: float
    layer: str  # "visible" or "hidden"


@dataclass(frozen=True)
class ViewGeometry:
    """One projected view: its placement on the sheet, its local edge layers and their bounds."""

    view_id: str
    role: str
    kind: str                                   # "part", "section" or "detail"
    centre_mm: tuple[float, float]              # sheet position of the view origin
    scale: float
    rotation_deg: float
    direction: tuple[float, float, float]       # model-space view direction
    x_direction: tuple[float, float, float]     # model-space direction of the view's +X
    visible: tuple[str, ...]                    # SVG path data, local millimetres
    hidden: tuple[str, ...]
    circles: tuple[Circle, ...]
    bounds: tuple[float, float, float, float]   # local (x0, y0, x1, y1) of both layers

    def sheet_bounds(self) -> tuple[float, float, float, float]:
        cx, cy = self.centre_mm
        x0, y0, x1, y1 = self.bounds
        return (cx + x0, cy + y0, cx + x1, cy + y1)

    def to_dict(self) -> dict[str, Any]:
        return {"view_id": self.view_id, "role": self.role, "kind": self.kind, "centre_mm": list(self.centre_mm),
                "scale": self.scale, "rotation_deg": self.rotation_deg, "direction": list(self.direction),
                "x_direction": list(self.x_direction), "visible": list(self.visible), "hidden": list(self.hidden),
                "circles": [{"centre": list(c.centre), "radius": c.radius, "layer": c.layer} for c in self.circles],
                "bounds": list(self.bounds)}

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> ViewGeometry:
        """Read a ``to_dict`` result back; raise ValueError when it is not one."""
        try:
            geometry = cls(
                view_id=str(data["view_id"]), role=str(data["role"]), kind=str(data["kind"]),
                centre_mm=_floats(data["centre_mm"], 2), scale=float(data["scale"]),
                rotation_deg=float(data["rotation_deg"]), direction=_floats(data["direction"], 3),
                x_direction=_floats(data["x_direction"], 3), visible=tuple(str(p) for p in data["visible"]),
                hidden=tuple(str(p) for p in data["hidden"]),
                circles=tuple(Circle(_floats(c["centre"], 2), float(c["radius"]), str(c["layer"]))
                              for c in data["circles"]),
                bounds=_floats(data["bounds"], 4))
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"not a serialised view: {exc}") from exc
        _check(geometry)
        return geometry


def _floats(values: Iterable[Any], count: int) -> tuple[float, ...]:
    result = tuple(float(v) for v in values)
    if len(result) != count or not all(math.isfinite(v) for v in result):
        raise ValueError(f"expected {count} finite numbers, got {result}")
    return result


def _check(geometry: ViewGeometry) -> None:
    if not VIEW_ID.fullmatch(geometry.view_id):
        raise ValueError(f"view id {geometry.view_id!r} must be lower-case letters, digits, '_' or '-'")
    if not geometry.role:
        raise ValueError(f"view {geometry.view_id} has no role")
    if geometry.kind not in set(KINDS.values()):
        raise ValueError(f"view {geometry.view_id} kind {geometry.kind!r} is not one of {sorted(set(KINDS.values()))}")
    if not math.isfinite(geometry.scale) or geometry.scale <= 0:
        raise ValueError(f"view {geometry.view_id} scale {geometry.scale} is not positive")
    if not geometry.visible:
        raise ValueError(f"empty_drawing: view {geometry.view_id} has no visible edges")
    x0, y0, x1, y1 = geometry.bounds
    if x0 > x1 or y0 > y1:
        raise ValueError(f"view {geometry.view_id} bounds {geometry.bounds} are inverted")
    if any(c.layer not in ("visible", "hidden") or c.radius <= 0 for c in geometry.circles):
        raise ValueError(f"view {geometry.view_id} has an invalid circle")


def _number(value: float) -> str:
    text = f"{value:.{PLACES}f}".rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


def _point(vector: Any) -> str:
    return f"{_number(vector.x)} {_number(vector.y)}"


def _edge_path(edge: Any) -> str:
    """SVG path data for one TechDraw edge: exact lines, circles and arcs, other curves as polylines."""
    curve = edge.Curve
    first, last = edge.FirstParameter, edge.LastParameter
    start, end = edge.valueAt(first), edge.valueAt(last)
    type_id = getattr(curve, "TypeId", "")
    if type_id in ("Part::GeomLine", "Part::GeomLineSegment"):
        return f"M {_point(start)} L {_point(end)}"
    if type_id == "Part::GeomCircle":
        radius = _number(curve.Radius)
        if edge.isClosed():
            centre = curve.Center
            left, right = f"{_number(centre.x - curve.Radius)} {_number(centre.y)}", \
                f"{_number(centre.x + curve.Radius)} {_number(centre.y)}"
            return f"M {right} A {radius} {radius} 0 1 1 {left} A {radius} {radius} 0 1 1 {right} Z"
        middle = edge.valueAt((first + last) / 2)
        turn = (middle.x - start.x) * (end.y - start.y) - (middle.y - start.y) * (end.x - start.x)
        large = 1 if abs(last - first) > math.pi else 0
        return f"M {_point(start)} A {radius} {radius} 0 {large} {1 if turn > 0 else 0} {_point(end)}"
    points = edge.discretize(Deflection=CURVE_DEFLECTION_MM)
    return "M " + " L ".join(_point(p) for p in points)


def _page_position(view: Any) -> tuple[float, float]:
    """The view origin in sheet millimetres, Y down; a projection group item is relative to its group."""
    x, y = view.X.Value, view.Y.Value
    if view.TypeId == "TechDraw::DrawProjGroupItem":
        group = next(parent for parent in view.InList if parent.TypeId == "TechDraw::DrawProjGroup")
        x, y = x + group.X.Value, y + group.Y.Value
    page = view.findParentPage()
    if page is None or page.Template is None:
        raise ValueError(f"view {view.Name} is not on a page with a template; its sheet height is unknown")
    return x, page.Template.Height.Value - y


def serialize_view(view: Any, *, view_id: str, role: str) -> ViewGeometry:
    """Plain geometry of a recomputed TechDraw view (DrawViewPart, projection group item, section, detail)."""
    kind = KINDS.get(view.TypeId)
    if kind is None:
        raise ValueError(f"view {view.Name} is a {view.TypeId}, not a part, section or detail view")
    visible_edges, hidden_edges = view.getVisibleEdges(), view.getHiddenEdges()
    boxes = [edge.BoundBox for edge in (*visible_edges, *hidden_edges)]
    circles = tuple(
        Circle((edge.Curve.Center.x, edge.Curve.Center.y), edge.Curve.Radius, layer)
        for layer, edges in (("visible", visible_edges), ("hidden", hidden_edges)) for edge in edges
        if getattr(edge.Curve, "TypeId", "") == "Part::GeomCircle" and edge.isClosed())
    geometry = ViewGeometry(
        view_id=view_id, role=role, kind=kind, centre_mm=_page_position(view), scale=float(view.getScale()),
        rotation_deg=float(view.Rotation.Value), direction=tuple(view.Direction), x_direction=tuple(view.XDirection),
        visible=tuple(_edge_path(edge) for edge in visible_edges), hidden=tuple(_edge_path(edge) for edge in hidden_edges),
        circles=circles,
        bounds=(min(b.XMin for b in boxes), min(b.YMin for b in boxes), max(b.XMax for b in boxes), max(b.YMax for b in boxes))
        if boxes else (0.0, 0.0, 0.0, 0.0))
    _check(geometry)
    return geometry


def project_anchor(view: Any, point_mm: Sequence[float]) -> tuple[float, float]:
    """Sheet position, in millimetres with Y down, of a model point in a recomputed TechDraw view.

    TechDraw centres a view on its source's geometric centre, scales and rotates it, and draws Y
    up; a detail view is further centred on its anchor in the base view. The point is projected
    along the view direction, so it lands on the view's geometry only when that geometry passes
    through it.
    """
    import FreeCAD as App  # noqa: PLC0415 - FreeCAD exists only inside freecadcmd

    if KINDS.get(view.TypeId) is None:
        raise ValueError(f"view {view.Name} is a {view.TypeId}, not a part, section or detail view")
    if len(point_mm) != 3 or not all(math.isfinite(float(v)) for v in point_mm):
        raise ValueError(f"point {point_mm!r} must be three finite millimetre coordinates")
    centre = view.projectPoint(view.getGeometricCenter())
    projected = view.projectPoint(App.Vector(*(float(v) for v in point_mm)))
    dx, dy = projected.x - centre.x, projected.y - centre.y
    if view.TypeId == "TechDraw::DrawViewDetail":
        dx, dy = dx - view.AnchorPoint.x, dy - view.AnchorPoint.y
    scale = view.getScale()
    angle = math.radians(view.Rotation.Value)
    x = (dx * math.cos(angle) - dy * math.sin(angle)) * scale
    y = (dx * math.sin(angle) + dy * math.cos(angle)) * scale
    cx, cy = _page_position(view)
    return cx + x, cy - y
