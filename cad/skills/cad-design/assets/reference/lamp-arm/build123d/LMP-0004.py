"""LMP-0004 Lamp head housing: cad-design reference model, build123d 0.13, fidelity F3.

FDM PETG head that tilts on J-003 (axis Y). A 7 mm knuckle (1.5 mm edge fillets) turns
inside the upper link's clevis; a loft carries its rounded section into a round neck,
which joins a revolved cap and shade. The revolved profile holds the 4 mm cap roll-over,
a cosmetic split-line groove, the 2.4 mm shade wall (six 0.4 mm perimeters) with a
full-round rim, the E14 lampholder seat and its M10x1 nipple boss. F3 adds a fluted grip
band on the cap and the cable path from the arm into the socket.

Zero pose, assembly coordinates: pivot bore on (360, 0, 40) along Y; the shade axis is
vertical through (430, 0) and opens downward.
"""

import math

import build123d as bd

KERNEL = "build123d"
PARAMS = {
    "pivot_origin": [360.0, 0.0, 40.0],
    "knuckle_r": 9.0,
    "knuckle_t": 7.0,
    "knuckle_to_x": 384.0,
    "neck_x": 404.0,
    "neck_r": 8.0,
    "edge_fillet": 1.5,
    "pin_bore_d": 5.2,  # 5 H11 hole + 0.2 mm FDM hole allowance (cad-fits: 5 H11 max 5.075)
    "bore_chamfer": 0.4,
    "shade_axis_x": 430.0,
    "cap_r": 17.0,
    "cap_wall": 3.0,
    "cap_bottom_z": 34.0,
    "cap_top_z": 66.0,
    "cap_fillet": 4.0,
    "split_z": 50.0,
    "split_depth": 0.6,
    "shade_mid": [35.2, 21.4],  # (r, z) of the dome's mid point
    "rim": [46.0, 2.0],  # (r, z) of the outer rim edge
    "shade_wall": 2.4,
    "socket_boss_r": 7.0,
    "socket_boss_z": 54.0,
    "nipple_bore_d": 9.0,  # M10x1 thread-forming in PETG
    "grip_flutes": 20,
    "grip_r": 0.8,
    "grip_z": [53.0, 60.0],
    "cable_d": 6.0,
    "cable_entry_x": 410.0,
}
BOTTOM = (bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN)


def _circle3(a, b, c):
    """Centre and radius of the circle through three (r, z) points."""
    (ax, ay), (bx, by), (cx, cy) = a, b, c
    d = 2.0 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
    uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
    return (ux, uy), math.hypot(ax - ux, ay - uy)


def _toward(point, center, distance):
    dx, dy = center[0] - point[0], center[1] - point[1]
    n = math.hypot(dx, dy)
    return (point[0] + dx / n * distance, point[1] + dy / n * distance)


def _shade_profile(p):
    """Closed (r, z) boundary of the revolved cap and shade, starting on the axis at the top."""
    rc, top, f = p["cap_r"], p["cap_top_z"], p["cap_fillet"]
    ri = rc - p["cap_wall"]
    t = p["shade_wall"]
    p0, p1, p2 = (rc, p["cap_bottom_z"]), tuple(p["shade_mid"]), tuple(p["rim"])
    center, radius = _circle3(p0, p1, p2)
    q0, q1, q2 = (_toward(q, center, t) for q in (p0, p1, p2))
    # Full-round rim: bulge half a wall past the rim along the dome's direction of travel.
    ux, uy = (p2[0] - center[0]) / radius, (p2[1] - center[1]) / radius
    tangent = (uy, -ux) if uy * (p2[0] - p1[0]) - ux * (p2[1] - p1[1]) > 0 else (-uy, ux)
    rim_mid = ((p2[0] + q2[0]) / 2.0 + tangent[0] * t / 2.0, (p2[1] + q2[1]) / 2.0 + tangent[1] * t / 2.0)
    s, sd = p["split_z"], p["split_depth"]
    boss_r, boss_z = p["socket_boss_r"], p["socket_boss_z"]
    ceiling = top - f
    nipple = p["nipple_bore_d"] / 2.0
    a = math.radians(45.0)
    return (0.0, top), [
        ("line", (rc - f, top)),
        ("arc", (rc - f + f * math.cos(a), ceiling + f * math.sin(a)), (rc, ceiling)),
        ("line", (rc, s + sd)),
        ("line", (rc - sd, s)),
        ("line", (rc, s - sd)),
        ("line", p0),
        ("arc", p1, p2),
        ("arc", rim_mid, q2),
        ("arc", q1, q0),
        ("line", (ri, q0[1])),
        ("line", (ri, ceiling)),
        ("line", (boss_r, ceiling)),
        ("line", (boss_r, boss_z)),
        ("line", (nipple, boss_z)),
        ("line", (nipple, top - 2.0)),
        ("line", (0.0, top - 2.0)),
        ("line", (0.0, top)),
    ]


