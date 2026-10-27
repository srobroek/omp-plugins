"""LMP-0004 Lamp head housing: cad-design reference model, CadQuery 2.8, fidelity F3.

FDM PETG head that tilts on J-003 (axis Y). A 7 mm knuckle (1.5 mm edge fillets) turns
inside the upper link's clevis on the LMP-0009 bushing, heat-set into a through seat with
a +Y counterbore for its head (SPIROL CL8100 M4, DR-004); a loft carries its rounded section into a round neck,
which joins a revolved cap and shade. The revolved profile holds the 4 mm cap roll-over,
a cosmetic split-line groove, the 2.4 mm shade wall (six 0.4 mm perimeters) with a
full-round rim, and the socket boss whose blind hole takes the LMP-0010 M10x1 heat-set
insert for the lampholder nipple (6 mm wall around the insert, DR-004). F3 adds a fluted grip
band on the cap and the cable path from the arm into the socket: a 6 mm run along the
neck that starts on the axis of a 7 mm entry from below. Unequal radii keep the
T-junction regular: with equal radii the two bores' intersection curves cross at two
singular points, and this kernel's cut left an unorientable face there.

Zero pose, assembly coordinates: bushing seat on (360, 0, 40) along Y; the shade axis is
vertical through (430, 0) and opens downward; the insert hole opens down from z 50.

`drawing_features` names every final face by its role for the detail drawing.
"""

import math

import cadquery as cq
from cadmodel.safe import safe_cut, safe_fuse
from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.BRepClass import BRepClass_FaceClassifier
from OCP.GeomAPI import GeomAPI_ProjectPointOnSurf
from OCP.ShapeAnalysis import ShapeAnalysis_Surface
from OCP.TopAbs import TopAbs_IN

KERNEL = "cadquery"
PARAMS = {
    "pivot_origin": [360.0, 0.0, 40.0],
    "knuckle_r": 9.0,
    "knuckle_t": 7.0,
    "knuckle_to_x": 384.0,
    "neck_x": 404.0,
    "neck_r": 8.0,
    "edge_fillet": 1.5,
    "seat_d": 7.77,  # SPIROL CL8100 M4 recommended hole 7.73/7.81, mid-limit; drilled after printing
    "seat_cbore_d": 10.0,  # CL8100 head 9.35/9.60 plus FDM hole tolerance
    "seat_cbore_depth": 1.0,  # CL8100 head T ref
    "bore_chamfer": 0.4,
    "shade_axis_x": 430.0,
    "cap_r": 17.0,
    "cap_wall": 3.0,
    "cap_bottom_z": 34.0,
    "cap_top_z": 66.0,
    "cap_fillet": 4.0,
    "split_z": 50.0,
    "split_depth": 0.6,
    "shade_mid": [35.2, 21.4],  # (r, z) of the dome's mid point
    "rim": [46.0, 2.0],  # (r, z) of the outer rim edge
    "shade_wall": 2.4,
    "socket_boss_r": 12.5,  # In-saiL 6.0 minimum wall around the 12.6 insert
    "socket_boss_z": 50.0,
    "insert_hole_d": 11.95,  # In-saiL QT M10 x 12.7 hole 11.9/12.0, mid-limit
    "insert_hole_depth": 13.7,  # insert L 12.7 + 1 mm (CNC Kitchen heat-set guidance)
    "grip_flutes": 20,
    "grip_r": 0.8,
    "grip_z": [53.0, 60.0],
    "cable_d": 6.0,
    "cable_entry_d": 7.0,  # 1 mm over the run, see the module docstring
    "cable_entry_x": 410.0,
}


def _circle3(a, b, c):
    """Centre and radius of the circle through three (r, z) points."""
    (ax, ay), (bx, by), (cx, cy) = a, b, c
    d = 2.0 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
    uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
    return (ux, uy), math.hypot(ax - ux, ay - uy)


def _toward(point, center, distance):
    dx, dy = center[0] - point[0], center[1] - point[1]
    n = math.hypot(dx, dy)
    return (point[0] + dx / n * distance, point[1] + dy / n * distance)


