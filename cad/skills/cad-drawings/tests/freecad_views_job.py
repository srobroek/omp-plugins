"""FreeCAD-side fixture job for test_drawing_framework.py; freecadcmd runs this file headless.

The job JSON names the scripts directory, a page template SVG and the result path. The job builds a
small plate (60 x 40 x 12 mm, a 8 mm through bore at (15, 20) and a 3 mm through bore at (45, 28)),
puts a front view with hidden lines, a rotated front view, a projection group, a section and a
detail on one page, and writes each view's ``freecad_views.serialize_view`` geometry and the
``project_anchor`` sheet positions of the bore centres and of section witness points.
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
import freecad_views  # noqa: E402

POINTS = {"big_bore_top": (15.0, 20.0, 12.0), "small_bore_top": (45.0, 28.0, 12.0),
          "big_bore_wall_top": (11.0, 20.0, 12.0), "big_bore_wall_bottom": (11.0, 20.0, 0.0),
          "corner": (0.0, 0.0, 12.0)}


def build(doc):
    shape = Part.makeBox(60, 40, 12)
    shape = shape.cut(Part.makeCylinder(4, 12, App.Vector(15, 20, 0)))
    shape = shape.cut(Part.makeCylinder(1.5, 12, App.Vector(45, 28, 0)))
    feature = doc.addObject("Part::Feature", "Plate")
    feature.Shape = shape
    page = doc.addObject("TechDraw::DrawPage", "Page")
    template = doc.addObject("TechDraw::DrawSVGTemplate", "Template")
    template.Template = JOB["template"]
    page.Template = template

    def part_view(name, x, y, scale, rotation=0.0):
        view = doc.addObject("TechDraw::DrawViewPart", name)
        page.addView(view)
        view.Source = [feature]
        view.Direction = App.Vector(0, 0, 1)
        view.XDirection = App.Vector(1, 0, 0)
        view.ScaleType = "Custom"
        view.Scale = scale
        view.Rotation = rotation
        view.HardHidden = True
        view.X, view.Y = x, y
        return view

    front = part_view("Front", 100, 220, 2.0)
    rotated = part_view("Rotated", 330, 220, 1.0, 30.0)
    group = doc.addObject("TechDraw::DrawProjGroup", "Group")
    page.addView(group)
    group.Source = [feature]
    group.ProjectionType = "First angle"
    group.ScaleType = "Custom"
    group.Scale = 1.0
    group.spacingX = group.spacingY = 15.0
    group.X, group.Y = 330, 150
    group.addProjection("Front")
    group.addProjection("Top")
    section = doc.addObject("TechDraw::DrawViewSection", "Section")
    page.addView(section)
    section.BaseView = front
    section.Source = [feature]
    section.SectionNormal = App.Vector(0, -1, 0)
    section.SectionOrigin = App.Vector(15, 20, 6)
    section.Direction = App.Vector(0, -1, 0)
    section.ScaleType = "Custom"
    section.Scale = 2.0
    section.X, section.Y = 100, 110
    detail = doc.addObject("TechDraw::DrawViewDetail", "Detail")
    page.addView(detail)
    detail.BaseView = front
    detail.Source = [feature]
    detail.Direction = front.Direction
    detail.XDirection = front.XDirection
    detail.AnchorPoint = App.Vector(15, 8, 0)   # the small bore in the front view's unscaled, Y-up frame
    detail.Radius = 4
    detail.ScaleType = "Custom"
    detail.Scale = 5.0
    detail.X, detail.Y = 200, 60
    doc.recompute()
    top = next(item for item in group.Views if item.Type == "Top")
    return {"front": front, "rotated": rotated, "group_top": top, "section": section, "detail": detail}


def main():
    try:
        doc = App.newDocument("framework")
        views = build(doc)
        result = {"status": "pass", "views": {}, "anchors": {}}
        for name, view in views.items():
            result["views"][name] = freecad_views.serialize_view(view, view_id=name.replace("_", "-"),
                                                                 role="fixture").to_dict()
            result["anchors"][name] = {key: list(freecad_views.project_anchor(view, point))
                                       for key, point in POINTS.items()}
    except Exception as exc:  # noqa: BLE001 - every failure is reported in the result
        result = {"status": "error", "error": str(exc), "traceback": traceback.format_exc()}
    with open(JOB["result"], "w", encoding="utf-8") as handle:
        json.dump(result, handle)


main()
