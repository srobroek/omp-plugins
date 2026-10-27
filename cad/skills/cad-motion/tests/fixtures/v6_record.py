"""A V6-like coupled mechanism record for the cad-motion tests; kernel-free.

One crank (J-001, 0..720 deg, the only independent joint) drives six centred slider-cranks on two
banks 60 degrees apart (right bank, odd cylinders, at -30 deg; left bank, even, at +30 deg), each a
piston (prismatic along the bank axis) and a rod (revolute about +X through the TDC wrist, a child
of its piston); two cams follow the crank at 1:2; one valve per cylinder follows its bank's cam
through the `lift` table. Every repeated part is one part-local definition placed per cylinder.

Frames: a cylinder's rest frame has its origin at the TDC wrist O + (L + r) n and +Z along the bank
axis n (a rotation about X by the bank angle). Piston, rod and valve definitions are modeled in it:
piston box x, y +-4, z -4..2 (crown at z 2); rod box x, y +-1, z -L+3..-5 (wrist at the origin, crank
end at z -L); valve head box x, y +-1.5, z 3..6, VALVE_GAP mm above the crown at TDC, opening along -n.

Valve timing: a valve's lift peaks (3 mm at cam angle 65 of the table) when its piston is at BDC, so a
correctly phased valve never reaches its piston. `record(misphased=3)` peaks cylinder 3's valve at its
TDC instead, crank 240 deg: the valve then dips into the piston crown, a collision at crank angles
where lift > VALVE_GAP + |displacement|.

`build_fixtures.py` builds the geometry from these constants; the tests write `record()` as
hw/assembly.yaml, `interfaces()` (each valve head at least VALVE_GAP from its piston crown) as
hw/interfaces.yaml, and `PARTS` as hw/parts/<PN>/part.yaml.
"""

from __future__ import annotations

import math

R, L = 13.565, 48.07  # crank radius and rod length, mm (the V6 layout's values)
STROKE = 2 * R
BANK_DEG = 30.0
VALVE_GAP = 1.0  # valve head above the piston crown at TDC with the valve closed, mm
CAM_DISTANCE = L + R + 16.0  # crank axis to cam axis along the bank axis, mm
ROD_LIMIT = 17.0  # deg; covers asin(r / L) = 16.39
LIFT = [[0, 0], [20, 0], [35, 0.75], [50, 2.25], [65, 3], [80, 2.25], [95, 0.75], [110, 0], [360, 0]]
PEAK_CAM_DEG = 65.0
# (cylinder, crank-axis position x mm, bank side -1 right / +1 left, mechanism phase deg)
CYLINDERS = ((1, -41.25, -1, 0.0), (2, -30.75, 1, -120.0), (3, -5.25, -1, 120.0),
             (4, 5.25, 1, 0.0), (5, 30.75, -1, -120.0), (6, 41.25, 1, 120.0))
CAMS = {-1: "cam-right", 1: "cam-left"}
CAM_JOINTS = {-1: "J-031", 1: "J-032"}
PARTS = {
    "VSX-0001": ("Block", "assembly_zero"),
    "VSX-0101": ("Crankshaft", "assembly_zero"),
    "VSX-0201": ("Piston", "part_local"),
    "VSX-0211": ("Connecting rod", "part_local"),
    "VSX-0301": ("Camshaft", "part_local"),
    "VSX-0401": ("Valve", "part_local"),
}


def bank_angle(side: int) -> float:
    return side * BANK_DEG


def bank_axis(side: int) -> tuple[float, float, float]:
    """n: +Z turned about +X by the bank angle."""
    angle = math.radians(bank_angle(side))
    return (0.0, -math.sin(angle), math.cos(angle))


def side_axis(side: int) -> tuple[float, float, float]:
    """t = X x n, where the crankpin is a quarter turn after TDC."""
    n = bank_axis(side)
    return (0.0, -n[2], n[1])


def tdc_wrist(x: float, side: int) -> tuple[float, float, float]:
    n = bank_axis(side)
    return (x, (L + R) * n[1], (L + R) * n[2])


def crankpin_rest(x: float, side: int, phase: float) -> tuple[float, float, float]:
    """The crankpin at crank angle 0: r cos(phase) along n plus r sin(phase) along t."""
    n, t = bank_axis(side), side_axis(side)
    c, s = R * math.cos(math.radians(phase)), R * math.sin(math.radians(phase))
    return (x, c * n[1] + s * t[1], c * n[2] + s * t[2])


