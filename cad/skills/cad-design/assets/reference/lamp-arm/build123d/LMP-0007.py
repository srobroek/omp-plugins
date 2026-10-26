"""LMP-0007 M5 x 20 shoulder pin: cad-design reference model, build123d 0.13, fidelity F3.

Purchased stainless pin for the head tilt (J-003, axis Y), modelled as bought: a low
socket head (dk 8.5, k 3, 3 mm hex socket, 0.4 mm top chamfer), a 5 f7 shank at its
mid-limit, a DIN 471 retaining-ring groove just outside the upper link's -Y cheek,
and a 0.4 mm lead chamfer.

Zero pose, assembly coordinates: shank axis on (360, 0, 40) pointing -Y from the head;
the head underside sits 0.3 mm off the +Y cheek face.
"""

import math

import build123d as bd

KERNEL = "build123d"
PARAMS = {
    "origin": [360.0, 0.0, 40.0],  # J-003 origin
    "axis": [0.0, -1.0, 0.0],  # head -> tip
    "head_offset": -8.8,  # head underside position along `axis` from the origin
    "length": 20.0,
    "shank_d": 4.984,  # 5 f7 mid-limit from cad-fits (4.978..4.990)
    "head_d": 8.5,
    "head_k": 3.0,
    "socket_s": 3.0,
    "socket_depth": 2.0,
    "chamfer": 0.4,
    "groove_from_head": 17.3,  # DIN 471 for d = 5: groove d2 4.8, width m 0.7
    "groove_d": 4.8,
    "groove_w": 0.7,
}


def _plane(p):
    axis = bd.Vector(*p["axis"]).normalized()
    x_dir = bd.Vector(1, 0, 0) if abs(axis.X) < 0.9 else bd.Vector(0, 1, 0)
    x_dir = (x_dir - axis * x_dir.dot(axis)).normalized()
    return bd.Plane(origin=bd.Vector(*p["origin"]) + axis * p["head_offset"], x_dir=x_dir, z_dir=axis)


def build(params: dict) -> bd.Part:
    p = {**PARAMS, **params}
    r, length, c = p["shank_d"] / 2.0, p["length"], p["chamfer"]
    hr, k = p["head_d"] / 2.0, p["head_k"]
    g0, gw, gr = p["groove_from_head"], p["groove_w"], p["groove_d"] / 2.0
    # Section in (radius, axial) coordinates; the head lies at negative axial values.
    section = [
        (0.0, -k), (hr - c, -k), (hr, -k + c), (hr, 0.0), (r, 0.0), (r, g0), (gr, g0), (gr, g0 + gw),
        (r, g0 + gw), (r, length - c), (r - c, length), (0.0, length),
    ]
    pin = bd.revolve(bd.Plane.XZ * bd.Face(bd.Polyline(*section, close=True)), bd.Axis.Z)
    socket = bd.extrude(bd.Pos(0, 0, -k) * bd.RegularPolygon(p["socket_s"] / 2.0 / math.cos(math.pi / 6), 6),
                        amount=p["socket_depth"])
    return _plane(p).location * (pin - socket)