def _shade_profile(p):
    """Closed (r, z) boundary of the revolved cap and shade, starting on the axis at the top."""
    rc, top, f = p["cap_r"], p["cap_top_z"], p["cap_fillet"]
    ri = rc - p["cap_wall"]
    t = p["shade_wall"]
    p0, p1, p2 = (rc, p["cap_bottom_z"]), tuple(p["shade_mid"]), tuple(p["rim"])
    center, radius = _circle3(p0, p1, p2)
    q0, q1, q2 = (_toward(q, center, t) for q in (p0, p1, p2))
    # Full-round rim: bulge half a wall past the rim along the dome's direction of travel.
    ux, uy = (p2[0] - center[0]) / radius, (p2[1] - center[1]) / radius
    tangent = (uy, -ux) if uy * (p2[0] - p1[0]) - ux * (p2[1] - p1[1]) > 0 else (-uy, ux)
    rim_mid = ((p2[0] + q2[0]) / 2.0 + tangent[0] * t / 2.0, (p2[1] + q2[1]) / 2.0 + tangent[1] * t / 2.0)
    s, sd = p["split_z"], p["split_depth"]
    boss_r, boss_z = p["socket_boss_r"], p["socket_boss_z"]
    ceiling = top - f
    hole_r, hole_top = p["insert_hole_d"] / 2.0, boss_z + p["insert_hole_depth"]
    a = math.radians(45.0)
    return (0.0, top), [
        ("line", (rc - f, top)),
        ("arc", (rc - f + f * math.cos(a), ceiling + f * math.sin(a)), (rc, ceiling)),
        ("line", (rc, s + sd)),
        ("line", (rc - sd, s)),
        ("line", (rc, s - sd)),
        ("line", p0),
        ("arc", p1, p2),
        ("arc", rim_mid, q2),
        ("arc", q1, q0),
        ("line", (ri, q0[1])),
        ("line", (ri, ceiling)),
        ("line", (boss_r, ceiling)),
        ("line", (boss_r, boss_z)),
        ("line", (hole_r, boss_z)),
        ("line", (hole_r, hole_top)),
        ("line", (0.0, hole_top)),
        ("line", (0.0, top)),
    ]


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
    px, _, pz = p["pivot_origin"]
    kr, half_t, kx = p["knuckle_r"], p["knuckle_t"] / 2.0, p["knuckle_to_x"]
    f = p["edge_fillet"]

    knuckle = _outline("XZ", (px, pz - kr), [
        ("line", (kx, pz - kr)),
        ("line", (kx, pz + kr)),
        ("line", (px, pz + kr)),
        ("arc", (px - kr, pz), (px, pz - kr)),
    ]).extrude(half_t, both=True).val()
    rounded = [e for e in knuckle.Edges()
               if not _is_line_along(e, (0, 1, 0)) and not (_is_line_along(e, (0, 0, 1)) and abs(e.Center().x - kx) < 1e-6)]
    knuckle = knuckle.fillet(f, rounded)

    section = cq.Sketch().rect(p["knuckle_t"], 2 * kr).vertices().fillet(f)
    collar = cq.Sketch().circle(p["neck_r"]).moved(cq.Location(cq.Vector(0, 0, p["neck_x"] - kx)))
    neck = cq.Workplane("YZ").workplane(offset=kx).center(0, pz).placeSketch(section, collar).loft()
    stub = cq.Workplane("YZ").workplane(offset=p["neck_x"]).center(0, pz).circle(p["neck_r"]).extrude(p["shade_axis_x"] - p["neck_x"])

    start, segments = _shade_profile(p)
    shade = _outline(cq.Plane((p["shade_axis_x"], 0, 0), (1, 0, 0), (0, -1, 0)), start, segments).revolve(
        360.0, (0, 0, 0), (0, 1, 0)
    )
    body = safe_fuse(cq.Workplane("XY").add(knuckle), neck, stub, shade)
    rc = p["cap_r"]
    z0, z1 = p["grip_z"]
    for k in range(p["grip_flutes"]):
        a = 2.0 * math.pi * k / p["grip_flutes"]
        body = safe_cut(
            body,
            cq.Workplane("XY").workplane(offset=z0)
            .center(p["shade_axis_x"] + rc * math.cos(a), rc * math.sin(a)).circle(p["grip_r"]).extrude(z1 - z0),
        )

    cable_r, entry_r = p["cable_d"] / 2.0, p["cable_entry_d"] / 2.0
    run = cq.Workplane("YZ").workplane(offset=p["cable_entry_x"]).center(0, pz).circle(cable_r).extrude(
        p["shade_axis_x"] - p["cable_entry_x"]
    )
    entry = cq.Workplane("XY").workplane(offset=pz - 2 * p["neck_r"]).center(p["cable_entry_x"], 0).circle(entry_r).extrude(
        2 * p["neck_r"]
    )
    seat_r, cbore_r, cbore_y = p["seat_d"] / 2.0, p["seat_cbore_d"] / 2.0, half_t - p["seat_cbore_depth"]
    seat = cq.Workplane("XZ").center(px, pz).circle(seat_r).extrude(2 * half_t, both=True)
    # The counterbore runs 1 mm past the +Y face, so its rim is the knuckle face's own edge.
    cbore = cq.Solid.makeCylinder(cbore_r, half_t + 1.0 - cbore_y, cq.Vector(px, cbore_y, pz), cq.Vector(0, 1, 0))
    body = safe_cut(body, run)
    body = safe_cut(body, entry)
    body = safe_cut(body, seat, cbore).val()
    # Chamfer the seat entry on the -Y face and the counterbore rim on the +Y face.
    entries = [e for e in body.Edges() if e.geomType() == "CIRCLE"
               and abs(e.arcCenter().x - px) < 1e-3 and abs(e.arcCenter().z - pz) < 1e-3
               and ((abs(e.radius() - seat_r) < 1e-6 and abs(e.arcCenter().y + half_t) < 1e-3)
                    or (abs(e.radius() - cbore_r) < 1e-6 and abs(e.arcCenter().y - half_t) < 1e-3))]
    return body.chamfer(p["bore_chamfer"], None, entries)


