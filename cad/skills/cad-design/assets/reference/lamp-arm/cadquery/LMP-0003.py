"""LMP-0003 Upper link: cad-design reference model, CadQuery 2.8, fidelity F2.

CNC 6061-T6 link between the elbow (J-002) and the head tilt (J-003), both axis Y.
The elbow end is a 10 mm tongue that turns inside the lower link's clevis; the plan
outline flares through 8 mm vertical blends to the 17 mm body and the head clevis.
The side outline sags between the two round ends on runs that leave each round on a
tangent and meet mid-span in a 40 mm blend: a fillet rolled across a kink of a few
degrees leaves edges 0.06 mm out of tolerance. Silhouette edges carry 1.5 mm
fillets; then the head clevis slot, an H8 elbow bore that turns on its pin's journal
and an H7 tip bore that grips its pin's p6 press band, both with 0.5 mm entry
chamfers, a top lightening pocket and a ball-end cable channel underneath.

Zero pose, assembly coordinates: elbow bore on (160, 0, 40), tip bore on (360, 0, 40),
both along Y.

`drawing_features` names every final face by its role for the detail drawing.
"""

import math

import cadquery as cq
from cadmodel.safe import safe_cut, safe_fuse, safe_intersect
from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.BRepClass import BRepClass_FaceClassifier
from OCP.GeomAPI import GeomAPI_ProjectPointOnSurf
from OCP.ShapeAnalysis import ShapeAnalysis_Surface
from OCP.TopAbs import TopAbs_IN

KERNEL = "cadquery"
PARAMS = {
    "elbow_origin": [160.0, 0.0, 40.0],
    "tip_origin": [360.0, 0.0, 40.0],
    "end_r": 10.5,
    "sag_half_h": 8.5,
    "tongue_half_w": 5.0,  # turns inside the 10.4 mm lower-link slot
    "tongue_to_x": 182.0,  # thin out to 22 mm from the elbow axis so the fold clears the clevis
    "body_from_x": 200.0,
    "body_half_w": 8.5,
    "flare_fillet": 8.0,
    "sag_blend": 40.0,  # radius of the blend where the sagging runs meet mid-span
    "edge_fillet": 1.5,
    "elbow_bore_d": 5.009,  # 5 H8 mid-limit from cad-fits (5.000..5.018); turns on pin 5 f7
    "tip_bore_d": 5.006,  # 5 H7 mid-limit from cad-fits (5.000..5.012); pin press band 5 p6
    "bore_chamfer": 0.5,
    "slot_w": 7.4,  # head tongue 7 mm + 0.2 mm side clearance
    "slot_end_x": 334.0,
    "pocket": [212.0, 318.0, 8.0, 44.5],  # x0, x1, width, floor z
    "cable_channel": [210.0, 320.0, 3.0, 34.5],  # x0, x1, ball radius, ball-centre z
}


def _outline(plane, start, segments):
    """Closed wire from ("line", end) and ("arc", mid, end) segments in `plane` coordinates."""
    wire = cq.Workplane(plane).moveTo(*start)
    for segment in segments:
        wire = wire.lineTo(*segment[1]) if segment[0] == "line" else wire.threePointArc(segment[1], segment[2])
    return wire.close()


def _tangent(center, radius, point, side):
    """Where a line from `point` touches the circle; side -1 or +1 picks the lower or upper touch point."""
    dx, dy = point[0] - center[0], point[1] - center[1]
    phi, alpha = math.atan2(dy, dx), math.acos(radius / math.hypot(dx, dy))
    touches = [(center[0] + radius * math.cos(phi + s * alpha), center[1] + radius * math.sin(phi + s * alpha)) for s in (-1, 1)]
    return max(touches, key=lambda q: side * q[1])


def _unit(p, q):
    n = math.hypot(q[0] - p[0], q[1] - p[1])
    return ((q[0] - p[0]) / n, (q[1] - p[1]) / n)


def _rounded(points, radius):
    """Segments along the polyline `points`, from points[0], with a `radius` arc at every inner corner."""
    segments = []
    for a, k, b in zip(points, points[1:], points[2:]):
        u1, u2 = _unit(k, a), _unit(k, b)
        half = math.acos(max(-1.0, min(1.0, u1[0] * u2[0] + u1[1] * u2[1]))) / 2.0
        t, rise = radius / math.tan(half), radius / math.sin(half) - radius
        bisector = _unit((0.0, 0.0), (u1[0] + u2[0], u1[1] + u2[1]))
        segments += [("line", (k[0] + t * u1[0], k[1] + t * u1[1])),
                     ("arc", (k[0] + rise * bisector[0], k[1] + rise * bisector[1]), (k[0] + t * u2[0], k[1] + t * u2[1]))]
    return segments + [("line", points[-1])]