def valve_phase(phase: float, at_tdc: bool) -> float:
    """Table phase (cam degrees) that peaks the lift at the piston's BDC, or at its TDC."""
    crank = (-phase if at_tdc else 180.0 - phase) % 360.0  # crank angle of that piston position
    return PEAK_CAM_DEG - crank / 2.0


def _placement(x: float, side: int, distance: float) -> dict:
    n = bank_axis(side)
    return {"translation_mm": [x, distance * n[1], distance * n[2]],
            "rotation": {"axis": [1, 0, 0], "angle_deg": bank_angle(side)}}


def record(misphased: int | None = None) -> dict:
    """The assembly.yaml mapping; `misphased` names a cylinder whose valve peaks at its TDC."""
    occurrences, joints, mechanisms = [], [], []
    joints.append({"id": "J-001", "type": "revolute", "parent": "VSX-0001", "child": "VSX-0101",
                   "axis": [1, 0, 0], "origin": [0, 0, 0], "min": 0, "max": 720, "nominal": 0})
    for side, cam in CAMS.items():
        occurrences.append({"id": cam, "PN": "VSX-0301",
                            "placement": {"translation_mm": _placement(0.0, side, CAM_DISTANCE)["translation_mm"]}})
        n = bank_axis(side)
        joints.append({"id": CAM_JOINTS[side], "type": "revolute", "parent": "VSX-0001", "child": f"@{cam}",
                       "axis": [1, 0, 0], "origin": [0, CAM_DISTANCE * n[1], CAM_DISTANCE * n[2]],
                       "min": 0, "max": 360, "coupling": {"type": "linear", "driver": "J-001", "ratio": 0.5}})
    for cylinder, x, side, phase in CYLINDERS:
        n, wrist = bank_axis(side), list(tdc_wrist(x, side))
        mechanism = f"cylinder-{cylinder}"
        mechanisms.append({"id": mechanism, "type": "slider_crank", "driver": "J-001", "origin_mm": [x, 0, 0],
                           "crank_axis": [1, 0, 0], "bank_axis": list(n), "crank_radius_mm": R,
                           "rod_length_mm": L, "phase_deg": phase})
        for part, pn in (("piston", "VSX-0201"), ("rod", "VSX-0211"), ("valve", "VSX-0401")):
            occurrences.append({"id": f"{part}-{cylinder}", "PN": pn, "placement": _placement(x, side, L + R)})
        joints.append({"id": f"J-01{cylinder}", "type": "prismatic", "parent": "VSX-0001",
                       "child": f"@piston-{cylinder}", "axis": list(n), "origin": wrist, "min": -STROKE, "max": 0,
                       "coupling": {"type": "slider_crank", "mechanism": mechanism, "output": "displacement"}})
        joints.append({"id": f"J-02{cylinder}", "type": "revolute", "parent": f"@piston-{cylinder}",
                       "child": f"@rod-{cylinder}", "axis": [1, 0, 0], "origin": wrist,
                       "min": -ROD_LIMIT, "max": ROD_LIMIT,
                       "coupling": {"type": "slider_crank", "mechanism": mechanism, "output": "rod_angle"}})
        joints.append({"id": f"J-04{cylinder}", "type": "prismatic", "parent": "VSX-0001",
                       "child": f"@valve-{cylinder}", "axis": [-c for c in n], "origin": wrist, "min": 0, "max": 3,
                       "coupling": {"type": "periodic_table", "driver": CAM_JOINTS[side], "profile": "lift",
                                    "phase_deg": valve_phase(phase, cylinder == misphased)}})
    return {
        "occurrences": occurrences,
        "profiles": {"lift": {"input_unit": "deg", "output_unit": "mm", "period_deg": 360,
                              "interpolation": "linear", "samples": LIFT}},
        "mechanisms": mechanisms,
        "subassemblies": [{"id": "engine", "title": "V6 test engine", "parts": ["VSX-0001", "VSX-0101"],
                           "occurrences": [f"@{o['id']}" for o in occurrences]}],
        "joints": joints,
    }


def interfaces(minimum: float = VALVE_GAP) -> dict:
    """The interfaces.yaml mapping: one clearance requirement per cylinder, its valve head at least
    `minimum` mm from its piston crown. The default is the closed valve's gap at TDC, which a
    correctly phased valve keeps exactly."""
    return {"interfaces": [
        {"id": f"IF-{cylinder:03d}", "from": f"valve-{cylinder}", "to": f"piston-{cylinder}", "type": "clearance",
         "description": f"Valve {cylinder} head clears the piston {cylinder} crown through the cycle.",
         "pair": [f"@valve-{cylinder}", f"@piston-{cylinder}"], "min_clearance_mm": minimum}
        for cylinder, *_ in CYLINDERS]}
