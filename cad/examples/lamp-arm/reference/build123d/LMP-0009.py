"""LMP-0009 Bushing SPIROL CMPL 4 X 6 EK CL8100: cad-design reference model, build123d 0.13, fidelity F2.

Catalogue headed knurled brass sleeve (a SPIROL compression limiter used as a plain
bearing, DR-004), heat-set into the head knuckle; the LMP-0007 5 f7 journal turns in its
bore and the 1 mm head is the brass thrust face toward the upper link's +Y cheek. Modelled
as its envelope: the knurl at the published nominal 7.97 over the 6 mm body (the pilot
length is not published), the head at the 9.35/9.60 mid-limit, the bore at the 5.05/5.15
mid-limit; OAL 7 (+0/-0.15) at its upper limit so both ends lie flush with the knuckle.

Zero pose, assembly coordinates: on the J-003 axis (360, 0, 40) pointing -Y from the head;
the head underside seats on the knuckle counterbore floor at y 2.5.
"""

import build123d as bd

KERNEL = "build123d"
PARAMS = {
    "origin": [360.0, 0.0, 40.0],  # J-003 origin
    "axis": [0.0, -1.0, 0.0],  # head -> body end
    "head_offset": -2.5,  # head underside along `axis` from the origin: the counterbore floor
    "length": 6.0,  # body L, +0/-0.15 on OAL = L + T
    "bore_d": 5.10,  # A 5.05/5.15 mid-limit
    "knurl_d": 7.97,  # C nominal; always larger than the 7.81 maximum hole
    "head_d": 9.475,  # H 9.35/9.60 mid-limit
    "head_t": 1.0,  # T ref
}


def _plane(p):
    axis = bd.Vector(*p["axis"]).normalized()
    x_dir = bd.Vector(1, 0, 0) if abs(axis.X) < 0.9 else bd.Vector(0, 1, 0)
    x_dir = (x_dir - axis * x_dir.dot(axis)).normalized()
    return bd.Plane(origin=bd.Vector(*p["origin"]) + axis * p["head_offset"], x_dir=x_dir, z_dir=axis)


def build(params: dict) -> bd.Part:
    p = {**PARAMS, **params}
    ri, rk, length = p["bore_d"] / 2.0, p["knurl_d"] / 2.0, p["length"]
    rh, t = p["head_d"] / 2.0, p["head_t"]
    # Section in the plane's (radius, axial) coordinates; the head lies at negative axial values.
    section = [(ri, -t), (rh, -t), (rh, 0.0), (rk, 0.0), (rk, length), (ri, length)]
    sleeve = bd.revolve(bd.Plane.XZ * bd.Face(bd.Polyline(*section, close=True)), bd.Axis.Z)
    return _plane(p).location * sleeve