def _is_line_along(edge, axis):
    if edge.geomType() != "LINE":
        return False
    d = (edge.endPoint() - edge.startPoint()).normalized()
    return abs(abs(d.dot(cq.Vector(*axis))) - 1.0) < 1e-6


def _circle_edges(shape, radius, axes):
    """Circular edges of `radius` centred on one of the (point, direction) axes."""
    found = []
    for edge in shape.Edges():
        if edge.geomType() == "CIRCLE" and abs(edge.radius() - radius) < 1e-6:
            center = edge.arcCenter()
            for point, direction in axes:
                offset = center - cq.Vector(*point)
                d = cq.Vector(*direction)
                if (offset - d * offset.dot(d)).Length < 1e-3:
                    found.append(edge)
                    break
    return found


def _stadium(x0, x1, width, z0, z1):
    return cq.Workplane("XY").workplane(offset=z0).center((x0 + x1) / 2.0, 0).slot2D(x1 - x0, width).extrude(z1 - z0)


def _ball_channel(x0, x1, r, zc, z_open):
    """Stopped channel cut from below by a ball-end mill of radius r travelling x0 -> x1 at height zc."""
    channel = cq.Workplane("YZ").workplane(offset=x0).center(0, zc).circle(r).extrude(x1 - x0)
    channel = safe_fuse(channel, cq.Workplane("XY").box(x1 - x0, 2 * r, zc - z_open, centered=(False, True, False)).translate((x0, 0, z_open)))
    for x in (x0, x1):
        channel = safe_fuse(channel, cq.Workplane("XY").sphere(r).translate((x, 0, zc)))
        channel = safe_fuse(channel, cq.Workplane("XY").workplane(offset=z_open).center(x, 0).circle(r).extrude(zc - z_open))
    return channel


def build(params: dict) -> cq.Shape:
    p = {**PARAMS, **params}
    ex, _, ez = p["elbow_origin"]
    tx, _, tz = p["tip_origin"]
    r, sag = p["end_r"], p["sag_half_h"]
    mid = (ex + tx) / 2.0
    tw, bw = p["tongue_half_w"], p["body_half_w"]
    x_start, x_end = ex - r - 5.0, tx + r + 6.0

    plan = _outline("XY", (x_start, tw), [
        ("line", (p["tongue_to_x"], tw)),
        ("line", (p["body_from_x"], bw)),
        ("line", (x_end, bw)),
        ("line", (x_end, -bw)),
        ("line", (p["body_from_x"], -bw)),
        ("line", (p["tongue_to_x"], -tw)),
        ("line", (x_start, -tw)),
    ]).extrude(ez + 3 * r, both=True)
    flare = [e for e in plan.val().Edges()
             if _is_line_along(e, (0, 0, 1)) and p["tongue_to_x"] - 1 < e.Center().x < p["body_from_x"] + 1]
    plan = plan.val().fillet(p["flare_fillet"], flare)
    low, high = (mid, ez - sag), (mid, ez + sag)
    elbow_low, tip_low = _tangent((ex, ez), r, low, -1), _tangent((tx, tz), r, low, -1)
    tip_high, elbow_high = _tangent((tx, tz), r, high, 1), _tangent((ex, ez), r, high, 1)
    blend = p["sag_blend"]
    side = _outline("XZ", elbow_low, [
        *_rounded([elbow_low, low, tip_low], blend),
        ("arc", (tx + r, tz), tip_high),
        *_rounded([tip_high, high, elbow_high], blend),
        ("arc", (ex - r, ez), elbow_low),
    ]).extrude(3 * bw, both=True)
    body = safe_intersect(cq.Workplane("XY").add(plan), side).val()

    silhouette = [e for e in body.Edges() if not (_is_line_along(e, (0, 0, 1)) or _is_line_along(e, (0, 1, 0)))]
    body = body.fillet(p["edge_fillet"], silhouette)

    slot_r = p["slot_w"] / 2.0
    slot_x = p["slot_end_x"] + slot_r
    slot = safe_fuse(
        cq.Workplane("XY").workplane(offset=tz - 2 * r).center(slot_x, 0).circle(slot_r).extrude(4 * r),
        cq.Workplane("XY").box(x_end + 5.0 - slot_x, p["slot_w"], 4 * r, centered=(False, True, False))
        .translate((slot_x, 0, tz - 2 * r)),
    )
    elbow_bore_r, tip_bore_r = p["elbow_bore_d"] / 2.0, p["tip_bore_d"] / 2.0
    bores = [cq.Workplane("XZ").center(x, z).circle(bore_r).extrude(2 * bw, both=True)
             for x, z, bore_r in ((ex, ez, elbow_bore_r), (tx, tz, tip_bore_r))]
    x0, x1, width, floor = p["pocket"]
    pocket = _stadium(x0, x1, width, floor, ez + 3 * r)
    cx0, cx1, cr, czc = p["cable_channel"]
    channel = _ball_channel(cx0, cx1, cr, czc, ez - 3 * r)
    body = safe_cut(body, slot)
    body = safe_cut(body, bores[0])
    body = safe_cut(body, bores[1])
    body = safe_cut(body, pocket)
    body = safe_cut(body, channel)

    entries = (_circle_edges(body, elbow_bore_r, [((ex, 0.0, ez), (0, 1, 0))])
               + _circle_edges(body, tip_bore_r, [((tx, 0.0, tz), (0, 1, 0))]))
    return body.chamfer(p["bore_chamfer"], None, entries)