SUPPORT = {"PLANE": "plane", "CYLINDER": "cylinder", "CONE": "cone", "SPHERE": "sphere", "TORUS": "torus",
           "BEZIER": "bezier", "BSPLINE": "bspline", "REVOLUTION": "revolution", "EXTRUSION": "extrusion",
           "OFFSET": "offset"}
KINDS = {"knuckle_seating_face": "plane_face", "knuckle_far_face": "plane_face", "knuckle_upper_flat": "plane_face",
         "knuckle_lower_flat": "plane_face", "knuckle_round": "shaft", "knuckle_rounds": "round", "seat": "bore",
         "seat_counterbore": "bore", "counterbore_floor": "plane_face", "bore_entry_chamfers": "chamfer",
         "neck_transition": "surface", "neck": "shaft", "neck_end": "plane_face", "cable_run": "bore",
         "cable_entry": "bore", "cable_entry_floor": "plane_face", "cap": "shaft", "cap_roll": "round",
         "cap_top": "plane_face", "cap_inner_wall": "bore", "cap_ceiling": "plane_face", "socket_boss": "shaft",
         "boss_face": "plane_face", "insert_hole": "bore", "grip_flutes": "bore", "flute_lower_ends": "plane_face",
         "flute_upper_ends": "plane_face", "shade_profile": "surface", "rim_round": "round"}


def _witness(face: cq.Face) -> dict:
    """A final-surface witness: the centre of the largest mesh triangle whose projection lies inside the face.

    A chord triangle across a tight round has its centre inside the tube, where the nearest surface point can lie
    outside the face's trim; the next triangle is tried then.
    """
    vertices, triangles = face.tessellate(0.01, 0.2)
    surface = BRep_Tool.Surface_s(face.wrapped)
    uv = ShapeAnalysis_Surface(surface)

    def area(t):
        return (vertices[t[1]] - vertices[t[0]]).cross(vertices[t[2]] - vertices[t[0]]).Length

    for i, j, k in sorted(triangles, key=area, reverse=True):
        centre = (vertices[i] + vertices[j] + vertices[k]) * (1.0 / 3.0)
        near = GeomAPI_ProjectPointOnSurf(centre.toPnt(), surface).NearestPoint()
        if BRepClass_FaceClassifier(face.wrapped, uv.ValueOfUV(near, 1e-7), 1e-7).State() == TopAbs_IN:
            point = cq.Vector(near.X(), near.Y(), near.Z())
            return {"support_type": SUPPORT.get(face.geomType(), "other"), "point_mm": list(point.toTuple()),
                    "normal": list(face.normalAt(point).normalized().toTuple())}
    raise ValueError(f"no witness point inside a {face.geomType()} face")


