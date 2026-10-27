"""LMP-0013 Retaining ring DIN 471 - 5x0.6: cad-design reference model, build123d 0.13, fidelity F2.

Catalogue spring-steel external ring for a 5 mm shaft (DR-004), modelled installed as
an envelope: s 0.6 thick, the bore opened from d3 4.7 to the groove root d2 4.8, a
concentric 0.8 mm section (the mean of DIN 471 b 1.1 opposite the opening and about
0.5 beside the lugs), and two lugs with d5 1.0 plier holes whose corners stay inside
the d4 10.2 swept diameter. The bore and the load face sit 0.005 mm off the pin
groove and the cheek face: a contact within cad-model's 0.01 mm, not a coincident
Boolean face.

Zero pose, assembly coordinates: in the LMP-0007 groove on the J-003 axis (360, 0, 40),
load face against the upper link's -Y cheek at y -8.5; the opening points +X.
"""

import build123d as bd
from cadmodel.safe import safe_cut, safe_fuse

KERNEL = "build123d"
PARAMS = {
    "origin": [360.0, 0.0, 40.0],  # J-003 origin
    "axis": [0.0, -1.0, 0.0],  # LMP-0007 head -> tip
    "face_offset": 8.505,  # load face position along `axis` from the origin
    "thickness": 0.6,  # DIN 471 s
    "bore_d": 4.81,  # groove root d2 4.8 + 0.01 mm modelling clearance
    "section_w": 0.8,  # mean of b 1.1 (back) and ~0.5 (beside the lugs)
    "gap": 1.0,  # opening between the lugs
    "lug_w": 1.6,
    "lug_reach": 4.6,  # lug outer edge from the axis; corners at r 5.06 < d4 / 2
    "hole_d": 1.0,  # DIN 471 d5
    "hole_at": 3.7,  # plier-hole centre from the axis, along the opening
}

BASE = (bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN)


def _plane(p):
    axis = bd.Vector(*p["axis"]).normalized()
    x_dir = bd.Vector(1, 0, 0) if abs(axis.X) < 0.9 else bd.Vector(0, 1, 0)
    x_dir = (x_dir - axis * x_dir.dot(axis)).normalized()
    return bd.Plane(origin=bd.Vector(*p["origin"]) + axis * p["face_offset"], x_dir=x_dir, z_dir=axis)


def build(params: dict) -> bd.Part:
    p = {**PARAMS, **params}
    t, ri = p["thickness"], p["bore_d"] / 2.0
    reach, lug_y = p["lug_reach"], p["gap"] / 2.0 + p["lug_w"] / 2.0
    ring = bd.Cylinder(ri + p["section_w"], t, align=BASE)
    lugs = [bd.Pos(reach / 2.0, y, 0) * bd.Box(reach, p["lug_w"], t, align=BASE) for y in (lug_y, -lug_y)]
    ring = safe_fuse(ring, *lugs)
    # Cutters overrun both faces by 1 mm so no Boolean face is coplanar with the ring's.
    bore = bd.Pos(0, 0, -1.0) * bd.Cylinder(ri, t + 2.0, align=BASE)
    opening = bd.Pos(reach, 0, -1.0) * bd.Box(2.0 * reach, p["gap"], t + 2.0, align=BASE)
    holes = [bd.Pos(p["hole_at"], y, -1.0) * bd.Cylinder(p["hole_d"] / 2.0, t + 2.0, align=BASE) for y in (lug_y, -lug_y)]
    return _plane(p).location * safe_cut(ring, bore, opening, *holes)
