"""Deliberate defect for form_check: equal-radius bores meeting in a T (CadQuery 2.8 cut leaves an unorientable face).

The cable path of the first LMP-0004 reference, reduced: a round neck, a 6 mm run along it that starts
tangent to a 6 mm entry from below. The STEP read-back heals the face, so only the in-memory check sees it.
"""

import cadquery as cq

KERNEL = "cadquery"
PARAMS = {"neck_r": 8.0, "neck_x": [404.0, 430.0], "z": 40.0, "cable_d": 6.0, "entry_x": 410.0}


def build(params: dict) -> cq.Shape:
    p = {**PARAMS, **params}
    x0, x1 = p["neck_x"]
    r = p["cable_d"] / 2.0
    body = cq.Workplane("YZ").workplane(offset=x0).center(0, p["z"]).circle(p["neck_r"]).extrude(x1 - x0)
    run = cq.Workplane("YZ").workplane(offset=p["entry_x"] - r).center(0, p["z"]).circle(r).extrude(x1 - p["entry_x"] + r)
    entry = cq.Workplane("XY").workplane(offset=p["z"] - 2 * p["neck_r"]).center(p["entry_x"], 0).circle(r).extrude(
        2 * p["neck_r"])
    return body.cut(run).cut(entry).val()
