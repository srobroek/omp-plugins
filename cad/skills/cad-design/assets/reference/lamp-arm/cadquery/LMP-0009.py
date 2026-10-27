"""LMP-0009 Bushing SPIROL CMPL 4 X 6 EK CL8100: cad-design reference model, CadQuery 2.8, fidelity F2.

Catalogue headed knurled brass sleeve (a SPIROL compression limiter used as a plain
bearing, DR-004), heat-set into the head knuckle; the LMP-0007 5 f7 journal turns in its
bore and the 1 mm head is the brass thrust face toward the upper link's +Y cheek. Modelled
as its envelope: the knurl at the published nominal 7.97 over the 6 mm body (the pilot
length is not published), the head at the 9.35/9.60 mid-limit, the bore at the 5.05/5.15
mid-limit; OAL 7 (+0/-0.15) at its upper limit so both ends lie flush with the knuckle.

Zero pose, assembly coordinates: on the J-003 axis (360, 0, 40) pointing -Y from the head;
the head underside seats on the knuckle counterbore floor at y 2.5.

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
    "origin": [360.0, 0.0, 40.0],  # J-003 origin
    "axis": [0.0, -1.0, 0.0],  # head -> body end
    "head_offset": -2.5,  # head underside along `axis` from the origin: the counterbore floor
    "length": 6.0,  # body L, +0/-0.15 on OAL = L + T
    "bore_d": 5.10,  # A 5.05/5.15 mid-limit
    "knurl_d": 7.97,  # C nominal; always larger than the 7.81 maximum hole
    "head_d": 9.475,  # H 9.35/9.60 mid-limit
    "head_t": 1.0,  # T ref
}


def _plane(p):
    axis = cq.Vector(*p["axis"]).normalized()
    x_dir = cq.Vector(1, 0, 0) if abs(axis.x) < 0.9 else cq.Vector(0, 1, 0)
    x_dir = (x_dir - axis * x_dir.dot(axis)).normalized()
    return cq.Plane(cq.Vector(*p["origin"]) + axis * p["head_offset"], x_dir, axis)


def build(params: dict) -> cq.Shape:
    p = {**PARAMS, **params}
    ri, rk, length = p["bore_d"] / 2.0, p["knurl_d"] / 2.0, p["length"]
    rh, t = p["head_d"] / 2.0, p["head_t"]
    # Section in the plane's (radius, axial) coordinates; the head lies at negative axial values.
    section = [(ri, -t), (rh, -t), (rh, 0.0), (rk, 0.0), (rk, length), (ri, length)]
    local = cq.Plane((0, 0, 0), (1, 0, 0), (0, -1, 0))
    sleeve = cq.Workplane(local).polyline(section).close().revolve(360.0, (0, 0, 0), (0, 1, 0)).val()
    return sleeve.transformShape(_plane(p).rG)


SUPPORT = {"PLANE": "plane", "CYLINDER": "cylinder", "CONE": "cone", "SPHERE": "sphere", "TORUS": "torus",
           "BEZIER": "bezier", "BSPLINE": "bspline", "REVOLUTION": "revolution", "EXTRUSION": "extrusion",
           "OFFSET": "offset"}
KINDS = {"head_top": "plane_face", "head_underside": "plane_face", "body_end": "plane_face", "head": "shaft",
         "bore": "bore", "knurl": "shaft"}


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
    """Every envelope face by its role: head top and underside, body end, head, bore and knurl."""
    p = {**PARAMS, **params}
    plane = _plane(p)
    radii = {"bore": p["bore_d"] / 2.0, "knurl": p["knurl_d"] / 2.0, "head": p["head_d"] / 2.0}
    ends = ((-p["head_t"], "head_top"), (0.0, "head_underside"), (p["length"], "body_end"))
    return _locate(shape, plane, radii, ends)
