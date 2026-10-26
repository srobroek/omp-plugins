"""LMP-0003 Upper link: cad-design reference model, CadQuery 2.8, fidelity F2.

CNC 6061-T6 link between the elbow (J-002) and the head tilt (J-003), both axis Y.
The elbow end is a 10 mm tongue that turns inside the lower link's clevis; the plan
outline flares through 8 mm vertical blends to the 17 mm body and the head clevis.
The side outline sags between the two round ends. Silhouette edges carry 1.5 mm
fillets; then the head clevis slot, H8 pin bores with 0.5 mm entry chamfers, a top
lightening pocket and a ball-end cable channel underneath.

Zero pose, assembly coordinates: elbow bore on (160, 0, 40), tip bore on (360, 0, 40),
both along Y.
"""

import cadquery as cq

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
    "edge_fillet": 1.5,
    "pin_bore_d": 5.009,  # 5 H8 mid-limit from cad-fits (5.000..5.018); pin 5 f7
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
    channel = channel.union(
        cq.Workplane("XY").box(x1 - x0, 2 * r, zc - z_open, centered=(False, True, False)).translate((x0, 0, z_open))
    )
    for x in (x0, x1):
        channel = channel.union(cq.Workplane("XY").sphere(r).translate((x, 0, zc)))
        channel = channel.union(cq.Workplane("XY").workplane(offset=z_open).center(x, 0).circle(r).extrude(zc - z_open))
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
    side = _outline("XZ", (ex, ez - r), [
        ("line", (mid, ez - sag)),
        ("line", (tx, tz - r)),
        ("arc", (tx + r, tz), (tx, tz + r)),
        ("line", (mid, ez + sag)),
        ("line", (ex, ez + r)),
        ("arc", (ex - r, ez), (ex, ez - r)),
    ]).extrude(3 * bw, both=True)
    body = cq.Workplane("XY").add(plan).intersect(side).val()

    silhouette = [e for e in body.Edges() if not (_is_line_along(e, (0, 0, 1)) or _is_line_along(e, (0, 1, 0)))]
    body = body.fillet(p["edge_fillet"], silhouette)

    slot_r = p["slot_w"] / 2.0
    slot_x = p["slot_end_x"] + slot_r
    slot = (
        cq.Workplane("XY").workplane(offset=tz - 2 * r).center(slot_x, 0).circle(slot_r).extrude(4 * r)
        .union(cq.Workplane("XY").box(x_end + 5.0 - slot_x, p["slot_w"], 4 * r, centered=(False, True, False))
               .translate((slot_x, 0, tz - 2 * r)))
    )
    bore_r = p["pin_bore_d"] / 2.0
    bores = [cq.Workplane("XZ").center(x, z).circle(bore_r).extrude(2 * bw, both=True) for x, z in ((ex, ez), (tx, tz))]
    x0, x1, width, floor = p["pocket"]
    pocket = _stadium(x0, x1, width, floor, ez + 3 * r)
    cx0, cx1, cr, czc = p["cable_channel"]
    channel = _ball_channel(cx0, cx1, cr, czc, ez - 3 * r)
    body = cq.Workplane("XY").add(body).cut(slot).cut(bores[0]).cut(bores[1]).cut(pocket).cut(channel).val()

    entries = _circle_edges(body, bore_r, [((ex, 0.0, ez), (0, 1, 0)), ((tx, 0.0, tz), (0, 1, 0))])
    return body.chamfer(p["bore_chamfer"], None, entries)
