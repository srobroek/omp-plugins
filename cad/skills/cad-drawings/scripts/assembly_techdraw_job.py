"""FreeCAD-side TechDraw job for assembly_drawing.py; freecadcmd runs this file headless.

The CAD_DRAWING_JOB environment variable names a JSON job file (see ``assembly_drawing.techdraw_job``).
The job reads each part definition once (``definitions``: PN -> STEP written by assembly_geometry)
and creates one object per occurrence and scene with that occurrence's placement applied exactly
once; an exploded scene adds its presentation offset to the translation and nothing else.

``mode: measure`` puts every requested view on one large page at scale 1 and reports, per view,
its local bounds and, for every occurrence it must identify, a visible surface point: a sample on
one of the occurrence's own faces that faces the viewer and from which a ray towards the viewer
meets no solid of the view, its own included. The point's local position and the occurrence's
projected extent are reported at scale 1, so the caller can lay sheets out at any scale. It also
measures each operation's acceptance on the assembled scene: the gap along the installation
direction from the installed part's faces that face it to the receiving part (rays from points
inside the receiving part, an interference fit, are skipped), the offset of the nearest receiving
face level with the installed part's trailing end, and the parts' minimum distance.

``mode: draw`` builds one page per sheet at the sheet's size and the planned scales and positions,
and reports each view's ``freecad_views.serialize_view`` geometry and the sheet position of each
anchor point through ``freecad_views.project_anchor``.
"""

import json
import math
import os
import sys
import traceback

import FreeCAD as App
import Part

with open(os.environ["CAD_DRAWING_JOB"], encoding="utf-8") as handle:
    JOB = json.load(handle)
sys.path.insert(0, JOB["scripts"])
import freecad_views  # noqa: E402

SAMPLES = (0.2, 0.5, 0.8)        # face parameter fractions sampled for anchor candidates
MIN_FACING = 0.25                # cosine between a candidate's face normal and the view direction
RAY_START_MM = 0.02              # the ray starts this far off the surface, towards the viewer
CONTACT_MM = 1e-4                # a ray closer than this to a solid meets it
MAX_CANDIDATES = 400


def vector(values):
    return App.Vector(*(float(v) for v in values))


def scenes(doc):
    """{scene: {occurrence id: Part::Feature}} with each occurrence's placement applied once."""
    definitions = {pn: Part.read(path) for pn, path in JOB["definitions"].items()}
    result = {}
    for scene, offsets in JOB["scenes"].items():
        objects = {}
        for occurrence in JOB["occurrences"]:
            offset = offsets.get(occurrence["id"], [0.0, 0.0, 0.0])
            feature = doc.addObject("Part::Feature", f"{scene}_{occurrence['id']}".replace("-", "_"))
            feature.Shape = definitions[occurrence["pn"]]
            translation = [t + o for t, o in zip(occurrence["translation"], offset)]
            feature.Placement = App.Placement(vector(translation), App.Rotation(*occurrence["rotation"]))
            objects[occurrence["id"]] = feature
        result[scene] = objects
    doc.recompute()
    return result


def make_view(doc, page, spec, objects, scale, position, page_height):
    view = doc.addObject("TechDraw::DrawViewPart", "View_" + spec["id"].replace("-", "_"))
    page.addView(view)
    view.Source = [objects[oid] for oid in spec["occurrences"]]
    view.Direction = vector(spec["direction"])
    view.XDirection = vector(spec["x_direction"])
    view.ScaleType = "Custom"
    view.Scale = scale
    view.HardHidden = False
    view.SmoothVisible = False
    view.X, view.Y = position[0], page_height - position[1]
    return view


def new_page(doc, name, template_path):
    page = doc.addObject("TechDraw::DrawPage", name)
    template = doc.addObject("TechDraw::DrawSVGTemplate", name + "_template")
    template.Template = template_path
    page.Template = template
    return page, template.Height.Value


def candidates(shape, direction):
    """(score, point, normal) samples on faces of ``shape`` that face the viewer, best first."""
    found = []
    for face in shape.Faces:
        area = face.Area
        if area <= 0:
            continue
        u0, u1, v0, v1 = face.ParameterRange
        for fu in SAMPLES:
            for fv in SAMPLES:
                u, v = u0 + (u1 - u0) * fu, v0 + (v1 - v0) * fv
                try:
                    point = face.valueAt(u, v)
                    normal = face.normalAt(u, v)
                except Exception:  # noqa: BLE001 - a degenerate sample is skipped
                    continue
                facing = normal.dot(direction)
                if facing < MIN_FACING or not face.isInside(point, 1e-4, True):
                    continue
                centre_bonus = 1.0 if (fu, fv) == (0.5, 0.5) else 0.9
                found.append((facing * math.sqrt(area) * centre_bonus, point, normal))
    found.sort(key=lambda item: -item[0])
    return found[:MAX_CANDIDATES]


def visible(point, direction, length, shapes):
    start = point + direction * RAY_START_MM
    end = point + direction * length
    ray = Part.LineSegment(start, end).toShape()
    for shape in shapes:
        if not shape.BoundBox.intersect(start, direction):
            continue
        if ray.distToShape(shape)[0] < CONTACT_MM:
            return False
    return True


def extent(shape, x_direction, up):
    points = shape.tessellate(0.5)[0] or [v.Point for v in shape.Vertexes]
    xs = [p.dot(x_direction) for p in points]
    ys = [p.dot(up) for p in points]
    return max(max(xs) - min(xs), max(ys) - min(ys))


