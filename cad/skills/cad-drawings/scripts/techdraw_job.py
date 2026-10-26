"""FreeCAD-side TechDraw job for drawing.py; freecadcmd runs this file headless.

The CAD_DRAWING_JOB environment variable names a JSON job file. The job loads the STEP part, builds a
TechDraw page with the regime template and a projection group (Front, Top, Right) in the requested
projection type, and tries the candidate scales in order. TechDraw places the views (AutoDistribute
with spacingX/spacingY); the job keeps the first scale whose view envelope plus the reserved
annotation margins fits the drawing area, centres that envelope in the area, and writes the view
geometry, TechDraw extent measurements and metrics bore matches as JSON for sheet composition.

Coordinates in the result are sheet millimetres with Y pointing down, like the SVG template.
View-local geometry (fragments, boxes, circles) is relative to the view centre and already scaled.
"""

import json
import os
import traceback

import FreeCAD as App
import Part
import TechDraw

VIEW_NAMES = ("Front", "Top", "Right")


def _union(boxes):
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def _local_box(view):
    edges = view.getVisibleEdges()
    if not edges:
        raise RuntimeError(f"empty_drawing: the {view.Type} view has no visible edges")
    return _union([[e.BoundBox.XMin, e.BoundBox.YMin, e.BoundBox.XMax, e.BoundBox.YMax] for e in edges])


def _offset(view):
    """View centre relative to the group anchor in sheet orientation (page Y is up, sheet Y is down)."""
    return view.X.Value, -view.Y.Value


def _envelope(views, margins):
    boxes = []
    for view in views.values():
        dx, dy = _offset(view)
        box = _local_box(view)
        boxes.append([dx + box[0], dy + box[1], dx + box[2], dy + box[3]])
    env = _union(boxes)
    return [env[0] - margins["left"], env[1] - margins["top"], env[2] + margins["right"], env[3] + margins["bottom"]]


def _circles(view):
    found = []
    for edge in view.getVisibleEdges():
        curve = edge.Curve
        if hasattr(curve, "Radius") and edge.isClosed():
            found.append([curve.Center.x, curve.Center.y, curve.Radius])
    return found


def _bore_matches(views, holes):
    """Match each metrics bore to the circle it projects onto in the view looking along its axis."""
    matches = []
    for hole in holes:
        axis = App.Vector(*hole["axis"])
        axis.normalize()
        record = {"id": hole["id"], "diameter_mm": hole["diameter_mm"], "view": None, "matched": False}
        for name, view in views.items():
            direction = App.Vector(view.Direction)
            direction.normalize()
            if abs(axis.dot(direction)) < 0.999:
                continue
            scale = view.getScale()
            centre = view.projectPoint(view.getGeometricCenter())
            point = view.projectPoint(App.Vector(*hole["position"]))
            # projectPoint is unscaled and Y-up; view geometry is scaled, centred and Y-down.
            x, y = (point.x - centre.x) * scale, -(point.y - centre.y) * scale
            radius = hole["diameter_mm"] * scale / 2
            tolerance = max(0.02, 0.02 * radius)
            record.update({"view": name.lower(), "expected": [x, y, radius]})
            for cx, cy, r in _circles(view):
                if abs(cx - x) <= tolerance and abs(cy - y) <= tolerance and abs(r - radius) <= tolerance:
                    record.update({"matched": True, "circle": [cx, cy, r]})
                    break
            break
        matches.append(record)
    return matches


def project(job):
    shape = Part.read(job["step"])
    if shape.isNull() or not shape.Faces:
        raise RuntimeError("STEP has no faces to project")
    doc = App.newDocument("drawing")
    feature = doc.addObject("Part::Feature", "Part")
    feature.Shape = shape
    page = doc.addObject("TechDraw::DrawPage", "Page")
    template = doc.addObject("TechDraw::DrawSVGTemplate", "Template")
    template.Template = job["template"]
    page.Template = template
    sheet_height = template.Height.Value
    group = doc.addObject("TechDraw::DrawProjGroup", "Views")
    page.addView(group)
    group.Source = [feature]
    group.ProjectionType = job["projection_type"]
    group.ScaleType = "Custom"
    group.AutoDistribute = True
    group.spacingX = job["spacing"]
    group.spacingY = job["spacing"]
    for name in VIEW_NAMES:
        group.addProjection(name)
    x0, y0, x1, y1 = job["area"]
    tried = []
    for scale in job["scales"]:
        group.Scale = scale
        doc.recompute()
        views = {view.Type: view for view in group.Views}
        env = _envelope(views, job["margins"])
        tried.append([scale, env[2] - env[0], env[3] - env[1]])
        if env[2] - env[0] <= x1 - x0 and env[3] - env[1] <= y1 - y0:
            break
    else:
        raise RuntimeError(f"no_fit: no candidate scale fits the drawing area {x1 - x0:.1f} x {y1 - y0:.1f} mm: {tried}")
    anchor_x = (x0 + x1) / 2 - (env[0] + env[2]) / 2
    anchor_y = (y0 + y1) / 2 - (env[1] + env[3]) / 2
    group.X = anchor_x
    group.Y = sheet_height - anchor_y
    doc.recompute()
    views = {view.Type: view for view in group.Views}
    front = views["Front"]
    width_dim = TechDraw.makeExtentDim(front, [], 0)
    height_dim = TechDraw.makeExtentDim(front, [], 1)
    doc.recompute()
    result_views = {}
    for name, view in views.items():
        dx, dy = _offset(view)
        result_views[name.lower()] = {
            "center": [anchor_x + dx, anchor_y + dy],
            "box": _local_box(view),
            "svg": TechDraw.viewPartAsSvg(view),
        }
    return {
        "status": "pass",
        "scale": group.Scale,
        "views": result_views,
        "extent_mm": {"width": width_dim.getRawValue(), "height": height_dim.getRawValue()},
        "bores": _bore_matches(views, job["holes"]),
        "face_count": len(shape.Faces),
    }


def main():
    with open(os.environ["CAD_DRAWING_JOB"], encoding="utf-8") as handle:
        job = json.load(handle)
    try:
        result = project(job)
    except Exception as exc:
        result = {"status": "error", "error": str(exc), "traceback": traceback.format_exc()}
    with open(job["result"], "w", encoding="utf-8") as handle:
        json.dump(result, handle)


main()
