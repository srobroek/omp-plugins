"""LMP-0011 Retaining ring DIN 471 - 5x0.6: cad-design reference model, build123d 0.13, fidelity F2.

Catalogue spring-steel external ring for a 5 mm shaft (DR-004), modelled installed as
an envelope: s 0.6 thick, the bore opened from d3 4.7 to the groove root d2 4.8, a
concentric 0.8 mm section (the mean of DIN 471 b 1.1 opposite the opening and about
0.5 beside the lugs), and two lugs with d5 1.0 plier holes whose corners stay inside
the d4 10.2 swept diameter. The bore and the load face sit 0.005 mm off the pin
groove and the face it bears on: a contact within cad-model's 0.01 mm, not a
coincident Boolean face.

Part-local frame (part.yaml model_frame: part_local): the ring axis is +Z, the load
face lies on z 0 and the ring extends to z 0.6, the opening points +X. assembly.yaml
places it three times, in the pin grooves at the zero pose: @ring-base on LMP-0005
under the LMP-0008 bushing end (load face up at z 21.495), @ring-elbow on LMP-0006 and
@ring-head on LMP-0007 outside the -Y clevis cheeks (load faces at y -11.005 and
-8.505).
"""

import build123d as bd
from cadmodel.safe import safe_cut, safe_fuse

KERNEL = "build123d"
PARAMS = {
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
    return safe_cut(ring, bore, opening, *holes)
