"""LSP-0001 M5 x 30 shoulder pin (purchased; modelled as its envelope for assembly checks)."""

import cadquery as cq

KERNEL = "cadquery"
PARAMS = {"diameter": 5.0, "length": 30.0}


def build(params: dict) -> cq.Workplane:
    return cq.Workplane("XY").circle(params["diameter"] / 2).extrude(params["length"])
