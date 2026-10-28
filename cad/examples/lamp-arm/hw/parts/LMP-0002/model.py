"""LMP-0002 Lower link: cad-design reference model, CadQuery 2.8, fidelity F2.

CNC 6061-T6 link that turns in the base bushing on the pin pressed into its hub (J-001,
axis Z) and carries the elbow clevis (J-002, axis Y). Form: the intersection of a plan
outline (hub round, waisted taper, square fork end) and a side outline (flat hub,
sagging top and bottom, round elbow end), with 1.5 mm fillets on every silhouette edge.
Both outlines are tangent continuous: straight runs leave the hub and elbow rounds on
tangents and every shallow kink between runs carries a 40 mm blend, because a fillet
rolled across a kink of a few degrees leaves edges 0.1 mm out of tolerance. Then the
elbow clevis slot with a tool-radius end, H7 pin bores with 0.5 mm entry chamfers that
grip the pins' p6 press bands, a top lightening pocket, and a ball-end cable channel
underneath.

Zero pose, assembly coordinates: hub bore on (0, 0, 40) along Z; elbow bore on
(160, 0, 40) along Y; the arm lies along +X.

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
    "hub_origin": [0.0, 0.0, 40.0],
    "elbow_origin": [160.0, 0.0, 40.0],
    "hub_r": 13.0,
    "hub_h": 20.0,
    "waist_x": 70.0,
    "waist_half_w": 9.0,
    "fork_x": 130.0,
    "fork_half_w": 11.0,
    "side_waist_x": 80.0,  # side kinks must not coincide with plan kinks: the fillet fails there
    "outline_blend": 40.0,  # radius of the blends on the shallow outline kinks
    "waist_half_h": 7.5,
    "elbow_r": 11.0,
    "edge_fillet": 1.5,
    "pin_bore_d": 5.006,  # 5 H7 mid-limit from cad-fits (5.000..5.012); pin press band 5 p6
    "bore_chamfer": 0.5,
    "slot_w": 10.4,  # upper-link tongue 10 mm + 0.2 mm side clearance
    "slot_end_x": 132.0,
    "pocket": [24.0, 116.0, 8.0, 44.0],  # x0, x1, width, floor z
    "cable_channel": [20.0, 126.0, 3.0, 34.0],  # x0, x1, ball radius, ball-centre z
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
    hx, hy, hz = p["hub_origin"]
    ex, _, ez = p["elbow_origin"]
    hub_r, half_h, er = p["hub_r"], p["hub_h"] / 2.0, p["elbow_r"]
    end_x = ex + er + 4.0

    blend = p["outline_blend"]
    fork, waist = (p["fork_x"], p["fork_half_w"]), (p["waist_x"], p["waist_half_w"])
    hub_touch = _tangent((hx, hy), hub_r, (waist[0], -waist[1]), -1)
    lower = [hub_touch, (waist[0], -waist[1]), (fork[0], -fork[1]), (end_x, -fork[1])]
    upper = [(x, -y) for x, y in reversed(lower)]
    plan = _outline("XY", upper[-1], [("arc", (hx - hub_r, hy), hub_touch), *_rounded(lower, blend),
                                      ("line", upper[0]), *_rounded(upper, blend)]).extrude(hz + 2 * half_h, both=True)
    sx, sh = p["side_waist_x"], p["waist_half_h"]
    elbow_touch = _tangent((ex, ez), er, (sx, ez - sh), -1)
    # flat hub seat out to the hub radius, then the sagging run to a tangent on the elbow round
    lower = [(hx - hub_r - 5.0, hz - half_h), (hx + hub_r, hz - half_h), (sx, ez - sh), elbow_touch]
    upper = [(x, 2 * ez - z) for x, z in reversed(lower)]
    side = _outline("XZ", lower[0], [*_rounded(lower, blend), ("arc", (ex + er, ez), upper[0]),
                                     *_rounded(upper, blend)]).extrude(3 * hub_r, both=True)
    body = safe_intersect(plan, side).val()

    silhouette = [e for e in body.Edges() if not (_is_line_along(e, (0, 0, 1)) or _is_line_along(e, (0, 1, 0)))]
    body = body.fillet(p["edge_fillet"], silhouette)

    slot_r = p["slot_w"] / 2.0
    slot_x = p["slot_end_x"] + slot_r
    slot = safe_fuse(
        cq.Workplane("XY").workplane(offset=ez - 2 * er).center(slot_x, 0).circle(slot_r).extrude(4 * er),
        cq.Workplane("XY").box(end_x + 5.0 - slot_x, p["slot_w"], 4 * er, centered=(False, True, False))
        .translate((slot_x, 0, ez - 2 * er)),
    )
    bore_r = p["pin_bore_d"] / 2.0
    hub_bore = cq.Workplane("XY").workplane(offset=hz - 2 * half_h).center(hx, hy).circle(bore_r).extrude(4 * half_h)
    elbow_bore = cq.Workplane("XZ").center(ex, ez).circle(bore_r).extrude(2 * er, both=True)
    x0, x1, width, floor = p["pocket"]
    pocket = _stadium(x0, x1, width, floor, hz + 2 * half_h)
    cx0, cx1, cr, czc = p["cable_channel"]
    channel = _ball_channel(cx0, cx1, cr, czc, hz - 2 * half_h)
    body = safe_cut(body, slot)
    body = safe_cut(body, hub_bore)
    body = safe_cut(body, elbow_bore)
    body = safe_cut(body, pocket)
    body = safe_cut(body, channel)

    entries = _circle_edges(body, bore_r, [((hx, hy, hz), (0, 0, 1)), ((ex, 0.0, ez), (0, 1, 0))])
    return body.chamfer(p["bore_chamfer"], None, entries)


SUPPORT = {"PLANE": "plane", "CYLINDER": "cylinder", "CONE": "cone", "SPHERE": "sphere", "TORUS": "torus",
           "BEZIER": "bezier", "BSPLINE": "bspline", "REVOLUTION": "revolution", "EXTRUSION": "extrusion",
           "OFFSET": "offset"}
KINDS = {"hub_seat": "plane_face", "hub_top": "plane_face", "hub": "shaft", "hub_bore": "bore",
         "elbow_bore": "bore", "bore_entry_chamfers": "chamfer", "clevis": "slot", "head_cheek_face": "plane_face",
         "far_cheek_face": "plane_face", "lightening_pocket": "slot", "cable_channel": "surface",
         "outer_contour": "surface", "elbow_end": "shaft", "outline_blends": "round", "silhouette_rounds": "round"}


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
    kind, hz, half_h = patch["support_type"], p["hub_origin"][2], p["hub_h"] / 2.0
    _, _, pocket_w, floor = p["pocket"]
    channel_r = p["cable_channel"][2]
    if kind == "plane" and abs(abs(normal.z) - 1.0) < 1e-6:
        levels = ((hz - half_h, "hub_seat"), (hz + half_h, "hub_top"), (floor, "lightening_pocket"))
        return next((name for level, name in levels if abs(z - level) < 1e-6), None)
    if kind == "plane" and abs(abs(normal.y) - 1.0) < 1e-6:
        sides = ((p["slot_w"] / 2.0, "clevis"), (pocket_w / 2.0, "lightening_pocket"), (channel_r, "cable_channel"),
                 (p["fork_half_w"], "head_cheek_face" if y > 0 else "far_cheek_face"))
        return next((name for half, name in sides if abs(abs(y) - half) < 1e-6), None)
    if kind in ("plane", "bspline"):  # tapering plan sides, sagging top and bottom, blends of curved edges
        return "outer_contour"
    if kind == "cylinder":
        radius = BRepAdaptor_Surface(face.wrapped).Cylinder().Radius()
        axis = BRepAdaptor_Surface(face.wrapped).Cylinder().Axis().Direction()
        radii = ((p["pin_bore_d"] / 2.0, "hub_bore" if abs(axis.Z()) > 0.5 else "elbow_bore"),
                 (p["edge_fillet"], "silhouette_rounds"), (p["outline_blend"], "outline_blends"), (p["hub_r"], "hub"),
                 (p["elbow_r"], "elbow_end"), (p["slot_w"] / 2.0, "clevis"), (pocket_w / 2.0, "lightening_pocket"),
                 (channel_r, "cable_channel"))
        return next((name for r, name in radii if abs(radius - r) < 1e-6), None)
    return {"cone": "bore_entry_chamfers", "torus": "silhouette_rounds", "sphere": "cable_channel"}.get(kind)


def drawing_features(params: dict, shape: cq.Shape) -> dict:
    """Every final face by its role: datum faces, bores, clevis, pocket, channel, contour and rounds."""
    p = {**PARAMS, **params}
    features: dict[str, list] = {}
    for face in shape.Faces():
        patch = _witness(face)
        name = _role(p, face, patch)
        if name == "elbow_bore":  # the +Y cheek grips the pin's press band, the -Y cheek supports its journal
            patch["region"] = "head_side_cheek" if patch["point_mm"][1] > 0 else "far_cheek"
        if name is not None:
            features.setdefault(name, []).append(patch)
    return {name: {"kind": KINDS[name], "frame": "assembly_zero", "patches": patches}
            for name, patches in features.items()}
