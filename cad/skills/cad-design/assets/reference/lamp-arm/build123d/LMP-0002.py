"""LMP-0002 Lower link: cad-design reference model, build123d 0.13, fidelity F2.

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
"""

import math

import build123d as bd
from cadmodel.safe import safe_cut, safe_fuse, safe_intersect

KERNEL = "build123d"
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
    hx, hy, hz = p["hub_origin"]
    ex, _, ez = p["elbow_origin"]
    hub_r, half_h, er = p["hub_r"], p["hub_h"] / 2.0, p["elbow_r"]
    end_x = ex + er + 4.0

    blend = p["outline_blend"]
    fork, waist = (p["fork_x"], p["fork_half_w"]), (p["waist_x"], p["waist_half_w"])
    hub_touch = _tangent((hx, hy), hub_r, (waist[0], -waist[1]), -1)
    lower = [hub_touch, (waist[0], -waist[1]), (fork[0], -fork[1]), (end_x, -fork[1])]
    upper = [(x, -y) for x, y in reversed(lower)]
    plan = bd.extrude(_face(upper[-1], [("arc", (hx - hub_r, hy), hub_touch), *_rounded(lower, blend),
                                        ("line", upper[0]), *_rounded(upper, blend)]),
                      amount=hz + 2 * half_h, both=True)
    sx, sh = p["side_waist_x"], p["waist_half_h"]
    elbow_touch = _tangent((ex, ez), er, (sx, ez - sh), -1)
    # flat hub seat out to the hub radius, then the sagging run to a tangent on the elbow round
    lower = [(hx - hub_r - 5.0, hz - half_h), (hx + hub_r, hz - half_h), (sx, ez - sh), elbow_touch]
    upper = [(x, 2 * ez - z) for x, z in reversed(lower)]
    side = bd.extrude(bd.Plane.XZ * _face(lower[0], [*_rounded(lower, blend), ("arc", (ex + er, ez), upper[0]),
                                                     *_rounded(upper, blend), ("line", lower[0])]),
                      amount=3 * hub_r, both=True)
    body = safe_intersect(plan, side)

    silhouette = [e for e in body.edges() if not (_is_line_along(e, (0, 0, 1)) or _is_line_along(e, (0, 1, 0)))]
    body = bd.fillet(silhouette, p["edge_fillet"])

    slot_r = p["slot_w"] / 2.0
    slot_x = p["slot_end_x"] + slot_r
    slot = safe_fuse(
        bd.Pos(slot_x, 0, ez - 2 * er) * bd.Cylinder(slot_r, 4 * er, align=BOTTOM),
        bd.Pos(slot_x, 0, ez - 2 * er) * bd.Box(
            end_x + 5.0 - slot_x, p["slot_w"], 4 * er, align=(bd.Align.MIN, bd.Align.CENTER, bd.Align.MIN)
        ),
    )
    bore_r = p["pin_bore_d"] / 2.0
    hub_bore = bd.Pos(hx, hy, hz - 2 * half_h) * bd.Cylinder(bore_r, 4 * half_h, align=BOTTOM)
    elbow_bore = bd.Pos(ex, 0, ez) * bd.Rot(90, 0, 0) * bd.Cylinder(bore_r, 4 * er)
    x0, x1, width, floor = p["pocket"]
    pocket = _stadium(x0, x1, width, floor, hz + 2 * half_h)
    body = safe_cut(body, slot)
    body = safe_cut(body, hub_bore)
    body = safe_cut(body, elbow_bore)
    body = safe_cut(body, pocket)
    cx0, cx1, cr, czc = p["cable_channel"]
    channel = _ball_channel(cx0, cx1, cr, czc, hz - 2 * half_h)
    body = safe_cut(body, channel)

    entries = _circle_edges(body, bore_r, [((hx, hy, hz), (0, 0, 1)), ((ex, 0.0, ez), (0, 1, 0))])
    return bd.chamfer(entries, p["bore_chamfer"])
