"""LMP-0005 M5 x 30 shoulder pin: cad-design reference model, CadQuery 2.8, fidelity F3.

Stainless pin made to drawing (DR-003, DR-004) for the base pivot (J-001, axis Z): a
low socket head (dk 8.5, k 3, 3 mm hex socket, 0.4 mm top chamfer), a 5 p6 press band
at its mid-limit that grips the lower-link hub (5 H7/p6), a 5 f7 journal at its
mid-limit that turns in the LMP-0008 bushing, a DIN 471 retaining-ring groove that seats
the LMP-0011 ring under the bushing's lower end, and a 0.4 mm lead chamfer.

Zero pose, assembly coordinates: shank axis on (0, 0, 40) pointing -Z from the head;
the head underside sits 0.3 mm above the lower-link hub: the press band locates the pin.

`drawing_features` names every final face by its role on the pin for the detail drawing.
"""

import math

import cadquery as cq
from cadmodel.safe import safe_cut
from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.GeomAPI import GeomAPI_ProjectPointOnSurf

KERNEL = "cadquery"
PARAMS = {
    "origin": [0.0, 0.0, 40.0],  # J-001 origin
    "axis": [0.0, 0.0, -1.0],  # head -> tip
    "head_offset": -10.3,  # head underside position along `axis` from the origin
    "length": 30.0,
    "press_d": 5.016,  # 5 p6 mid-limit from cad-fits (5.012..5.020)
    "press_len": 20.3,  # head underside to the lower-link hub's lower face
    "shank_d": 4.984,  # 5 f7 mid-limit from cad-fits (4.978..4.990)
    "head_d": 8.5,
    "head_k": 3.0,
    "socket_s": 3.0,
    "socket_depth": 2.0,
    "chamfer": 0.4,
    "groove_from_head": 28.8,  # DIN 471 for d = 5: groove d2 4.8, width m 0.7
    "groove_d": 4.8,
    "groove_w": 0.7,
}


def _plane(p):
    axis = cq.Vector(*p["axis"]).normalized()
    x_dir = cq.Vector(1, 0, 0) if abs(axis.x) < 0.9 else cq.Vector(0, 1, 0)
    x_dir = (x_dir - axis * x_dir.dot(axis)).normalized()
    return cq.Plane(cq.Vector(*p["origin"]) + axis * p["head_offset"], x_dir, axis)


def build(params: dict) -> cq.Shape:
    p = {**PARAMS, **params}
    r, pr, pl, length, c = p["shank_d"] / 2.0, p["press_d"] / 2.0, p["press_len"], p["length"], p["chamfer"]
    hr, k = p["head_d"] / 2.0, p["head_k"]
    g0, gw, gr = p["groove_from_head"], p["groove_w"], p["groove_d"] / 2.0
    # Section in the plane's (radius, axial) coordinates; the head lies at negative axial values.
    section = [
        (0.0, -k), (hr - c, -k), (hr, -k + c), (hr, 0.0), (pr, 0.0), (pr, pl), (r, pl), (r, g0), (gr, g0),
        (gr, g0 + gw), (r, g0 + gw), (r, length - c), (r - c, length), (0.0, length),
    ]
    plane = _plane(p)
    local = cq.Plane((0, 0, 0), (1, 0, 0), (0, -1, 0))
    pin = cq.Workplane(local).polyline(section).close().revolve(360.0, (0, 0, 0), (0, 1, 0))
    socket = cq.Workplane("XY").workplane(offset=-k).polygon(6, p["socket_s"] / math.cos(math.pi / 6)).extrude(p["socket_depth"])
    shape = safe_cut(pin, socket).val()
    return shape.transformShape(plane.rG)


SUPPORT = {"PLANE": "plane", "CYLINDER": "cylinder", "CONE": "cone", "SPHERE": "sphere", "TORUS": "torus",
           "BEZIER": "bezier", "BSPLINE": "bspline", "REVOLUTION": "revolution", "EXTRUSION": "extrusion",
           "OFFSET": "offset"}
KINDS = {"head_top": "plane_face", "head_chamfer": "chamfer", "head": "shaft", "socket": "socket",
         "head_underface": "plane_face", "press_band": "shaft", "press_step": "plane_face", "journal": "shaft",
         "groove": "groove", "tip_chamfer": "chamfer", "tip_face": "plane_face"}


def _witness(face: cq.Face) -> dict:
    """A final-surface witness: the centre of the face's largest mesh triangle, projected onto the face."""
    vertices, triangles = face.tessellate(0.01, 0.2)
    a, b, c = max(((vertices[i], vertices[j], vertices[k]) for i, j, k in triangles),
                  key=lambda t: (t[1] - t[0]).cross(t[2] - t[0]).Length)
    centre = (a + b + c) * (1.0 / 3.0)
    near = GeomAPI_ProjectPointOnSurf(centre.toPnt(), BRep_Tool.Surface_s(face.wrapped)).NearestPoint()
    point = cq.Vector(near.X(), near.Y(), near.Z())
    return {"support_type": SUPPORT.get(face.geomType(), "other"), "point_mm": list(point.toTuple()),
            "normal": list(face.normalAt(point).normalized().toTuple())}


def drawing_features(params: dict, shape: cq.Shape) -> dict:
    """Every final face by its role: head, socket, press band, journal, groove, chamfers and end faces."""
    p = {**PARAMS, **params}
    plane = _plane(p)
    base, axis = plane.origin, plane.zDir
    radii = {"head": p["head_d"] / 2.0, "press_band": p["press_d"] / 2.0, "journal": p["shank_d"] / 2.0,
             "groove": p["groove_d"] / 2.0}
    planes = ((-p["head_k"], "head_top"), (p["socket_depth"] - p["head_k"], "socket"), (0.0, "head_underface"),
              (p["press_len"], "press_step"), (p["groove_from_head"], "groove"),
              (p["groove_from_head"] + p["groove_w"], "groove"), (p["length"], "tip_face"))
    features: dict[str, list] = {}
    for face in shape.Faces():
        patch = _witness(face)
        along = (cq.Vector(*patch["point_mm"]) - base).dot(axis)
        name = None
        if patch["support_type"] == "cylinder":
            radius = BRepAdaptor_Surface(face.wrapped).Cylinder().Radius()
            name = next((n for n, r in radii.items() if abs(radius - r) < 1e-6), None)
        elif patch["support_type"] == "cone":
            name = "head_chamfer" if along < 0 else "tip_chamfer"
        elif patch["support_type"] == "plane" and abs(cq.Vector(*patch["normal"]).dot(axis)) < 1e-6:
            name = "socket"
        elif patch["support_type"] == "plane":
            name = next((n for at, n in planes if abs(along - at) < 1e-6), None)
        if name is not None:
            features.setdefault(name, []).append(patch)
    located = {name: {"kind": KINDS[name], "frame": "assembly_zero", "patches": patches}
               for name, patches in features.items()}
    if "socket" in located and "head_top" in located:
        located["socket"]["relations"] = {"entry": ["head_top"]}
    return located
