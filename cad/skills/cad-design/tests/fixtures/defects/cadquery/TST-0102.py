"""Deliberate defect for form_check: 1.5 mm fillets rolled across outline kinks of a few degrees.

The form of the first LMP-0002 reference without its cuts: a plan outline and a side outline whose
straight runs meet each other and the hub and elbow rounds at 2 to 5 degree kinks. The fillets
there come out with edges 0.1 mm out of tolerance, and the STEP read-back volume moves by ~1e-5.
"""

import cadquery as cq

KERNEL = "cadquery"
PARAMS = {"hub_r": 13.0, "half_h": 10.0, "waist": [70.0, 9.0], "fork": [130.0, 11.0], "side_waist": [80.0, 7.5],
          "elbow": [160.0, 11.0], "z": 40.0, "edge_fillet": 1.5}


def _outline(plane, start, segments):
    wire = cq.Workplane(plane).moveTo(*start)
    for segment in segments:
        wire = wire.lineTo(*segment[1]) if segment[0] == "line" else wire.threePointArc(segment[1], segment[2])
    return wire.close()


def _is_line_along(edge, axis):
    if edge.geomType() != "LINE":
        return False
    d = (edge.endPoint() - edge.startPoint()).normalized()
    return abs(abs(d.dot(cq.Vector(*axis))) - 1.0) < 1e-6


def build(params: dict) -> cq.Shape:
    p = {**PARAMS, **params}
    r, h, z = p["hub_r"], p["half_h"], p["z"]
    (wx, ww), (fx, fw), (sx, sh), (ex, er) = p["waist"], p["fork"], p["side_waist"], p["elbow"]
    end_x = ex + er + 4.0
    plan = _outline("XY", (0.0, r), [
        ("arc", (-r, 0.0), (0.0, -r)), ("line", (wx, -ww)), ("line", (fx, -fw)), ("line", (end_x, -fw)),
        ("line", (end_x, fw)), ("line", (fx, fw)), ("line", (wx, ww)),
    ]).extrude(z + 2 * h, both=True)
    side = _outline("XZ", (-r - 5.0, z - h), [
        ("line", (r, z - h)), ("line", (sx, z - sh)), ("line", (ex, z - er)), ("arc", (ex + er, z), (ex, z + er)),
        ("line", (sx, z + sh)), ("line", (r, z + h)), ("line", (-r - 5.0, z + h)),
    ]).extrude(3 * r, both=True)
    body = plan.intersect(side).val()
    silhouette = [e for e in body.Edges() if not (_is_line_along(e, (0, 0, 1)) or _is_line_along(e, (0, 1, 0)))]
    return body.fillet(p["edge_fillet"], silhouette)
