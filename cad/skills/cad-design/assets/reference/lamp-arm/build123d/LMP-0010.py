"""LMP-0010 Heat-set insert QT M10x1 x 12.7 OD 12.6: cad-design reference model, build123d 0.13, fidelity F2.

Catalogue brass heat-set insert for the lampholder's M10x1 nipple (DR-004): the In-saiL
QT-M10x12.7-OD12.6 envelope with its thread specified M10x1, heat-staked into the head's
socket boss. Modelled as its envelope: the knurl at the published 12.6 over the full 12.7
length (the 11.8 pilot length is not published) and the thread as a plain bore at the
M10x1 basic minor diameter D1 = D - 1.0825 P (ISO 724).

Zero pose, assembly coordinates: on the shade axis (430, 0), installed end flush with the
socket-boss face at z 50 and the blind end 1 mm short of the hole bottom at z 63.7.
"""

import build123d as bd

KERNEL = "build123d"
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
    axis = bd.Vector(*p["axis"]).normalized()
    x_dir = bd.Vector(1, 0, 0) if abs(axis.X) < 0.9 else bd.Vector(0, 1, 0)
    x_dir = (x_dir - axis * x_dir.dot(axis)).normalized()
    return bd.Plane(origin=bd.Vector(*p["origin"]) + axis * p["face_offset"], x_dir=x_dir, z_dir=axis)


def build(params: dict) -> bd.Part:
    p = {**PARAMS, **params}
    ri = (p["thread_d"] - 1.0825 * p["thread_pitch"]) / 2.0  # ISO 724 basic minor diameter D1
    rk, length = p["knurl_d"] / 2.0, p["length"]
    # Section in the plane's (radius, axial) coordinates, from the installed end.
    section = [(ri, 0.0), (rk, 0.0), (rk, length), (ri, length)]
    sleeve = bd.revolve(bd.Plane.XZ * bd.Face(bd.Polyline(*section, close=True)), bd.Axis.Z)
    return _plane(p).location * sleeve