SUPPORT = {"PLANE": "plane", "CYLINDER": "cylinder", "CONE": "cone", "SPHERE": "sphere", "TORUS": "torus",
           "BEZIER": "bezier", "BSPLINE": "bspline", "REVOLUTION": "revolution", "EXTRUSION": "extrusion",
           "OFFSET": "offset"}
KINDS = {"tongue_seating_face": "plane_face", "tongue_far_face": "plane_face", "elbow_bore": "bore",
         "tip_bore": "bore", "bore_entry_chamfers": "chamfer", "head_clevis": "slot", "head_cheek_face": "plane_face",
         "far_cheek_face": "plane_face", "lightening_pocket": "slot", "cable_channel": "surface",
         "outer_contour": "surface", "elbow_end": "shaft", "tip_end": "shaft", "flare_rounds": "round",
         "sag_blends": "round", "silhouette_rounds": "round"}


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


def _role(p: dict, face: cq.Face, patch: dict) -> str | None:
    _, y, z = patch["point_mm"]
    normal = cq.Vector(*patch["normal"])
    kind = patch["support_type"]
    _, _, pocket_w, floor = p["pocket"]
    channel_r = p["cable_channel"][2]
    if kind == "plane" and abs(abs(normal.z) - 1.0) < 1e-6:
        return "lightening_pocket" if abs(z - floor) < 1e-6 else None
    if kind == "plane" and abs(abs(normal.y) - 1.0) < 1e-6:
        sides = ((p["tongue_half_w"], "tongue_seating_face" if y > 0 else "tongue_far_face"),
                 (p["body_half_w"], "head_cheek_face" if y > 0 else "far_cheek_face"),
                 (p["slot_w"] / 2.0, "head_clevis"), (pocket_w / 2.0, "lightening_pocket"), (channel_r, "cable_channel"))
        return next((name for half, name in sides if abs(abs(y) - half) < 1e-6), None)
    if kind in ("plane", "bspline"):  # flare and sagging runs, blends of curved edges
        return "outer_contour"
    if kind == "cylinder":
        surface = BRepAdaptor_Surface(face.wrapped).Cylinder()
        radius = surface.Radius()
        if abs(radius - p["end_r"]) < 1e-6:  # the contour's end radii, one round each bore axis
            ex, tx = p["elbow_origin"][0], p["tip_origin"][0]
            return "elbow_end" if abs(surface.Location().X() - ex) < abs(surface.Location().X() - tx) else "tip_end"
        radii = ((p["elbow_bore_d"] / 2.0, "elbow_bore"), (p["tip_bore_d"] / 2.0, "tip_bore"),
                 (p["edge_fillet"], "silhouette_rounds"), (p["flare_fillet"], "flare_rounds"),
                 (p["sag_blend"], "sag_blends"), (p["slot_w"] / 2.0, "head_clevis"),
                 (pocket_w / 2.0, "lightening_pocket"), (channel_r, "cable_channel"))
        return next((name for r, name in radii if abs(radius - r) < 1e-6), None)
    return {"cone": "bore_entry_chamfers", "torus": "silhouette_rounds", "sphere": "cable_channel"}.get(kind)


def drawing_features(params: dict, shape: cq.Shape) -> dict:
    """Every final face by its role: tongue faces, bores, head clevis, pocket, channel, contour and rounds."""
    p = {**PARAMS, **params}
    features: dict[str, list] = {}
    for face in shape.Faces():
        patch = _witness(face)
        name = _role(p, face, patch)
        if name == "tip_bore":  # the +Y cheek grips the pin's press band, the -Y cheek supports its journal
            patch["region"] = "head_side_cheek" if patch["point_mm"][1] > 0 else "far_cheek"
        if name is not None:
            features.setdefault(name, []).append(patch)
    return {name: {"kind": KINDS[name], "frame": "assembly_zero", "patches": patches}
            for name, patches in features.items()}
