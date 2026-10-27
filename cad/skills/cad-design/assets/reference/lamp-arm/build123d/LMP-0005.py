"""LMP-0005 M5 x 30 shoulder pin: cad-design reference model, build123d 0.13, fidelity F3.

Stainless pin made to drawing (DR-003, DR-004) for the base pivot (J-001, axis Z): a
low socket head (dk 8.5, k 3, 3 mm hex socket, 0.4 mm top chamfer), a 5 p6 press band
at its mid-limit that grips the lower-link hub (5 H7/p6), a 5 f7 journal at its
mid-limit that turns in the LMP-0008 bushing, a DIN 471 retaining-ring groove that seats
the LMP-0011 ring under the bushing's lower end, and a 0.4 mm lead chamfer.

Zero pose, assembly coordinates: shank axis on (0, 0, 40) pointing -Z from the head;
the head underside sits 0.3 mm above the lower-link hub: the press band locates the pin.
"""

import math

import build123d as bd
from cadmodel.safe import safe_cut

KERNEL = "build123d"
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
    axis = bd.Vector(*p["axis"]).normalized()
    x_dir = bd.Vector(1, 0, 0) if abs(axis.X) < 0.9 else bd.Vector(0, 1, 0)
    x_dir = (x_dir - axis * x_dir.dot(axis)).normalized()
    return bd.Plane(origin=bd.Vector(*p["origin"]) + axis * p["head_offset"], x_dir=x_dir, z_dir=axis)


def build(params: dict) -> bd.Part:
    p = {**PARAMS, **params}
    r, pr, pl, length, c = p["shank_d"] / 2.0, p["press_d"] / 2.0, p["press_len"], p["length"], p["chamfer"]
    hr, k = p["head_d"] / 2.0, p["head_k"]
    g0, gw, gr = p["groove_from_head"], p["groove_w"], p["groove_d"] / 2.0
    # Section in (radius, axial) coordinates; the head lies at negative axial values.
    section = [
        (0.0, -k), (hr - c, -k), (hr, -k + c), (hr, 0.0), (pr, 0.0), (pr, pl), (r, pl), (r, g0), (gr, g0),
        (gr, g0 + gw), (r, g0 + gw), (r, length - c), (r - c, length), (0.0, length),
    ]
    pin = bd.revolve(bd.Plane.XZ * bd.Face(bd.Polyline(*section, close=True)), bd.Axis.Z)
    socket = bd.extrude(bd.Pos(0, 0, -k) * bd.RegularPolygon(p["socket_s"] / 2.0 / math.cos(math.pi / 6), 6),
                        amount=p["socket_depth"])
    return _plane(p).location * safe_cut(pin, socket)