def first_hit(point, direction, length, host):
    """Distance along ``direction`` from ``point`` to where the ray first meets ``host``; None if never."""
    ray = Part.LineSegment(point, point + direction * length).toShape()
    section = ray.section(host)
    hits = [(v.Point - point).dot(direction) for v in section.Vertexes]
    hits = [t for t in hits if t >= -1e-6]
    return max(0.0, min(hits)) if hits else None


def acceptance(objects, spec):
    part, host = objects[spec["part"]].Shape, objects[spec["into"]].Shape   # Shape carries the Placement
    direction = vector(spec["direction"])
    direction.normalize()
    length = part.BoundBox.DiagonalLength + host.BoundBox.DiagonalLength
    gap = None
    for face in part.Faces:
        u0, u1, v0, v1 = face.ParameterRange
        for fu in SAMPLES:
            for fv in SAMPLES:
                u, v = u0 + (u1 - u0) * fu, v0 + (v1 - v0) * fv
                try:
                    point, normal = face.valueAt(u, v), face.normalAt(u, v)
                except Exception:  # noqa: BLE001 - a degenerate sample is skipped
                    continue
                if normal.dot(direction) < 0.99 or not face.isInside(point, 1e-4, True):
                    continue
                if host.isInside(point, 1e-4, False):
                    continue   # inside the receiving part: an interference band, not a seat
                hit = first_hit(point, direction, length, host)
                if hit is not None and (gap is None or hit < gap):
                    gap = hit
    trailing = min(p.dot(direction) for p in (part.tessellate(0.1)[0] or [v.Point for v in part.Vertexes]))
    flush = None
    for face in host.Faces:
        if face.Surface.TypeId != "Part::GeomPlane":
            continue
        normal = face.normalAt(*face.ParameterRange[::2])
        if abs(normal.dot(direction)) < 0.999 or face.distToShape(part)[0] > 1.0:
            continue
        offset = face.Vertexes[0].Point.dot(direction) - trailing
        if flush is None or abs(offset) < abs(flush):
            flush = offset
    return {"gap": gap, "flush": flush, "contact": part.distToShape(host)[0]}


def measure(doc, objects_by_scene):
    page, height = new_page(doc, "MeasurePage", JOB["measure_template"])
    views = []
    for page_spec in JOB["pages"]:
        for spec in page_spec["views"]:
            objects = objects_by_scene[spec["scene"]]
            views.append((page_spec["sheet"], spec, objects,
                          make_view(doc, page, spec, objects, 1.0, (100.0, 100.0), height)))
    doc.recompute()
    result = []
    for sheet, spec, objects, view in views:
        geometry = freecad_views.serialize_view(view, view_id=spec["id"], role="assembly")
        direction = vector(spec["direction"])
        direction.normalize()
        x_direction = vector(spec["x_direction"])
        x_direction.normalize()
        up = direction.cross(x_direction)
        shapes = {oid: objects[oid].Shape for oid in spec["occurrences"]}
        box = None
        for shape in shapes.values():
            box = shape.BoundBox if box is None else box.united(shape.BoundBox)
        length = box.DiagonalLength + 10.0
        anchors = {}
        for oid in spec["anchors"]:
            for _, point, _ in candidates(shapes[oid], direction):
                if visible(point, direction, length, list(shapes.values())):
                    x, y = freecad_views.project_anchor(view, (point.x, point.y, point.z))
                    anchors[oid] = {"point": [point.x, point.y, point.z],
                                    "local": [x - geometry.centre_mm[0], y - geometry.centre_mm[1]]}
                    break
        result.append({"sheet": sheet, "view": spec["id"], "bounds": list(geometry.bounds), "anchors": anchors,
                       "extents": {oid: extent(shapes[oid], x_direction, up) for oid in spec["anchors"]}})
    measured = {spec["id"]: acceptance(objects_by_scene["assembled"], spec) for spec in JOB.get("acceptance", [])}
    return {"status": "pass", "mode": "measure", "views": result, "acceptance": measured,
            "freecad": list(App.Version()[:4])}


def draw(doc, objects_by_scene):
    result = []
    for page_spec in JOB["pages"]:
        page, height = new_page(doc, f"Sheet{page_spec['sheet']}", page_spec["template"])
        views = [(spec, make_view(doc, page, spec, objects_by_scene[spec["scene"]], spec["scale"], spec["position"],
                                  height)) for spec in page_spec["views"]]
        doc.recompute()
        for spec, view in views:
            geometry = freecad_views.serialize_view(view, view_id=spec["id"], role="assembly")
            anchors = {oid: list(freecad_views.project_anchor(view, point)) for oid, point in spec["anchors"].items()}
            result.append({"sheet": page_spec["sheet"], "view": spec["id"], "geometry": geometry.to_dict(),
                           "anchors": anchors})
    return {"status": "pass", "mode": "draw", "views": result, "freecad": list(App.Version()[:4])}


def main():
    try:
        doc = App.newDocument("assembly_drawing")
        objects = scenes(doc)
        result = measure(doc, objects) if JOB["mode"] == "measure" else draw(doc, objects)
    except Exception as exc:  # noqa: BLE001 - every failure is reported in the result
        result = {"status": "error", "error": str(exc), "traceback": traceback.format_exc()}
    with open(JOB["result"], "w", encoding="utf-8") as handle:
        json.dump(result, handle)


main()
