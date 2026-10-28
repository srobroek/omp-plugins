"""FreeCAD-side job for drawing.py; freecadcmd runs this file headless.

The CAD_DRAWING_JOB environment variable names a JSON job file. Every mode reads one part STEP:

- ``bind``: every face's plain geometry (``feature_geometry.extract_faces``), the faces each
  drawing_features patch binds (``feature_geometry.bind_patches``), and the manufacturing features
  recognised on those faces with a material probe on the solid (``feature_recognition``).
- ``views``: a TechDraw page of the sheet's size with the requested part, section and detail views
  at their scales and sheet positions. Each view is serialised with ``freecad_views.serialize_view``
  together with the affine map from model millimetres to sheet millimetres (``project_anchor`` of
  the origin and the unit axes), so the compositor can place annotations on projected geometry.
  A section view also reports, per face, the points where the cutting plane meets that face, and
  each face of the cut itself (``section_hatch.CutRegion``): its area and its own loops, outer first.

The result is plain JSON; no FreeCAD object leaves this process. Coordinates on the sheet are
millimetres with Y down.
"""

import json
import os
import sys
import traceback

import FreeCAD as App
import Part

with open(os.environ["CAD_DRAWING_JOB"], encoding="utf-8") as handle:
    JOB = json.load(handle)
sys.path.insert(0, JOB["scripts"])
import feature_geometry  # noqa: E402
import feature_recognition  # noqa: E402
import freecad_views  # noqa: E402

CUT_DEFLECTION_MM = 0.01


def _vec(values):
    return App.Vector(*(float(v) for v in values))


def _affine(view):
    """Rows of the affine map model mm -> sheet mm: sheet = [A | b] @ [x, y, z, 1]."""
    origin = freecad_views.project_anchor(view, (0.0, 0.0, 0.0))
    columns = [freecad_views.project_anchor(view, axis) for axis in ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))]
    return [[c[k] - origin[k] for c in columns] + [origin[k]] for k in (0, 1)]


def _points(shape):
    found = []
    for edge in shape.Edges:
        found.extend([[p.x, p.y, p.z] for p in edge.discretize(Deflection=CUT_DEFLECTION_MM)])
    return found


def _loop(wire):
    return [[p.x, p.y, p.z] for p in wire.discretize(Deflection=CUT_DEFLECTION_MM)]


def _cut(shape, section):
    """Per-face cutting-plane intersections, and the faces of the cut with their own loops."""
    origin, normal = _vec(section["origin"]), _vec(section["normal"]).normalize()
    size = shape.BoundBox.DiagonalLength * 2 + 10.0
    plane = Part.makePlane(size, size, origin, normal)
    plane.translate(-(plane.CenterOfMass - origin))
    per_face = {}
    for index, face in enumerate(shape.Faces):
        common = face.section(plane)
        if common.Edges:
            per_face[str(index)] = _points(common)
    # the cut faces themselves, each with its own wires: a slice can double the seam lines of cylinders
    # the plane contains, and one even-odd fill over every face's loops lets overlapping faces cancel
    regions = []
    for cut_face in shape.common(plane).Faces:
        outer = cut_face.OuterWire
        loops = [_loop(outer)] + [_loop(wire) for wire in cut_face.Wires if not wire.isSame(outer)]
        regions.append({"area_mm2": cut_face.Area, "loops": loops})
    return per_face, regions


def bind(job):
    shape = Part.read(job["step"])
    if shape.isNull() or not shape.Faces:
        raise RuntimeError("STEP has no faces")
    faces = feature_geometry.extract_faces(shape)
    recognition = feature_recognition.recognize([feature_geometry.Face.from_dict(f) for f in faces],
                                                feature_recognition.SolidProbe(shape))
    return {"status": "pass", "faces": faces, "bound": feature_geometry.bind_patches(shape, job["locators"]),
            "recognized": recognition.to_dict(), "volume_mm3": shape.Volume}


def views(job):
    shape = Part.read(job["step"])
    doc = App.newDocument("drawing")
    feature = doc.addObject("Part::Feature", "Part")
    feature.Shape = shape
    page = doc.addObject("TechDraw::DrawPage", "Page")
    template = doc.addObject("TechDraw::DrawSVGTemplate", "Template")
    template.Template = job["page_template"]
    page.Template = template
    height = job["sheet_height_mm"]
    created = {}
    for spec in job["views"]:
        name = "V_" + spec["id"].replace("-", "_")
        if spec["kind"] == "section":
            view = doc.addObject("TechDraw::DrawViewSection", name)
            page.addView(view)
            view.BaseView = created[spec["base"]]
            view.SectionNormal = _vec(spec["section"]["normal"])
            view.SectionOrigin = _vec(spec["section"]["origin"])
            view.SectionSymbol = spec.get("label", "")
        elif spec["kind"] == "detail":
            view = doc.addObject("TechDraw::DrawViewDetail", name)
            page.addView(view)
            base = created[spec["base"]]
            view.BaseView = base
            view.AnchorPoint = _vec(spec["detail"]["anchor_view"])
            view.Radius = spec["detail"]["radius_mm"]
            view.Reference = spec.get("label", "")
        else:
            view = doc.addObject("TechDraw::DrawViewPart", name)
            page.addView(view)
        view.Source = [feature]
        view.Direction = _vec(spec["direction"])
        view.XDirection = _vec(spec["x_direction"])
        view.ScaleType = "Custom"
        view.Scale = spec["scale"]
        view.HardHidden = False
        view.X, view.Y = spec["centre_mm"][0], height - spec["centre_mm"][1]
        created[spec["id"]] = view
    doc.recompute()
    result = {"status": "pass", "views": {}}
    for spec in job["views"]:
        view = created[spec["id"]]
        entry = {"geometry": freecad_views.serialize_view(view, view_id=spec["id"], role=spec["role"]).to_dict(),
                 "affine": _affine(view)}
        if spec["kind"] == "section":
            entry["cut_faces"], entry["cut_regions"] = _cut(shape, spec["section"])
        result["views"][spec["id"]] = entry
    return result


def main():
    try:
        result = {"bind": bind, "views": views}[JOB["mode"]](JOB)
    except Exception as exc:  # noqa: BLE001 - every failure is reported in the result
        result = {"status": "error", "error": str(exc), "traceback": traceback.format_exc()}
    with open(JOB["result"], "w", encoding="utf-8") as handle:
        json.dump(result, handle)


main()
