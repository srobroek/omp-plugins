"""LMP-0001 Base plate and pivot boss: cad-design reference model, CadQuery 2.8, fidelity F3.

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

`drawing_features` names every final face by its role for the detail drawing.
"""

import math

import cadquery as cq
from cadmodel.safe import safe_cut
from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.GeomAPI import GeomAPI_ProjectPointOnSurf

KERNEL = "cadquery"

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


def build(params: dict) -> cq.Shape:
    p = {**PARAMS, **params}
    start, segments = _profile(p)
    sketch = cq.Workplane("XZ").moveTo(*start)
    for segment in segments:
        sketch = sketch.lineTo(*segment[1]) if segment[0] == "line" else sketch.threePointArc(segment[1], segment[2])
    body = sketch.close().revolve(360.0, (0, 0, 0), (0, 1, 0))

    h = p["height"]
    for angle in p["mount_angles"]:
        a = math.radians(angle)
        center = (p["mount_r"] * math.cos(a), p["mount_r"] * math.sin(a))
        through = (
            cq.Workplane("XY").center(*center)
            .slot2D(p["mount_travel"] + p["mount_clear_d"], p["mount_clear_d"], angle)
            .extrude(h)
        )
        cbore = (
            cq.Workplane("XY").workplane(offset=h - p["cbore_depth"]).center(*center)
            .slot2D(p["mount_travel"] + p["cbore_d"], p["cbore_d"], angle)
            .extrude(p["cbore_depth"])
        )
        body = safe_cut(body, through)
        body = safe_cut(body, cbore)

    for k in range(4):
        a = math.radians(45.0 + 90.0 * k)
        foot = (
            cq.Workplane("XY").center(p["foot_r"] * math.cos(a), p["foot_r"] * math.sin(a))
            .circle(p["foot_d"] / 2.0).extrude(p["foot_depth"])
        )
        body = safe_cut(body, foot)

    if p["engraving"]:
        text = (
            cq.Workplane("XY").workplane(offset=h).center(*p["text_at"])
            .text(p["engraving"], p["text_size"], -p["text_depth"], combine=False, fontPath=p["font_path"], kind="bold")
        )
        body = safe_cut(body, text)
    return body.val()


SUPPORT = {"PLANE": "plane", "CYLINDER": "cylinder", "CONE": "cone", "SPHERE": "sphere", "TORUS": "torus",
           "BEZIER": "bezier", "BSPLINE": "bspline", "REVOLUTION": "revolution", "EXTRUSION": "extrusion",
           "OFFSET": "offset"}
KINDS = {"bed_face": "plane_face", "seat": "bore", "seat_chamfer": "chamfer", "boss_top": "plane_face",
         "boss_chamfer": "chamfer", "boss": "shaft", "boss_root_round": "round", "top_face": "plane_face",
         "top_round": "round", "rim": "shaft", "bed_chamfer": "chamfer", "cavity_outer_wall": "bore",
         "cavity_flanks": "taper", "cavity_roof": "plane_face", "cavity_inner_wall": "shaft", "clip_pocket": "bore",
         "mount_slots": "slot", "mount_counterbores": "slot", "foot_recesses": "bore", "engraving": "engraving"}


def _witness(face: cq.Face) -> dict:
    """A final-surface witness: the centre of the face's largest mesh triangle, projected onto the face."""
    vertices, triangles = face.tessellate(0.01, 0.2)
    a, b, c = max(((vertices[i], vertices[j], vertices[k]) for i, j, k in triangles),
                  key=lambda t: (t[1] - t[0]).cross(t[2] - t[0]).Length)
    centre = (a + b + c) * (1.0 / 3.0)
    near = GeomAPI_ProjectPointOnSurf(centre.toPnt(), BRep_Tool.Surface_s(face.wrapped)).NearestPoint()
    point = cq.Vector(near.X(), near.Y(), near.Z())
    return {"support_type": SUPPORT.get(face.geomType(), "other"), "point_mm": list(point.toTuple()),
            "normal": list(face.normalAt(point).normalized().toTuple())}


def _role(p: dict, face: cq.Face, patch: dict) -> str | None:
    x, y, z = patch["point_mm"]
    normal = cq.Vector(*patch["normal"])
    kind, h = patch["support_type"], p["height"]
    tx, ty = p["text_at"]
    if h - p["text_depth"] - 1e-6 <= z < h - 1e-6 and abs(x - tx) < 3 * p["text_size"] and abs(y - ty) < p["text_size"]:
        return "engraving"
    if kind == "plane" and abs(abs(normal.z) - 1.0) < 1e-6:
        levels = ((0.0, "bed_face"), (h, "top_face"), (p["boss_top"], "boss_top"), (p["clip_seat_z"], "clip_pocket"),
                  (p["cavity_roof_z"], "cavity_roof"), (p["foot_depth"], "foot_recesses"),
                  (h - p["cbore_depth"], "mount_counterbores"), (h - p["text_depth"], "engraving"))
        return next((name for level, name in levels if abs(z - level) < 1e-6), None)
    if kind == "plane":
        return "mount_counterbores" if z > h - p["cbore_depth"] else "mount_slots"
    if kind == "cylinder":
        radius = BRepAdaptor_Surface(face.wrapped).Cylinder().Radius()
        radii = ((p["seat_d"] / 2.0, "seat"), (p["clip_pocket_d"] / 2.0, "clip_pocket"), (p["boss_radius"], "boss"),
                 (p["radius"], "rim"), (p["cavity_r_out"], "cavity_outer_wall"), (p["cavity_r_in"], "cavity_inner_wall"),
                 (p["foot_d"] / 2.0, "foot_recesses"), (p["mount_clear_d"] / 2.0, "mount_slots"),
                 (p["cbore_d"] / 2.0, "mount_counterbores"))
        return next((name for r, name in radii if abs(radius - r) < 1e-6), None)
    if kind == "cone":
        if z > p["boss_top"] - 2.0:
            return "seat_chamfer" if math.hypot(x, y) < p["clip_pocket_d"] else "boss_chamfer"
        return "bed_chamfer" if z < p["bed_chamfer"] + 1e-6 else "cavity_flanks"
    if kind == "torus":
        minor = BRepAdaptor_Surface(face.wrapped).Torus().MinorRadius()
        return "top_round" if abs(minor - p["top_fillet"]) < 1e-6 else "boss_root_round"
    return None


def drawing_features(params: dict, shape: cq.Shape) -> dict:
    """Every final face by its role: datum faces, seat, boss, rounds, cavity, slots, feet and engraving."""
    p = {**PARAMS, **params}
    features: dict[str, list] = {}
    for face in shape.Faces():
        patch = _witness(face)
        name = _role(p, face, patch)
        if name is not None:
            features.setdefault(name, []).append(patch)
    located = {name: {"kind": KINDS[name], "frame": "assembly_zero", "patches": patches}
               for name, patches in features.items()}
    if "engraving" in located and "top_face" in located:
        located["engraving"]["relations"] = {"on": ["top_face"]}
    return located
