"""LMP-0003 Upper link: cad-design reference model, build123d 0.13, fidelity F2.

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
"""

import math

import build123d as bd
from cadmodel.safe import safe_cut, safe_fuse, safe_intersect

KERNEL = "build123d"
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
BOTTOM = (bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN)


def _face(start, segments):
    """Planar face from ("line", end) and ("arc", mid, end) segments in local (x, y)."""
    edges, current = [], start
    for segment in segments:
        if segment[0] == "line":
            edges.append(bd.Line(current, segment[1]))
            current = segment[1]
        else:
            edges.append(bd.ThreePointArc(current, segment[1], segment[2]))
            current = segment[2]
    return bd.Face(bd.Wire(edges))


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
    if edge.geom_type != bd.GeomType.LINE:
        return False
    d = (edge.end_point() - edge.start_point()).normalized()
    return abs(abs(d.dot(bd.Vector(*axis))) - 1.0) < 1e-6


def _circle_edges(shape, radius, axes):
    """Circular edges of `radius` centred on one of the (point, direction) axes."""
    found = []
    for edge in shape.edges():
        if edge.geom_type == bd.GeomType.CIRCLE and abs(edge.radius - radius) < 1e-6:
            center = edge.arc_center
            for point, direction in axes:
                offset = center - bd.Vector(*point)
                d = bd.Vector(*direction)
                if (offset - d * offset.dot(d)).length < 1e-3:
                    found.append(edge)
                    break
    return found


def _stadium(x0, x1, width, z0, z1):
    return bd.extrude(bd.Pos((x0 + x1) / 2.0, 0, z0) * bd.SlotOverall(x1 - x0, width), amount=z1 - z0)


def _ball_channel(x0, x1, r, zc, z_open):
    """Stopped channel cut from below by a ball-end mill of radius r travelling x0 -> x1 at height zc."""
    channel = bd.Pos(x0, 0, zc) * bd.Rot(0, 90, 0) * bd.Cylinder(r, x1 - x0, align=BOTTOM)
    channel = safe_fuse(channel, bd.Pos(x0, 0, z_open) * bd.Box(x1 - x0, 2 * r, zc - z_open, align=(bd.Align.MIN, bd.Align.CENTER, bd.Align.MIN)))
    for x in (x0, x1):
        channel = safe_fuse(channel, bd.Pos(x, 0, zc) * bd.Sphere(r))
        channel = safe_fuse(channel, bd.Pos(x, 0, z_open) * bd.Cylinder(r, zc - z_open, align=BOTTOM))
    return channel


def build(params: dict) -> bd.Part:
    p = {**PARAMS, **params}
    ex, _, ez = p["elbow_origin"]
    tx, _, tz = p["tip_origin"]
    r, sag = p["end_r"], p["sag_half_h"]
    mid = (ex + tx) / 2.0
    tw, bw = p["tongue_half_w"], p["body_half_w"]
    x_start, x_end = ex - r - 5.0, tx + r + 6.0

    plan = bd.extrude(_face((x_start, tw), [
        ("line", (p["tongue_to_x"], tw)),
        ("line", (p["body_from_x"], bw)),
        ("line", (x_end, bw)),
        ("line", (x_end, -bw)),
        ("line", (p["body_from_x"], -bw)),
        ("line", (p["tongue_to_x"], -tw)),
        ("line", (x_start, -tw)),
        ("line", (x_start, tw)),
    ]), amount=ez + 3 * r, both=True)
    flare = [e for e in plan.edges()
             if _is_line_along(e, (0, 0, 1)) and p["tongue_to_x"] - 1 < e.center().X < p["body_from_x"] + 1]
    plan = bd.fillet(flare, p["flare_fillet"])
    low, high = (mid, ez - sag), (mid, ez + sag)
    elbow_low, tip_low = _tangent((ex, ez), r, low, -1), _tangent((tx, tz), r, low, -1)
    tip_high, elbow_high = _tangent((tx, tz), r, high, 1), _tangent((ex, ez), r, high, 1)
    blend = p["sag_blend"]
    side = bd.extrude(bd.Plane.XZ * _face(elbow_low, [
        *_rounded([elbow_low, low, tip_low], blend),
        ("arc", (tx + r, tz), tip_high),
        *_rounded([tip_high, high, elbow_high], blend),
        ("arc", (ex - r, ez), elbow_low),
    ]), amount=3 * bw, both=True)
    body = safe_intersect(plan, side)

    silhouette = [e for e in body.edges() if not (_is_line_along(e, (0, 0, 1)) or _is_line_along(e, (0, 1, 0)))]
    body = bd.fillet(silhouette, p["edge_fillet"])

    slot_r = p["slot_w"] / 2.0
    slot_x = p["slot_end_x"] + slot_r
    slot = safe_fuse(
        bd.Pos(slot_x, 0, tz - 2 * r) * bd.Cylinder(slot_r, 4 * r, align=BOTTOM),
        bd.Pos(slot_x, 0, tz - 2 * r) * bd.Box(
            x_end + 5.0 - slot_x, p["slot_w"], 4 * r, align=(bd.Align.MIN, bd.Align.CENTER, bd.Align.MIN)
        ),
    )
    elbow_bore_r, tip_bore_r = p["elbow_bore_d"] / 2.0, p["tip_bore_d"] / 2.0
    bores = [bd.Pos(x, 0, z) * bd.Rot(90, 0, 0) * bd.Cylinder(bore_r, 4 * bw)
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
    return bd.chamfer(entries, p["bore_chamfer"])