def _role(p: dict, face: cq.Face, patch: dict) -> str | None:
    x, y, z = patch["point_mm"]
    normal = cq.Vector(*patch["normal"])
    kind = patch["support_type"]
    px, _, pz = p["pivot_origin"]
    half_t = p["knuckle_t"] / 2.0
    if kind == "plane" and abs(abs(normal.z) - 1.0) < 1e-6:
        levels = ((pz - p["knuckle_r"], "knuckle_lower_flat"), (pz + p["knuckle_r"], "knuckle_upper_flat"),
                  (pz, "cable_entry_floor"), (p["socket_boss_z"], "boss_face"), (p["grip_z"][0], "flute_lower_ends"),
                  (p["grip_z"][1], "flute_upper_ends"), (p["cap_top_z"] - p["cap_fillet"], "cap_ceiling"),
                  (p["socket_boss_z"] + p["insert_hole_depth"], "insert_hole"), (p["cap_top_z"], "cap_top"))
        level = next((name for level, name in levels if abs(z - level) < 1e-6), None)
        inside_shade = z < p["cap_bottom_z"] and abs(x - p["shade_axis_x"]) < p["cap_r"]  # the cap-wall foot
        return level or ("shade_profile" if inside_shade else None)
    if kind == "plane" and abs(abs(normal.y) - 1.0) < 1e-6:
        levels = ((half_t, "knuckle_seating_face"), (-half_t, "knuckle_far_face"),
                  (half_t - p["seat_cbore_depth"], "counterbore_floor"))
        return next((name for level, name in levels if abs(y - level) < 1e-6), None)
    if kind == "plane" and abs(abs(normal.x) - 1.0) < 1e-6:
        levels = ((p["cable_entry_x"], "cable_run"), (p["shade_axis_x"], "neck_end"))
        return next((name for level, name in levels if abs(x - level) < 1e-6), None)
    if kind == "cylinder":
        radius = BRepAdaptor_Surface(face.wrapped).Cylinder().Radius()
        radii = ((p["seat_d"] / 2.0, "seat"), (p["seat_cbore_d"] / 2.0, "seat_counterbore"),
                 (p["knuckle_r"], "knuckle_round"), (p["edge_fillet"], "knuckle_rounds"), (p["neck_r"], "neck"),
                 (p["cable_d"] / 2.0, "cable_run"), (p["cable_entry_d"] / 2.0, "cable_entry"), (p["cap_r"], "cap"),
                 (p["cap_r"] - p["cap_wall"], "cap_inner_wall"), (p["socket_boss_r"], "socket_boss"),
                 (p["insert_hole_d"] / 2.0, "insert_hole"), (p["grip_r"], "grip_flutes"))
        return next((name for r, name in radii if abs(radius - r) < 1e-6), None)
    if kind == "torus":
        minor = BRepAdaptor_Surface(face.wrapped).Torus().MinorRadius()
        minors = ((p["edge_fillet"], "knuckle_rounds"), (p["cap_fillet"], "cap_roll"),
                  (p["shade_wall"] / 2.0, "rim_round"))
        return next((name for r, name in minors if abs(minor - r) < 1e-6), None)
    if kind == "cone":  # seat and counterbore entry chamfers at the pivot; the split-line groove on the cap
        return "bore_entry_chamfers" if abs(x - px) < p["knuckle_r"] else "shade_profile"
    return {"bspline": "neck_transition", "revolution": "shade_profile"}.get(kind)


def drawing_features(params: dict, shape: cq.Shape) -> dict:
    """Every final face by its role: knuckle, bushing seat, neck, cable path, cap, insert hole, flutes and shade."""
    p = {**PARAMS, **params}
    features: dict[str, list] = {}
    for face in shape.Faces():
        patch = _witness(face)
        name = _role(p, face, patch)
        if name is not None:
            features.setdefault(name, []).append(patch)
    return {name: {"kind": KINDS[name], "frame": "assembly_zero", "patches": patches}
            for name, patches in features.items()}
