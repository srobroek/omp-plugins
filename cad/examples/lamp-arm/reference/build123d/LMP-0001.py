"""LMP-0001 Base plate and pivot boss: cad-design reference model, build123d 0.13, fidelity F3.

FDM PETG puck printed boss-up. One revolved profile carries the axisymmetric form: the
6 mm top roll-over fillet, the 1 mm bed-edge chamfer (no fillet on the bed face), the boss
with its 3 mm root fillet and 0.8 mm top chamfer, the J-001 bushing seat (SPIROL CL8000
M4 recommended hole, DR-004) with a 0.5 mm entry chamfer, the retaining-ring access pocket,
and a ballast cavity whose roof is self-supporting
(45-degree flanks, 20 mm flat bridge). Then two counterbored M6 slots (ISO 4762 head
dk 10, k 6), four rubber-foot recesses, and engraved text.

Zero pose, assembly coordinates: J-001 axis Z through (0, 0, 40); the LMP-0008 bushing is
heat-set from the boss top flush to the pocket ceiling, the LMP-0005 journal turns in it,
and the LMP-0011 ring bears on the bushing's lower end.
"""

import math

import build123d as bd
from cadmodel.safe import safe_cut

KERNEL = "build123d"

REQUIRES_OSIFONT = True
PARAMS = {
    "radius": 80.0,
    "height": 16.0,
    "top_fillet": 6.0,
    "bed_chamfer": 1.0,
    "boss_radius": 16.0,
    "boss_top": 29.5,
    "boss_fillet": 3.0,
    "boss_chamfer": 0.8,
    "seat_d": 7.77,  # SPIROL CL8000 M4 recommended hole 7.73/7.81, mid-limit; drilled after printing
    "bore_chamfer": 0.5,
    "clip_pocket_d": 14.0,
    "clip_seat_z": 21.5,
    "cavity_r_in": 14.0,
    "cavity_r_out": 50.0,
    "cavity_wall_h": 4.0,
    "cavity_roof_z": 12.0,
    "mount_angles": [120.0, 240.0],
    "mount_r": 62.0,
    "mount_travel": 8.0,
    "mount_clear_d": 6.6,  # ISO 273 medium clearance for M6
    "cbore_d": 11.0,  # ISO 4762 M6 head dk 10 + 1 mm
    "cbore_depth": 6.5,  # ISO 4762 M6 head k 6 + 0.5 mm
    "foot_r": 70.0,
    "foot_d": 10.0,
    "foot_depth": 1.0,
    "engraving": "LMP",
    "text_size": 8.0,
    "text_depth": 0.6,
    "text_at": [0.0, -44.0],
}


def _arc_mid(center, radius, a0, a1):
    a = math.radians((a0 + a1) / 2.0)
    return (center[0] + radius * math.cos(a), center[1] + radius * math.sin(a))


def _profile(p):
    """Closed (r, z) boundary of the revolved section: ("line", end) or ("arc", mid, end)."""
    bore_r = p["seat_d"] / 2.0
    c = p["bore_chamfer"]
    rb, zt, bf, bc = p["boss_radius"], p["boss_top"], p["boss_fillet"], p["boss_chamfer"]
    big_r, h, tf, ch = p["radius"], p["height"], p["top_fillet"], p["bed_chamfer"]
    ri, ro, wh, zr = p["cavity_r_in"], p["cavity_r_out"], p["cavity_wall_h"], p["cavity_roof_z"]
    rise = zr - wh  # 45-degree roof flanks
    start = (bore_r + c, zt)
    return start, [
        ("line", (rb - bc, zt)),
        ("line", (rb, zt - bc)),
        ("line", (rb, h + bf)),
        ("arc", _arc_mid((rb + bf, h + bf), bf, 180.0, 270.0), (rb + bf, h)),
        ("line", (big_r - tf, h)),
        ("arc", _arc_mid((big_r - tf, h - tf), tf, 90.0, 0.0), (big_r, h - tf)),
        ("line", (big_r, ch)),
        ("line", (big_r - ch, 0.0)),
        ("line", (ro, 0.0)),
        ("line", (ro, wh)),
        ("line", (ro - rise, zr)),
        ("line", (ri + rise, zr)),
        ("line", (ri, wh)),
        ("line", (ri, 0.0)),
        ("line", (p["clip_pocket_d"] / 2.0, 0.0)),
        ("line", (p["clip_pocket_d"] / 2.0, p["clip_seat_z"])),
        ("line", (bore_r, p["clip_seat_z"])),
        ("line", (bore_r, zt - c)),
        ("line", start),
    ]


def _face(start, segments):
    edges, current = [], start
    for segment in segments:
        if segment[0] == "line":
            edges.append(bd.Line(current, segment[1]))
            current = segment[1]
        else:
            edges.append(bd.ThreePointArc(current, segment[1], segment[2]))
            current = segment[2]
    return bd.Face(bd.Wire(edges))


def build(params: dict) -> bd.Part:
    p = {**PARAMS, **params}
    start, segments = _profile(p)
    body = bd.revolve(bd.Plane.XZ * _face(start, segments), bd.Axis.Z)

    h = p["height"]
    for angle in p["mount_angles"]:
        a = math.radians(angle)
        x, y = p["mount_r"] * math.cos(a), p["mount_r"] * math.sin(a)
        through = bd.SlotOverall(p["mount_travel"] + p["mount_clear_d"], p["mount_clear_d"], rotation=angle)
        cbore = bd.SlotOverall(p["mount_travel"] + p["cbore_d"], p["cbore_d"], rotation=angle)
        body = safe_cut(body, bd.extrude(bd.Pos(x, y, 0) * through, amount=h))
        body = safe_cut(body, bd.extrude(bd.Pos(x, y, h - p["cbore_depth"]) * cbore, amount=p["cbore_depth"]))

    for k in range(4):
        a = math.radians(45.0 + 90.0 * k)
        body = safe_cut(body, bd.Pos(p["foot_r"] * math.cos(a), p["foot_r"] * math.sin(a), 0) * bd.Cylinder(
            p["foot_d"] / 2.0, p["foot_depth"], align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN)
        ))

    if p["engraving"]:
        text = bd.Text(p["engraving"], p["text_size"], font="Arial", font_path=p["font_path"],
                       font_style=bd.FontStyle.BOLD)
        body = safe_cut(body, bd.extrude(bd.Pos(*p["text_at"], h) * text, amount=-p["text_depth"]))
    return body
