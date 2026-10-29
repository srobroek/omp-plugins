"""Regression fixture: a block with Osifont lettering cut into its top face."""

import build123d as bd

from cadmodel.safe import safe_cut

KERNEL = "build123d"
REQUIRES_OSIFONT = True
PARAMS = {"width": 20.0, "length": 30.0, "height": 3.0, "text": "LMP", "text_size": 8.0,
          "text_depth": 0.6}


def build(params: dict) -> bd.Part:
    p = {**PARAMS, **params}
    body = bd.Box(p["width"], p["length"], p["height"],
                  align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN))
    text = bd.Text(p["text"], p["text_size"], font="Arial", font_path=p["font_path"],
                   font_style=bd.FontStyle.BOLD)
    tool = bd.extrude(bd.Pos(0, 0, p["height"]) * text, amount=-p["text_depth"])
    return safe_cut(body, tool)
