"""LMP-0010 Heat-set insert QT M10x1 x 12.7 OD 12.6: cad-design reference model, CadQuery 2.8, fidelity F2.

Catalogue brass heat-set insert for the lampholder's M10x1 nipple (DR-004): the In-saiL
QT-M10x12.7-OD12.6 envelope with its thread specified M10x1, heat-staked into the head's
socket boss. Modelled as its envelope: the knurl at the published 12.6 over the full 12.7
length (the 11.8 pilot length is not published) and the thread as a plain bore at the
M10x1 basic minor diameter D1 = D - 1.0825 P (ISO 724).

Zero pose, assembly coordinates: on the shade axis (430, 0), installed end flush with the
socket-boss face at z 50 and the blind end 1 mm short of the hole bottom at z 63.7.

`drawing_features` names every envelope face for the vendor specification sheet.
"""

import cadquery as cq
from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.BRepClass import BRepClass_FaceClassifier
from OCP.GeomAPI import GeomAPI_ProjectPointOnSurf
from OCP.ShapeAnalysis import ShapeAnalysis_Surface
from OCP.TopAbs import TopAbs_IN

KERNEL = "cadquery"
PARAMS = {
    "origin": [430.0, 0.0, 50.0],  # shade axis at the socket-boss face
    "axis": [0.0, 0.0, 1.0],  # installed end -> blind end
    "face_offset": 0.0,  # installed end along `axis` from the origin
    "length": 12.7,  # L
    "thread_d": 10.0,  # M10x1
    "thread_pitch": 1.0,
    "knurl_d": 12.6,  # OD
}


def _plane(p):
    axis = cq.Vector(*p["axis"]).normalized()
    x_dir = cq.Vector(1, 0, 0) if abs(axis.x) < 0.9 else cq.Vector(0, 1, 0)
    x_dir = (x_dir - axis * x_dir.dot(axis)).normalized()
    return cq.Plane(cq.Vector(*p["origin"]) + axis * p["face_offset"], x_dir, axis)


def build(params: dict) -> cq.Shape:
    p = {**PARAMS, **params}
    ri = (p["thread_d"] - 1.0825 * p["thread_pitch"]) / 2.0  # ISO 724 basic minor diameter D1
    rk, length = p["knurl_d"] / 2.0, p["length"]
    # Section in the plane's (radius, axial) coordinates, from the installed end.
    section = [(ri, 0.0), (rk, 0.0), (rk, length), (ri, length)]
    local = cq.Plane((0, 0, 0), (1, 0, 0), (0, -1, 0))
    sleeve = cq.Workplane(local).polyline(section).close().revolve(360.0, (0, 0, 0), (0, 1, 0)).val()
    return sleeve.transformShape(_plane(p).rG)


SUPPORT = {"PLANE": "plane", "CYLINDER": "cylinder", "CONE": "cone", "SPHERE": "sphere", "TORUS": "torus",
           "BEZIER": "bezier", "BSPLINE": "bspline", "REVOLUTION": "revolution", "EXTRUSION": "extrusion",
           "OFFSET": "offset"}
KINDS = {"installed_end": "plane_face", "blind_end": "plane_face", "thread_bore": "bore", "knurl": "shaft"}


def _witness(face: cq.Face) -> dict:
    """A final-surface witness: the centre of the largest mesh triangle whose projection lies inside the face.

    A chord triangle across a tight round has its centre inside the tube, where the nearest surface point can lie
    outside the face's trim; the next triangle is tried then.
    """
    vertices, triangles = face.tessellate(0.01, 0.2)
    surface = BRep_Tool.Surface_s(face.wrapped)
    uv = ShapeAnalysis_Surface(surface)

    def area(t):
        return (vertices[t[1]] - vertices[t[0]]).cross(vertices[t[2]] - vertices[t[0]]).Length

    for i, j, k in sorted(triangles, key=area, reverse=True):
        centre = (vertices[i] + vertices[j] + vertices[k]) * (1.0 / 3.0)
        near = GeomAPI_ProjectPointOnSurf(centre.toPnt(), surface).NearestPoint()
        if BRepClass_FaceClassifier(face.wrapped, uv.ValueOfUV(near, 1e-7), 1e-7).State() == TopAbs_IN:
            point = cq.Vector(near.X(), near.Y(), near.Z())
            return {"support_type": SUPPORT.get(face.geomType(), "other"), "point_mm": list(point.toTuple()),
                    "normal": list(face.normalAt(point).normalized().toTuple())}
    raise ValueError(f"no witness point inside a {face.geomType()} face")


def _locate(shape: cq.Shape, plane: cq.Plane, radii: dict, ends: tuple) -> dict:
    """Cylinders by radius and end faces by their distance along the axis from the installed end."""
    features: dict[str, list] = {}
    for face in shape.Faces():
        patch = _witness(face)
        along = (cq.Vector(*patch["point_mm"]) - plane.origin).dot(plane.zDir)
        name = None
        if patch["support_type"] == "cylinder":
            radius = BRepAdaptor_Surface(face.wrapped).Cylinder().Radius()
            name = next((n for n, r in radii.items() if abs(radius - r) < 1e-6), None)
        elif patch["support_type"] == "plane":
            name = next((n for at, n in ends if abs(along - at) < 1e-6), None)
        if name is not None:
            features.setdefault(name, []).append(patch)
    return {name: {"kind": KINDS[name], "frame": "assembly_zero", "patches": patches}
            for name, patches in features.items()}


def drawing_features(params: dict, shape: cq.Shape) -> dict:
    """Every envelope face by its role: installed and blind end faces, the thread bore and the knurl."""
    p = {**PARAMS, **params}
    plane = _plane(p)
    radii = {"thread_bore": (p["thread_d"] - 1.0825 * p["thread_pitch"]) / 2.0, "knurl": p["knurl_d"] / 2.0}
    ends = ((0.0, "installed_end"), (p["length"], "blind_end"))
    return _locate(shape, plane, radii, ends)
