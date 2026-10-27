"""Test fixture: base block, CadQuery, whose drawing_features hook leaks a kernel object."""

import cadquery as cq

KERNEL = "cadquery"
PARAMS = {"size": 40.0, "height": 20.0}


def build(params: dict) -> cq.Shape:
    s, h = params["size"], params["height"]
    return cq.Solid.makeBox(s, s, h, cq.Vector(-s / 2, -s / 2, 0))


def drawing_features(params: dict, shape: cq.Shape) -> dict:
    return {"top_face": {"kind": "plane_face", "frame": "assembly_zero",
                         "patches": [{"support_type": "plane", "point_mm": shape.Center(), "normal": [0, 0, 1]}]}}