def _face(start, segments):
    edges, current = [], start
    for segment in segments:
        if segment[0] == "line":
            edges.append(bd.Line(current, segment[1]))
            current = segment[1]
        else:
            edges.append(bd.ThreePointArc(current, segment[1], segment[2]))
            current = segment[2]
    return bd.Face(bd.Wire(edges))


def _is_line_along(edge, axis):
    if edge.geom_type != bd.GeomType.LINE:
        return False
    d = (edge.end_point() - edge.start_point()).normalized()
    return abs(abs(d.dot(bd.Vector(*axis))) - 1.0) < 1e-6


def build(params: dict) -> bd.Part:
    p = {**PARAMS, **params}
    px, _, pz = p["pivot_origin"]
    kr, half_t, kx = p["knuckle_r"], p["knuckle_t"] / 2.0, p["knuckle_to_x"]
    f = p["edge_fillet"]

    knuckle = bd.extrude(bd.Plane.XZ * _face((px, pz - kr), [
        ("line", (kx, pz - kr)),
        ("line", (kx, pz + kr)),
        ("line", (px, pz + kr)),
        ("arc", (px - kr, pz), (px, pz - kr)),
    ]), amount=half_t, both=True)
    rounded = [e for e in knuckle.edges()
               if not _is_line_along(e, (0, 1, 0)) and not (_is_line_along(e, (0, 0, 1)) and abs(e.center().X - kx) < 1e-6)]
    knuckle = bd.fillet(rounded, f)

    section = bd.Pos(kx, 0, pz) * (bd.Plane.YZ * bd.RectangleRounded(p["knuckle_t"], 2 * kr, f))
    collar = bd.Pos(p["neck_x"], 0, pz) * (bd.Plane.YZ * bd.Circle(p["neck_r"]))
    neck = bd.loft([section, collar])
    stub = bd.Pos(p["neck_x"], 0, pz) * bd.Rot(0, 90, 0) * bd.Cylinder(
        p["neck_r"], p["shade_axis_x"] - p["neck_x"], align=BOTTOM
    )

    start, segments = _shade_profile(p)
    shade = bd.revolve(bd.Pos(p["shade_axis_x"], 0, 0) * (bd.Plane.XZ * _face(start, segments)),
                       bd.Axis((p["shade_axis_x"], 0, 0), (0, 0, 1)))
    body = knuckle + neck + stub + shade
    rc = p["cap_r"]
    z0, z1 = p["grip_z"]
    for k in range(p["grip_flutes"]):
        a = 2.0 * math.pi * k / p["grip_flutes"]
        body -= bd.Pos(p["shade_axis_x"] + rc * math.cos(a), rc * math.sin(a), z0) * bd.Cylinder(
            p["grip_r"], z1 - z0, align=BOTTOM
        )

    cable_r = p["cable_d"] / 2.0
    run = bd.Pos(p["cable_entry_x"] - cable_r, 0, pz) * bd.Rot(0, 90, 0) * bd.Cylinder(
        cable_r, p["shade_axis_x"] - p["cable_entry_x"] + cable_r, align=BOTTOM
    )
    entry = bd.Pos(p["cable_entry_x"], 0, pz - 2 * p["neck_r"]) * bd.Cylinder(cable_r, 2 * p["neck_r"], align=BOTTOM)
    bore = bd.Pos(px, 0, pz) * bd.Rot(90, 0, 0) * bd.Cylinder(p["pin_bore_d"] / 2.0, 4 * half_t)
    body = body - run - entry - bore

    bore_r = p["pin_bore_d"] / 2.0
    entries = [e for e in body.edges() if e.geom_type == bd.GeomType.CIRCLE and abs(e.radius - bore_r) < 1e-6
               and abs(e.arc_center.X - px) < 1e-3 and abs(e.arc_center.Z - pz) < 1e-3]
    return bd.chamfer(entries, p["bore_chamfer"])
