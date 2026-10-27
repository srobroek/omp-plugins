"""LMP-0011 Retaining ring DIN 471 - 5x0.6: cad-design reference model, CadQuery 2.8, fidelity F2.

Catalogue spring-steel external ring for a 5 mm shaft (DR-004), modelled installed as
an envelope: s 0.6 thick, the bore opened from d3 4.7 to the groove root d2 4.8, a
concentric 0.8 mm section (the mean of DIN 471 b 1.1 opposite the opening and about
0.5 beside the lugs), and two lugs with d5 1.0 plier holes whose corners stay inside
the d4 10.2 swept diameter. The bore and the load face sit 0.005 mm off the pin
groove and the bushing end: a contact within cad-model's 0.01 mm, not a coincident
Boolean face.

Zero pose, assembly coordinates: in the LMP-0005 groove on the J-001 axis (0, 0, 40),
load face up against the LMP-0008 bushing end at z 21.5; the opening points +X.
"""

import cadquery as cq
from cadmodel.safe import safe_cut, safe_fuse

KERNEL = "cadquery"
PARAMS = {
    "origin": [0.0, 0.0, 40.0],  # J-001 origin
    "axis": [0.0, 0.0, -1.0],  # LMP-0005 head -> tip
    "face_offset": 18.505,  # load face position along `axis` from the origin
    "thickness": 0.6,  # DIN 471 s
    "bore_d": 4.81,  # groove root d2 4.8 + 0.01 mm modelling clearance
    "section_w": 0.8,  # mean of b 1.1 (back) and ~0.5 (beside the lugs)
    "gap": 1.0,  # opening between the lugs
    "lug_w": 1.6,
    "lug_reach": 4.6,  # lug outer edge from the axis; corners at r 5.06 < d4 / 2
    "hole_d": 1.0,  # DIN 471 d5
    "hole_at": 3.7,  # plier-hole centre from the axis, along the opening
}


def _plane(p):
    axis = cq.Vector(*p["axis"]).normalized()
    x_dir = cq.Vector(1, 0, 0) if abs(axis.x) < 0.9 else cq.Vector(0, 1, 0)
    x_dir = (x_dir - axis * x_dir.dot(axis)).normalized()
    return cq.Plane(cq.Vector(*p["origin"]) + axis * p["face_offset"], x_dir, axis)


def build(params: dict) -> cq.Shape:
    p = {**PARAMS, **params}
    t, ri = p["thickness"], p["bore_d"] / 2.0
    reach, lug_y = p["lug_reach"], p["gap"] / 2.0 + p["lug_w"] / 2.0
    lugs = [(reach / 2.0, lug_y), (reach / 2.0, -lug_y)]
    ring = cq.Workplane("XY").circle(ri + p["section_w"]).extrude(t)
    ring = safe_fuse(ring, cq.Workplane("XY").pushPoints(lugs).rect(reach, p["lug_w"]).extrude(t))
    # Cutters overrun both faces by 1 mm so no Boolean face is coplanar with the ring's.
    tools = cq.Workplane("XY").workplane(offset=-1.0)
    bore = tools.circle(ri).extrude(t + 2.0)
    opening = tools.center(reach, 0).rect(2.0 * reach, p["gap"]).extrude(t + 2.0)
    holes = tools.pushPoints([(p["hole_at"], lug_y), (p["hole_at"], -lug_y)]).circle(p["hole_d"] / 2.0).extrude(t + 2.0)
    shape = safe_cut(ring, bore, opening, holes).val()
    return shape.transformShape(_plane(p).rG)
