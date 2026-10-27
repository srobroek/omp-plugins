"""Test fixture: base block, CadQuery, with a drawing_features hook built from kernel selectors."""

import cadquery as cq

from cadmodel.safe import safe_cut, safe_intersect

KERNEL = "cadquery"
PARAMS = {"size": 40.0, "height": 20.0, "bore": 6.0}


def build(params: dict) -> cq.Shape:
    s, h, r = params["size"], params["height"], params["bore"] / 2
    blank = cq.Solid.makeBox(s, s, h + 10, cq.Vector(-s / 2, -s / 2, 0))
    trim = cq.Solid.makeBox(s + 20, s + 20, h, cq.Vector(-s / 2 - 10, -s / 2 - 10, 0))
    body = safe_intersect(blank, trim)
    return safe_cut(body, cq.Solid.makeCylinder(r, h, cq.Vector(0, 0, 0)))


def _witness(face: cq.Face, support_type: str) -> dict:
    u0, u1, v0, v1 = face.uvBounds()
    normal, point = face.normalAt((u0 + u1) / 2, (v0 + v1) / 2)
    return {"support_type": support_type, "point_mm": list(point.toTuple()), "normal": list(normal.normalized().toTuple())}


def drawing_features(params: dict, shape: cq.Shape) -> dict:
    found = cq.Workplane().add(shape)
    return {
        "bed_face": {"kind": "plane_face", "frame": "assembly_zero",
                     "patches": [_witness(found.faces("<Z").val(), "plane")]},
        "base_bore": {"kind": "bore", "frame": "assembly_zero",
                      "patches": [_witness(face, "cylinder") for face in found.faces("%CYLINDER").vals()],
                      "relations": {"perpendicular_to": ["bed_face"]}},
    }
