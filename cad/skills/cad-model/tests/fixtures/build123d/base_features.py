"""Test fixture: base block, build123d, with a drawing_features hook built from kernel selectors."""

from build123d import Align, Axis, Box, Cylinder, GeomType, Pos

from cadmodel.safe import safe_cut, safe_intersect

KERNEL = "build123d"
PARAMS = {"size": 40.0, "height": 20.0, "bore": 6.0}
LOW = (Align.MIN, Align.MIN, Align.MIN)


def build(params: dict):
    s, h, r = params["size"], params["height"], params["bore"] / 2
    blank = Pos(-s / 2, -s / 2, 0) * Box(s, s, h + 10, align=LOW)
    trim = Pos(-s / 2 - 10, -s / 2 - 10, 0) * Box(s + 20, s + 20, h, align=LOW)
    body = safe_intersect(blank, trim)
    return safe_cut(body, Cylinder(r, h, align=(Align.CENTER, Align.CENTER, Align.MIN)))


def _witness(face, support_type: str) -> dict:
    point, normal = face.position_at(0.5, 0.5), face.normal_at(0.5, 0.5).normalized()
    return {"support_type": support_type, "point_mm": [point.X, point.Y, point.Z],
            "normal": [normal.X, normal.Y, normal.Z]}


def drawing_features(params: dict, shape) -> dict:
    return {
        "bed_face": {"kind": "plane_face", "frame": "assembly_zero",
                     "patches": [_witness(shape.faces().sort_by(Axis.Z)[0], "plane")]},
        "base_bore": {"kind": "bore", "frame": "assembly_zero",
                      "patches": [_witness(face, "cylinder") for face in shape.faces().filter_by(GeomType.CYLINDER)],
                      "anchors": {"entry": {"point_mm": [0.0, 0.0, params["height"]], "direction": [0.0, 0.0, -1.0]}}},
    }
