"""LMP-0008 Bushing SPIROL CMPL 4 X 8 EK CL8000: cad-design reference model, build123d 0.13, fidelity F2.

Catalogue knurled brass sleeve (a SPIROL compression limiter used as a plain bearing,
DR-004), heat-set into the base boss; the LMP-0005 5 f7 journal turns in its bore. Modelled
as its envelope: the knurl at the published nominal 7.97 over the full length (the pilot
length is not published), the bore at the 5.05/5.15 mid-limit, L 8 (+0/-0.15) at its
upper limit so both ends lie flush.

Zero pose, assembly coordinates: on the J-001 axis (0, 0, 40) from the boss top at z 29.5
down to the access-pocket ceiling at z 21.5; the LMP-0011 ring bears on its lower end.
"""

import build123d as bd

KERNEL = "build123d"
PARAMS = {
    "origin": [0.0, 0.0, 40.0],  # J-001 origin
    "axis": [0.0, 0.0, -1.0],  # installed end -> far end
    "face_offset": 10.5,  # installed end along `axis` from the origin: the boss top z 29.5
    "length": 8.0,  # L, +0/-0.15
    "bore_d": 5.10,  # A 5.05/5.15 mid-limit
    "knurl_d": 7.97,  # C nominal; always larger than the 7.81 maximum hole
}


def _plane(p):
    axis = bd.Vector(*p["axis"]).normalized()
    x_dir = bd.Vector(1, 0, 0) if abs(axis.X) < 0.9 else bd.Vector(0, 1, 0)
    x_dir = (x_dir - axis * x_dir.dot(axis)).normalized()
    return bd.Plane(origin=bd.Vector(*p["origin"]) + axis * p["face_offset"], x_dir=x_dir, z_dir=axis)


def build(params: dict) -> bd.Part:
    p = {**PARAMS, **params}
    ri, rk, length = p["bore_d"] / 2.0, p["knurl_d"] / 2.0, p["length"]
    # Section in the plane's (radius, axial) coordinates, from the installed end.
    section = [(ri, 0.0), (rk, 0.0), (rk, length), (ri, length)]
    sleeve = bd.revolve(bd.Plane.XZ * bd.Face(bd.Polyline(*section, close=True)), bd.Axis.Z)
    return _plane(p).location * sleeve
