"""Regression fixture: a block with Osifont lettering cut into its top face."""

import cadquery as cq

from cadmodel.safe import safe_cut

KERNEL = "cadquery"
REQUIRES_OSIFONT = True
PARAMS = {"width": 20.0, "length": 30.0, "height": 3.0, "text": "LMP", "text_size": 8.0,
          "text_depth": 0.6}


def build(params: dict) -> cq.Shape:
    body = cq.Workplane("XY").box(params["width"], params["length"], params["height"],
                                  centered=(True, True, False))
    text = cq.Workplane("XY").workplane(offset=params["height"]).text(
        params["text"], params["text_size"], -params["text_depth"], combine=False,
        fontPath=params["font_path"], kind="bold")
    return safe_cut(body, text).val()
