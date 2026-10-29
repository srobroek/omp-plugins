# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["cadquery-ocp-novtk==8.0.1.1.0", "pyyaml>=6.0"]
# ///
"""Build a FreeCAD 1.1.4 Assembly from the joint record, simulate it headless, and check the frames:
against the joint limits, or, on a motion plan's frames, against coupling.py's coupled values.

Usage:
    uv run --script skill://cad-flow/scripts/run.py cad-motion/scripts/freecad_assembly.py --hw HW
        (--step ASSEMBLY.step | --parts-dir DIR | --version vN|latest)
        [--attach REF=PARENT_REF ...] [--report-part REF ...] [--time-step 0.01]
        [--freecad FREECADCMD] [--job-dir DIR] [--timeout 600]
    uv run --script skill://cad-flow/scripts/run.py cad-motion/scripts/freecad_assembly.py --hw HW --version vN
        --frames .cad-work/UNIT/frames.json --job-dir .cad-work/UNIT/crosscheck [--start coupled|far-branch]

Inputs and kinematics are pose.py's (same options, same occurrence chain). The job writes one STEP
per part definition into the job directory, imports it once per occurrence into a FreeCAD Assembly,
grounds the chain's ground occurrence, and creates one joint per record joint (revolute ->
Revolute, prismatic -> Slider, fixed -> Fixed) with the joint frame J (origin, Z along axis) in each
object's own frame, P^-1 J (P the rest placement), as its connector placements. FreeCAD generates
the frames; the job records every occurrence's placement per frame.

Limit mode (no --frames): the parts start with every joint at min, one simulation drives every
movable joint with `min + (max - min) * time` over time 0..1, and the limit properties are enabled.
FreeCAD's solver does not enforce joint limits, so this script measures each joint's value per frame
from the parent and child motions (placements with the rest placements stripped) and checks it
against [min, max]; the residual (how far a frame departs from the joint's freedom) is a
solver-consistency check. A record with coupled joints is refused before FreeCAD starts: this
simulation drives every joint independently, so its frames would not be the coupled motion.

Cross-check mode (--frames, written by motion.py plan --frames-out or render --crosscheck freecad):
the parts start at the coupled pose of plan frame 0, and FreeCAD reproduces the plan frames at
time k / (N - 1). Each joint maps to a FreeCAD construct (crosscheck.json `joints[].how`):
    driven     an independent joint: a Motion through the plan's schedule, piecewise linear in time
    solved     a linear coupling between parallel revolutes on one parent: a Belt (ratio > 0) or
               Gears (ratio < 0) joint; a slider_crank: a free Slider and rod Revolute closed by a
               crankpin Revolute, so FreeCAD solves the loop
    expressed  any other law (periodic_table, other linear couplings): a Motion through the law's
               values at the frame times and every profile knot the driver crosses
Only solved joints are independent evidence of the coupling laws. Every movable joint and every
occurrence must agree with coupling.py within 1e-3 deg / 1e-3 mm on every frame; FreeCAD's frame 0
is its pre-simulation pose, so it must report N + 1 frames (a formula FreeCAD rejects silently gives
fewer). `--start far-branch` seeds every slider-crank on its far branch (piston beyond the crank,
rod turned over), a negative control that the comparison must fail. The job directory receives
crosscheck.json and motion.FCStd (the document before simulation, as saved by freecadcmd).

freecadcmd can exit 139 after finishing. The result counts only when the job printed this run's
completion marker and wrote a fresh result file carrying the same run id; a non-zero exit after
that is reported as a warning.

stdout: JSON. stderr: diagnostics.
Exit 0 = all frames within limits (limit mode) or every joint agrees (cross-check), 1 = a limit
violation or joint residual, or a cross-check deviation, 2 = usage or infrastructure error (FreeCAD
missing, job failed, no marker, simulation status not 0, wrong frame count).
"""

from __future__ import annotations

import argparse
import bisect
import importlib.util
import json
import math
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import uuid
from pathlib import Path
from typing import Any
sys.path.insert(0, str(Path(__file__).parents[2] / "cad-analysis" / "scripts"))

from freecad_lookup import find_freecad

POSE_PATH = Path(__file__).with_name("pose.py")
_spec = importlib.util.spec_from_file_location("cad_motion_pose", POSE_PATH)
assert _spec and _spec.loader
pose = importlib.util.module_from_spec(_spec)
sys.modules["cad_motion_pose"] = pose
_spec.loader.exec_module(pose)
coupling = pose.coupling


LIMIT_TOL = {"deg": 1e-3, "mm": 1e-3}
RESIDUAL_TOL_DEG, RESIDUAL_TOL_MM = 1e-3, 1e-3
CROSSCHECK_TOL = {"deg": 1e-3, "mm": 1e-3}
FRAMES_TOL = 1e-9  # a frames file value this far from this record's coupling.py value is from another record
MAX_LISTED = 50

# Runs inside freecadcmd. Reads the spec, never the record, so the kinematics stay ours.
JOB = r'''
import json, os, sys, traceback

SPEC = json.load(open(__SPEC_PATH__, encoding="utf-8"))


def finish(result):
    result["run_id"] = SPEC["run_id"]
    with open(SPEC["result"], "w", encoding="utf-8") as handle:
        json.dump(result, handle)
    print(SPEC["marker"], flush=True)
    sys.stderr.flush()
    os._exit(0)


try:
    import FreeCAD as App
    import Part

    candidates = [os.path.join(root, "Mod", "Assembly") for root in (App.getHomePath(), App.getResourceDir())]
    assembly_dir = next(d for d in candidates if os.path.isfile(os.path.join(d, "CommandCreateSimulation.py")))
    sys.path.insert(0, assembly_dir)
    import importlib.util
    import JointObject
    from PySide import QtCore, QtGui, QtWidgets

    spec = importlib.util.spec_from_file_location(
        "CommandCreateSimulation", os.path.join(assembly_dir, "CommandCreateSimulation.py"))
    Sim = importlib.util.module_from_spec(spec)
    Sim.QtCore, Sim.QtGui, Sim.QtWidgets = QtCore, QtGui, QtWidgets
    Sim.Gui = type("Gui", (), {"Selection": type("Selection", (), {"clearSelection": staticmethod(lambda: None)})})
    spec.loader.exec_module(Sim)

    def placement(pair):
        return App.Placement(App.Vector(*pair[0]), App.Rotation(*pair[1]))

    doc = App.newDocument("CadMotion")
    assembly = doc.addObject("Assembly::AssemblyObject", "Assembly")
    assembly.Type = "Assembly"
    objects = {}
    shapes = {}
    for part in SPEC["parts"]:
        obj = doc.addObject("Part::Feature", "".join(c if c.isalnum() else "_" for c in part["id"]))
        obj.Label = part["name"]
        if part["path"] not in shapes:
            shapes[part["path"]] = Part.read(part["path"])
        obj.Shape = shapes[part["path"]]
        obj.Placement = placement(part["start_placement"])
        assembly.addObject(obj)
        objects[part["id"]] = obj
    doc.recompute()

    group = assembly.newObject("Assembly::JointGroup", "Joints")
    JointObject.GroundedJoint(group.newObject("App::FeaturePython", "Ground"), objects[SPEC["root"]])
    joints = {}
    for record in SPEC["joints"]:
        joint = group.newObject("App::FeaturePython", record["name"])
        JointObject.Joint(joint, JointObject.JointTypes.index(record["kind"]))
        joint.Label = record["label"]
        # The moving object, then [element, vertex]: empty names take the object's own placement.
        joint.Reference1 = (objects[record["a"]], ["", ""])
        joint.Reference2 = (objects[record["b"]], ["", ""])
        joint.Detach1 = True
        joint.Detach2 = True
        joint.Placement1 = placement(record["pa"])
        joint.Placement2 = placement(record["pb"])
        if "radii" in record:
            joint.Distance, joint.Distance2 = record["radii"]
        limits = record.get("limits")
        if limits and record["kind"] == "Revolute":
            joint.EnableAngleMin = joint.EnableAngleMax = True
            joint.AngleMin, joint.AngleMax = limits
        elif limits and record["kind"] == "Slider":
            joint.EnableLengthMin = joint.EnableLengthMax = True
            joint.LengthMin, joint.LengthMax = limits
        joints[record["name"]] = joint
    doc.recompute()
    status_solve = assembly.solve()

    simulation = assembly.newObject("Assembly::SimulationGroup", "Simulations").newObject("App::FeaturePython", "Simulation")
    Sim.Simulation(simulation)
    simulation.aTimeStart, simulation.bTimeEnd, simulation.cTimeStepOutput = 0.0, 1.0, SPEC["time_step"]
    for motion_spec in SPEC["motions"]:
        motion = assembly.newObject("App::FeaturePython", "Motion")
        Sim.Motion(motion, motion_spec["kind"], joints[motion_spec["joint"]], motion_spec["formula"])
        motion.Label = motion_spec["label"]
        simulation.addObject(motion)
    doc.recompute()
    if SPEC.get("fcstd"):
        doc.saveAs(SPEC["fcstd"])
    status_sim = assembly.generateSimulation(simulation)
    count = assembly.numberOfFrames()
    frames = []
    for index in range(count):
        assembly.updateForFrame(index)
        frames.append({oid: [list(obj.Placement.Base), list(obj.Placement.Rotation.Q)] for oid, obj in objects.items()})
    finish({"version": list(App.Version()[:4]), "status_solve": status_solve, "status_sim": status_sim,
            "frames": frames})
except Exception:
    finish({"error": traceback.format_exc()})
'''


def _pair(rigid: Any) -> list[list[float]]:
    """A placement as the job reads it: [base, quaternion (x, y, z, w)]."""
    return [list(rigid.trans), list(rigid.quaternion())]


def joint_frame(origin: Any, axis: Any) -> Any:
    """The joint frame J: `origin`, +Z along `axis` by the shortest arc, as App.Rotation(Z, axis) builds it."""
    z = (0.0, 0.0, 1.0)
    length = math.sqrt(sum(c * c for c in axis))
    a = tuple(c / length for c in axis)
    cross = (z[1] * a[2] - z[2] * a[1], z[2] * a[0] - z[0] * a[2], z[0] * a[1] - z[1] * a[0])
    sine = math.sqrt(sum(c * c for c in cross))
    if sine < 1e-12:
        turn = pose.Rigid.identity() if a[2] > 0 else pose.Rigid.rotation((1.0, 0.0, 0.0), 180.0, (0.0, 0.0, 0.0))
    else:
        turn = pose.Rigid.rotation(tuple(c / sine for c in cross), math.degrees(math.atan2(sine, a[2])), (0.0, 0.0, 0.0))
    return pose.Rigid(turn.rot, tuple(float(c) for c in origin))


def _connector(chain: Any, oid: str, frame: Any) -> list[list[float]]:
    """A joint frame in an occurrence's own frame at the zero pose: P^-1 J."""
    return _pair(chain.rests[oid].inverse() @ frame)


def _name(joint_id: str) -> str:
    return "Joint_" + "".join(c if c.isalnum() else "_" for c in joint_id)


def _number(value: float) -> str:
    """Fixed notation: FreeCAD 1.1.4 formulas accept + - * / ^ sin cos pi time and plain decimals."""
    text = f"{value:.15f}".rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


def motion_formula(joint: Any) -> str:
    """Drive the joint linearly from min at time 0 to max at time 1.

    FreeCAD evaluates an Angular motion formula in radians, unlike the joint's
    AngleMin/AngleMax properties, which are degrees.
    """
    low, span = joint.min, joint.max - joint.min
    if joint.type == "revolute":
        low, span = math.radians(low), math.radians(span)
    return f"{_number(low)} + {_number(span)}*time"


def hinge_formula(ts: list[float], ys: list[float], scale: float = 1.0) -> str:
    """Piecewise-linear f through (ts, ys) on [ts[0], ts[-1]] as y0 + s0 (t - t0) + sum dk h(t - tk), with
    h(x) = (x + |x|) / 2 and |x| = (x^2)^0.5, the functions FreeCAD 1.1.4 accepts; collinear knots dropped."""
    keep = [0]
    for i in range(1, len(ts) - 1):
        a, b = keep[-1], i + 1
        slope = (ys[b] - ys[a]) / (ts[b] - ts[a])
        if abs(ys[a] + slope * (ts[i] - ts[a]) - ys[i]) > 1e-12 * max(1.0, abs(ys[i])):
            keep.append(i)
    keep.append(len(ts) - 1)
    kt, ky = [ts[i] for i in keep], [ys[i] * scale for i in keep]
    slopes = [(ky[i + 1] - ky[i]) / (kt[i + 1] - kt[i]) for i in range(len(kt) - 1)]
    terms = [_number(ky[0]), f"{_number(slopes[0])}*(time-{_number(kt[0])})"]
    for i in range(1, len(slopes)):
        change = slopes[i] - slopes[i - 1]
        if change:
            x = f"(time-{_number(kt[i])})"
            terms.append(f"{_number(change / 2)}*({x}+({x}^2)^0.5)")
    return "+".join(terms).replace("+-", "-")


def job_spec(chain: Any, part_paths: dict[str, Path], names: dict[str, str], run_id: str,
             result: Path, time_step: float) -> dict[str, Any]:
    """The limit-mode job: one object per occurrence id, `part_paths` and `names` per PN."""
    # Parts start at the motion's time-0 pose (every joint at min): solving from
    # the zero pose straight to a start angle far from it can land FreeCAD on
    # the joint's other branch, 180 degrees off.
    start = chain.transforms({j.id: j.min for j in chain.movable})
    joints = []
    for j in chain.joints:
        frame = joint_frame(j.origin, j.axis)
        entry = {"id": j.id, "name": _name(j.id), "label": j.id,
                 "kind": {"fixed": "Fixed", "revolute": "Revolute", "prismatic": "Slider"}[j.type],
                 "a": j.parent, "b": j.child, "pa": _connector(chain, j.parent, frame),
                 "pb": _connector(chain, j.child, frame)}
        if j.movable:
            entry["limits"] = [j.min, j.max]
        joints.append(entry)
    return {
        "run_id": run_id, "marker": f"CAD_MOTION_DONE {run_id}", "result": str(result), "time_step": time_step,
        "root": chain.root,
        "parts": [{"id": oid, "pn": chain.pn(oid), "name": names[chain.pn(oid)], "path": str(part_paths[chain.pn(oid)]),
                   "start_placement": _pair(start[oid])} for oid in chain.ids],
        "joints": joints,
        "motions": [{"joint": _name(j.id), "kind": "Angular" if j.type == "revolute" else "Linear",
                     "formula": motion_formula(j), "label": f"drive {j.id}"} for j in chain.movable],
    }


# --------------------------------------------------------------------------- cross-check mode


def read_frames(path: Path, chain: Any, version: str | None) -> list[dict[str, dict[str, float]]]:
    """A motion.py frames file, each frame re-derived through this record's couplings."""
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise pose.MotionError(f"cannot read --frames {path}: {error}") from error
    if not isinstance(document, dict) or document.get("schema") != 1 or not isinstance(document.get("frames"), list):
        raise pose.MotionError(f"{path}: not a motion.py frames file (schema 1)")
    if version is not None and document.get("version") != version:
        raise pose.MotionError(f"{path} holds frames of {document.get('version')!r}, not {version}")
    if len(document["frames"]) < 2:
        raise pose.MotionError(f"{path}: a cross-check needs at least two frames")
    independent = {j.id for j in chain.independent}
    frames = []
    for index, frame in enumerate(document["frames"]):
        settings = frame.get("settings") if isinstance(frame, dict) else None
        if not isinstance(settings, dict) or set(settings) != independent:
            raise pose.MotionError(f"{path}: frame {index} must set exactly the independent joints {sorted(independent)}")
        values = chain.complete({k: float(v) for k, v in settings.items()})
        recorded = frame.get("values") or {}
        for jid, value in values.items():
            if not isinstance(recorded.get(jid), (int, float)) or abs(recorded[jid] - value) > FRAMES_TOL:
                raise pose.MotionError(f"{path}: frame {index} has {jid} = {recorded.get(jid)!r}, but this record "
                                       f"derives {value!r}; the frames come from another record")
        frames.append({"settings": dict(settings), "values": values})
    return frames


def _far_branch(chain: Any, values: dict[str, float]) -> dict[str, float]:
    """`values` with every slider-crank on its far branch: the piston beyond the crank, the rod turned over."""
    out, flipped = dict(values), False
    for jid, law in chain.couplings.laws.items():
        if isinstance(law, coupling.MechanismOutput):
            m = law.mechanism
            theta = m.theta(values[m.driver])
            h = math.sqrt(m.length ** 2 - (m.radius * math.sin(theta)) ** 2)
            out[jid] = m.radius * math.cos(theta) - h - (m.length + m.radius) if law.output == "displacement" else 180.0
            flipped = True
    if not flipped:
        raise pose.MotionError("--start far-branch needs a slider_crank mechanism")
    return out


def _piecewise_linear_in_time(chain: Any, jid: str) -> bool:
    """Whether `jid`'s value is linear between frames: independent, or linear couplings down to its root."""
    while jid in chain.couplings.laws:
        law = chain.couplings.laws[jid]
        if not isinstance(law, coupling.Linear):
            return False
        jid = law.driver
    return True


def crosscheck_spec(chain: Any, part_paths: dict[str, Path], names: dict[str, str],
                    frames: list[dict[str, dict[str, float]]], run_id: str, result: Path, fcstd: Path,
                    start: str) -> tuple[dict[str, Any], dict[str, str]]:
    """The cross-check job over the plan frames, and how each movable joint maps to FreeCAD."""
    n = len(frames)
    times = [k / (n - 1) for k in range(n)]
    laws = chain.couplings.laws
    first = frames[0]["values"] if start == "coupled" else _far_branch(chain, frames[0]["values"])
    placed = chain.transforms(first)
    joints: list[dict[str, Any]] = []
    motions: list[dict[str, Any]] = []
    mapping: dict[str, str] = {}
    closed = {law.mechanism.id for law in laws.values()
              if isinstance(law, coupling.MechanismOutput) and law.output == "rod_angle"}

    def add(name: str, label: str, kind: str, a: str, b: str, frame_a: Any, frame_b: Any, **extra: Any) -> None:
        joints.append({"name": name, "label": label, "kind": kind, "a": a, "b": b,
                       "pa": _connector(chain, a, frame_a), "pb": _connector(chain, b, frame_b), **extra})

    def settings_at(t: float) -> dict[str, float]:
        k = min(max(bisect.bisect_right(times, t) - 1, 0), n - 2)
        f = (t - times[k]) / (times[k + 1] - times[k])
        a, b = frames[k]["settings"], frames[k + 1]["settings"]
        return {key: a[key] + (b[key] - a[key]) * f for key in a}

    def drive(joint: Any, label: str, ts: list[float], ys: list[float]) -> None:
        scale = math.pi / 180.0 if joint.type == "revolute" else 1.0
        motions.append({"joint": _name(joint.id), "kind": "Angular" if joint.type == "revolute" else "Linear",
                        "formula": hinge_formula(ts, ys, scale), "label": label})

    def express(joint: Any, label: str) -> None:
        """The law's values at the frame times and wherever a periodic table's argument crosses a knot."""
        ts, law = list(times), laws[joint.id]
        if isinstance(law, coupling.PeriodicTable):
            profile = law.profile
            for k in range(n - 1):
                a0 = frames[k]["values"][law.driver] + law.phase
                a1 = frames[k + 1]["values"][law.driver] + law.phase
                if a1 == a0:
                    continue
                lo, hi = min(a0, a1), max(a0, a1)
                for m in range(math.floor(lo / profile.period) - 1, math.ceil(hi / profile.period) + 1):
                    for x in profile.xs:
                        crossing = x + m * profile.period
                        if lo < crossing < hi:
                            ts.append(times[k] + (times[k + 1] - times[k]) * (crossing - a0) / (a1 - a0))
            ts = sorted(set(ts))
        drive(joint, label, ts, [chain.complete(settings_at(t))[joint.id] for t in ts])

    for j in chain.joints:
        frame = joint_frame(j.origin, j.axis)
        add(_name(j.id), j.id, {"fixed": "Fixed", "revolute": "Revolute", "prismatic": "Slider"}[j.type],
            j.parent, j.child, frame, frame)
        if not j.movable:
            continue
        law = laws.get(j.id)
        if law is None:
            drive(j, f"drive {j.id}", times, [f["settings"][j.id] for f in frames])
            mapping[j.id] = "driven (plan schedule)"
        elif isinstance(law, coupling.Linear):
            driver = chain.joint(law.driver)
            dot = sum(a * b for a, b in zip(driver.axis, j.axis))
            if (driver.type == j.type == "revolute" and driver.parent == j.parent and abs(abs(dot) - 1.0) < 1e-9
                    and coupling._line_distance(j.origin, driver.origin, driver.axis) > 1e-6):
                gear = "Belt" if law.ratio * dot > 0 else "Gears"
                add(f"{_name(j.id)}_{gear}", f"{j.id} {gear} {law.ratio:g}", gear, driver.child, j.child,
                    joint_frame(driver.origin, driver.axis), frame, radii=[abs(law.ratio), 1.0])
                mapping[j.id] = f"solved ({gear} ratio {law.ratio:g} to {driver.id})"
            else:
                express(j, f"{j.id} expressed linear")
                mapping[j.id] = "expressed (linear formula; no Belt or Gears fits)"
        elif isinstance(law, coupling.MechanismOutput) and law.mechanism.id in closed:
            mech = law.mechanism
            mapping[j.id] = f"solved (closed loop {mech.id}, {law.output})"
            if law.output == "rod_angle":
                crank = chain.joint(mech.driver).child
                pin = joint_frame(mech.crankpin(0.0), mech.crank_axis)
                rod_end = joint_frame(coupling._add(mech.tdc_wrist, coupling._scale(mech.bank_axis, -mech.length)),
                                      mech.crank_axis)
                add(f"{_name(mech.id)}_closure", f"{mech.id} crankpin closure", "Revolute", crank, j.child, pin, rod_end)
        else:
            exact = _piecewise_linear_in_time(chain, law.driver)
            express(j, f"{j.id} expressed {law.kind}")
            mapping[j.id] = f"expressed ({law.kind}{'' if exact else '; sampled at the frames'})"
    spec = {"run_id": run_id, "marker": f"CAD_MOTION_DONE {run_id}", "result": str(result), "fcstd": str(fcstd),
            "time_step": 1.0 / (n - 1), "root": chain.root,
            "parts": [{"id": oid, "pn": chain.pn(oid), "name": f"{chain.ref(oid)} {names[chain.pn(oid)]}",
                       "path": str(part_paths[chain.pn(oid)]), "start_placement": _pair(placed[oid])}
                      for oid in chain.ids],
            "joints": joints, "motions": motions}
    return spec, mapping


def _turn_degrees(rigid: Any) -> float:
    """The rotation angle of `rigid`, from its quaternion: exact near zero, where acos of the trace floors."""
    x, y, z, _ = rigid.quaternion()
    return math.degrees(2.0 * math.asin(min(1.0, math.sqrt(x * x + y * y + z * z))))


def compare(chain: Any, frames: list[dict[str, dict[str, float]]], solved: list[dict[str, Any]],
            mapping: dict[str, str]) -> dict[str, Any]:
    """FreeCAD's frames against coupling.py per joint and occurrence; FreeCAD frame k + 1 is plan frame k."""
    if len(solved) != len(frames) + 1:
        raise pose.MotionError(f"FreeCAD returned {len(solved)} frames for {len(frames)} plan frames, not "
                               f"{len(frames) + 1}: a motion formula was rejected or the simulation stopped")
    joint_dev = {j.id: 0.0 for j in chain.movable}
    worst_frame = {j.id: 0 for j in chain.movable}
    residual = {j.id: 0.0 for j in chain.joints}
    occurrence = {oid: [0.0, 0.0] for oid in chain.ids}
    previous: dict[str, float] = {}
    for k, (frame, placed) in enumerate(zip(frames, solved[1:])):
        ours = chain.transforms(frame["values"])
        theirs = {oid: pose.Rigid.from_quaternion(q, base) for oid, (base, q) in placed.items()}
        motions = {oid: theirs[oid] @ chain.rests[oid].inverse() for oid in chain.ids}
        for oid in chain.ids:
            occurrence[oid][0] = max(occurrence[oid][0], math.dist(theirs[oid].trans, ours[oid].trans))
            occurrence[oid][1] = max(occurrence[oid][1], _turn_degrees(ours[oid].inverse() @ theirs[oid]))
        for j in chain.joints:
            value, residual_deg, residual_mm = j.measure(motions[j.parent].inverse() @ motions[j.child])
            residual[j.id] = max(residual[j.id], residual_deg, residual_mm)
            if not j.movable:
                continue
            if j.type == "revolute":  # unwrap against the previous frame (the plan's value at frame 0)
                reference = previous.get(j.id, frame["values"][j.id])
                value += 360.0 * round((reference - value) / 360.0)
                previous[j.id] = value
            deviation = abs(value - frame["values"][j.id])
            if deviation > joint_dev[j.id]:
                joint_dev[j.id], worst_frame[j.id] = deviation, k
    findings = []
    for j in chain.movable:
        if joint_dev[j.id] > CROSSCHECK_TOL[j.unit]:
            findings.append({"joint": j.id, "frame": worst_frame[j.id], "deviation": joint_dev[j.id], "unit": j.unit,
                             "how": mapping[j.id],
                             "message": f"{j.id} deviates {joint_dev[j.id]:.6g} {j.unit} from coupling.py at plan frame "
                                        f"{worst_frame[j.id]} ({mapping[j.id]}); a branch flip or a wrong law"})
    for oid, (mm, deg) in occurrence.items():
        if mm > CROSSCHECK_TOL["mm"] or deg > CROSSCHECK_TOL["deg"]:
            findings.append({"occurrence": chain.ref(oid), "deviation_mm": mm, "deviation_deg": deg,
                             "message": f"{chain.ref(oid)} is placed {mm:.6g} mm / {deg:.6g} deg away from pose.py"})
    units = {j.id: j.unit for j in chain.movable}
    return {"status": "fail" if findings else "pass", "tolerance": dict(CROSSCHECK_TOL),
            "frames": {"plan": len(frames), "freecad": len(solved)},
            "max_deviation": {unit: max((d for jid, d in joint_dev.items() if units[jid] == unit), default=0.0)
                              for unit in ("deg", "mm")},
            "joints": {j.id: {"how": mapping[j.id], "unit": j.unit, "max_deviation": joint_dev[j.id],
                              "frame": worst_frame[j.id]} for j in chain.movable},
            "occurrences": {chain.ref(oid): {"max_mm": mm, "max_deg": deg} for oid, (mm, deg) in occurrence.items()},
            "max_residual": residual,
            "independent_evidence": sorted(jid for jid, how in mapping.items() if how.startswith("solved")),
            "findings": findings[:MAX_LISTED]}


def run_crosscheck(args: argparse.Namespace, freecad: Path, version: str | None, started: float) -> int:
    _, chain, definitions = pose.load_inputs(args)
    frames = read_frames(args.frames, chain, version)
    job_dir = args.job_dir
    job_dir.mkdir(parents=True)
    pns = sorted({chain.pn(oid) for oid in chain.ids})
    paths = {pn: job_dir / f"{pn}.step" for pn in pns}
    for pn in pns:
        pose.write_part_step(paths[pn], definitions[pn])
    run_id = uuid.uuid4().hex
    spec, mapping = crosscheck_spec(chain, paths, {pn: definitions[pn].name for pn in pns}, frames, run_id,
                                    job_dir / f"result-{run_id}.json", job_dir / "motion.FCStd", args.start)
    job_started = time.monotonic()
    result, warnings, exit_code = run_job(freecad, job_dir, spec, args.timeout)
    if result.get("status_sim") != 0:
        raise pose.MotionError(f"FreeCAD's generateSimulation returned {result.get('status_sim')} (solve "
                               f"{result.get('status_solve')}): no result")
    report = compare(chain, frames, result["frames"], mapping)
    report = {"status": report["status"], "version": version, "start": args.start,
              "freecad": {"binary": freecad.name, "version": ".".join(result["version"][:3]), "exit_code": exit_code,
                          "warnings": warnings, "status_solve": result.get("status_solve"),
                          "status_sim": result["status_sim"]},
              **{k: v for k, v in report.items() if k != "status"},
              "motions": [{"joint": m["label"], "kind": m["kind"], "formula_chars": len(m["formula"])}
                          for m in spec["motions"]]}
    (job_dir / "crosscheck.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    summary = {**report, "crosscheck": str(job_dir / "crosscheck.json"), "fcstd": str(job_dir / "motion.FCStd"),
               "timings_s": {"freecad": round(time.monotonic() - job_started, 2),
                             "total": round(time.monotonic() - started, 2)}}
    print(json.dumps(summary, indent=2))
    return 1 if report["status"] == "fail" else 0


# --------------------------------------------------------------------------- shared


def run_job(freecad: Path, job_dir: Path, spec: dict[str, Any], timeout: float) -> tuple[dict[str, Any], list[str], int]:
    """Run the job; return (result, warnings, exit_code). Raises MotionError without a trusted result."""
    spec_path = job_dir / "spec.json"
    spec_path.write_text(json.dumps(spec, indent=2), encoding="utf-8")
    job_path = job_dir / "job.py"
    job_path.write_text(JOB.replace("__SPEC_PATH__", json.dumps(str(spec_path))), encoding="utf-8")
    result_path = Path(spec["result"])
    started = time.time()
    try:
        proc = subprocess.run([str(freecad), str(job_path)], cwd=job_dir, capture_output=True, text=True,
                              timeout=timeout, check=False)
    except subprocess.TimeoutExpired as error:
        raise pose.MotionError(f"freecadcmd did not finish within {timeout} s") from error
    tail = "\n".join((proc.stdout + proc.stderr).splitlines()[-20:])
    if spec["marker"] not in proc.stdout.splitlines():
        raise pose.MotionError(f"freecadcmd exited {proc.returncode} without the completion marker:\n{tail}")
    if not result_path.is_file() or result_path.stat().st_mtime < started:
        raise pose.MotionError(f"freecadcmd printed the marker but {result_path} is missing or stale")
    try:
        result = json.loads(result_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise pose.MotionError(f"cannot parse {result_path}: {error}") from error
    if result.get("run_id") != spec["run_id"]:
        raise pose.MotionError(f"{result_path} belongs to another run")
    if "error" in result:
        raise pose.MotionError(f"the FreeCAD job failed:\n{result['error']}")
    warnings = []
    if proc.returncode != 0:
        warnings.append(f"freecadcmd exited {proc.returncode} after writing a complete result (known teardown crash)")
    return result, warnings, proc.returncode


def check_frames(chain: Any, frames: list[dict[str, list[list[float]]]]) -> dict[str, Any]:
    """Measure every joint in every frame; report limits, residuals, and violations.

    A frame holds each occurrence's placement T = D P; the joint is measured on the motions
    D = T P^-1, so a rest placement never reads as joint motion.
    """
    joints: dict[str, dict[str, Any]] = {}
    violations: list[dict[str, Any]] = []
    residuals: list[dict[str, Any]] = []
    range_findings: list[dict[str, Any]] = []
    for joint in chain.joints:
        joints[joint.id] = {"type": joint.type, "unit": joint.unit, "min": joint.min, "max": joint.max,
                            "observed_min": None, "observed_max": None, "violations": 0,
                            "max_residual_deg": 0.0, "max_residual_mm": 0.0}
    for index, frame in enumerate(frames):
        motions = {oid: pose.Rigid.from_quaternion(q, base) @ chain.rests[oid].inverse()
                   for oid, (base, q) in frame.items()}
        for joint in chain.joints:
            value, residual_deg, residual_mm = joint.measure(motions[joint.parent].inverse() @ motions[joint.child])
            entry = joints[joint.id]
            entry["max_residual_deg"] = max(entry["max_residual_deg"], residual_deg)
            entry["max_residual_mm"] = max(entry["max_residual_mm"], residual_mm)
            if residual_deg > RESIDUAL_TOL_DEG or residual_mm > RESIDUAL_TOL_MM:
                residuals.append({"frame": index, "joint": joint.id, "residual_deg": residual_deg, "residual_mm": residual_mm})
            if not joint.movable:
                continue
            entry["observed_min"] = value if entry["observed_min"] is None else min(entry["observed_min"], value)
            entry["observed_max"] = value if entry["observed_max"] is None else max(entry["observed_max"], value)
            tol = LIMIT_TOL[joint.unit]
            if value < joint.min - tol or value > joint.max + tol:
                entry["violations"] += 1
                violations.append({"frame": index, "joint": joint.id, "value": value,
                                   "min": joint.min, "max": joint.max, "unit": joint.unit})
    for joint in chain.movable:
        entry = joints[joint.id]
        tol = LIMIT_TOL[joint.unit]
        if (entry["observed_min"] is None or entry["observed_max"] is None
                or entry["observed_min"] > joint.min + tol
                or entry["observed_max"] < joint.max - tol):
            range_findings.append({"joint": joint.id, "observed_min": entry["observed_min"],
                                   "observed_max": entry["observed_max"], "min": joint.min,
                                   "max": joint.max, "unit": joint.unit, "reason": "observed_range_incomplete"})
    for entry in joints.values():
        for key in ("observed_min", "observed_max", "max_residual_deg", "max_residual_mm"):
            if entry[key] is not None:
                entry[key] = round(entry[key], 6)
    return {"joints": joints, "violations": violations, "residuals": residuals, "range_findings": range_findings}


def frame_placements(frames: list[dict[str, Any]], chain: Any, occurrences: list[str]) -> dict[str, dict[str, Any]]:
    """Start, mid and end placements per reported occurrence, keyed by its reference."""
    picks = {"start": 0, "mid": len(frames) // 2, "end": len(frames) - 1}
    report: dict[str, dict[str, Any]] = {}
    for oid in occurrences:
        report[chain.ref(oid)] = {}
        for label, index in picks.items():
            base, q = frames[index][oid]
            report[chain.ref(oid)][label] = {"frame": index, "base": [round(v, 4) for v in base],
                                             "quaternion": [round(v, 6) for v in q]}
    return report


def refuse_coupled(assembly: Any) -> None:
    """Refuse a record with coupled joints in limit mode: the simulation would drive them independently."""
    couplings = assembly.couplings
    if couplings.laws:
        laws = "; ".join(couplings.describe(jid) for jid in couplings.order)
        raise pose.MotionError(
            f"coupled joints are not supported by the FreeCAD Assembly simulation, which drives every joint "
            f"independently ({laws}); verify coupled motion with pose.py --set on an independent joint and "
            f"sweep.py, which derive every coupled joint from its driver, and cross-check the laws on a motion "
            f"plan's frames with --frames (motion.py render --crosscheck freecad)")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="FreeCAD Assembly simulation with limit checks or a coupling cross-check")
    pose.add_geometry_arguments(parser)
    parser.add_argument("--report-part", action="append", default=[], metavar="REF",
                        help="occurrence whose start/mid/end placements are reported (default: every joint child)")
    parser.add_argument("--time-step", type=float, default=0.01, help="simulation output step over time 0..1")
    parser.add_argument("--freecad", type=Path, help="freecadcmd binary")
    parser.add_argument("--job-dir", type=Path, help="scratch job directory under .cad-work (versioned runs retain solver files automatically)")
    parser.add_argument("--case", default="freecad-assembly", help="case id for the immutable motion bundle")
    parser.add_argument("--replace", action="store_true", help="retain and replace a different recipe")
    parser.add_argument("--timeout", type=float, default=600.0, help="seconds before the FreeCAD process is stopped")
    parser.add_argument("--frames", type=Path, help="motion.py frames file: cross-check the couplings on its frames")
    parser.add_argument("--start", choices=("coupled", "far-branch"), default="coupled",
                        help="cross-check start pose: plan frame 0, or every slider-crank on its far branch")
    args = parser.parse_args(argv)
    started = time.monotonic()
    try:
        version, record_hw, version_dir = None, args.hw, None
        if args.version:
            version, version_dir, record_hw = pose.LAYOUT.built_version(args.hw, args.version)
            args.version, args.version_dir, args.record_hw = version, version_dir, record_hw
            if args.frames is None:
                pose.LAYOUT.resolve(args.hw, "bundle.motion", V=version, S=args.case)
        if args.job_dir is not None:
            args.job_dir = pose.LAYOUT.scratch_path(args.hw, args.job_dir, "--job-dir")
        if args.frames is not None:
            if args.job_dir is None:
                raise pose.MotionError("--frames writes crosscheck.json and motion.FCStd into --job-dir under .cad-work")
            if args.job_dir.exists():
                raise pose.MotionError(f"--job-dir already exists; refusing to overwrite scratch output: {args.job_dir}")
        elif args.start != "coupled":
            raise pose.MotionError("--start applies to the --frames cross-check only")
        if not 0.0 < args.time_step <= 0.5:
            raise pose.MotionError("--time-step must be in (0, 0.5]")
        if not 0 < args.timeout:
            raise pose.MotionError("--timeout must be positive")
        assembly = pose.load_assembly(args.hw, record_hw)
        if args.frames is not None and version:
            args.attach = list(json.loads((version_dir / "manifest.json").read_text(encoding="utf-8")).get("attach") or [])
        if args.frames is None:
            refuse_coupled(assembly)
        freecad = find_freecad(args.freecad)
        if freecad is None:
            raise pose.MotionError("freecadcmd not found; pass --freecad or set FREECADCMD")
        if args.frames is not None:
            return run_crosscheck(args, freecad, version, started)
        if version:
            recipe = {"operation": "freecad_assembly", "case": args.case,
                      "options": {"time_step": args.time_step, "timeout": args.timeout,
                                  "report_part": list(args.report_part), "freecad": {"binary": freecad.name}},
                      "attach": list(args.attach), "inputs_sha256": pose.input_sha256(version_dir)}
            reused = pose.LAYOUT.reusable(args.hw, "bundle.motion", {"V": version, "S": args.case}, recipe,
                                          replace=args.replace)
            if reused is not None:
                summary = json.loads((reused / "result.json").read_text(encoding="utf-8"))
                summary.update(bundle=str(reused), reused=True)
                print(json.dumps(summary, indent=2))
                return 1 if summary.get("status") == "fail" else 0
        _, chain, definitions = pose.load_inputs(args)
        report = ([chain.resolve(ref, "--report-part: ") for ref in args.report_part] if args.report_part
                  else [joint.child for joint in chain.movable])
        retained = version is not None
        temporary = None
        if args.job_dir is not None:
            job_dir = args.job_dir.resolve()
        elif retained:
            job_scratch = Path(args.hw).parent / ".cad-work"
            job_scratch.mkdir(parents=True, exist_ok=True)
            job_dir = Path(tempfile.mkdtemp(prefix="cad-motion-job-", dir=job_scratch))
        else:
            temporary = tempfile.TemporaryDirectory(prefix="cad-motion-")
            job_dir = Path(temporary.name)
        job_dir.mkdir(parents=True, exist_ok=True)
        pns = sorted({chain.pn(oid) for oid in chain.ids})
        paths = {pn: job_dir / f"{pn}.step" for pn in pns}
        for pn in pns:
            pose.write_part_step(paths[pn], definitions[pn])
        run_id = uuid.uuid4().hex
        spec = job_spec(chain, paths, {pn: definitions[pn].name for pn in pns}, run_id,
                        job_dir / f"result-{run_id}.json", args.time_step)
        job_started = time.monotonic()
        result, warnings, exit_code = run_job(freecad, job_dir, spec, args.timeout)
        frames = result["frames"]
        if not frames:
            raise pose.MotionError("FreeCAD generated no frames")
        checks = check_frames(chain, frames)
        moved = any(frames[0][oid] != frames[-1][oid] for oid in chain.ids)
        failed = bool(checks["violations"] or checks["residuals"] or checks["range_findings"])
        summary = {"status": "fail" if failed else "pass",
                   "freecad": {"binary": freecad.name, "version": ".".join(result["version"][:3]),
                               "exit_code": exit_code, "warnings": warnings},
                   "frames": len(frames), "placements_change": moved,
                   "motions": [{"joint": m["label"].removeprefix("drive "), "kind": m["kind"], "formula": m["formula"]}
                               for m in spec["motions"]],
                   "placements": frame_placements(frames, chain, report), "limit_check": checks["joints"],
                   "violations": checks["violations"][:MAX_LISTED],
                   "range_findings": checks["range_findings"][:MAX_LISTED],
                   "residuals": checks["residuals"][:MAX_LISTED],
                   "timings_s": {"freecad": round(time.monotonic() - job_started, 2),
                                 "total": round(time.monotonic() - started, 2)}}
        if version:
            # the job's own inputs and FreeCAD's raw frames; the part STEPs are the version's definitions,
            # already bound by the recipe's input hashes, and the result file's run-id name is per run
            evidence = {"spec.json": job_dir / "spec.json", "job.py": job_dir / "job.py",
                        "freecad-frames.json": Path(spec["result"])}
            stage = pose.LAYOUT.staging(args.hw, "bundle.motion")
            try:
                (stage / "evidence").mkdir()
                for name, source in evidence.items():
                    shutil.copyfile(source, stage / "evidence" / name)
                summary["retained_files"] = [f"evidence/{name}" for name in sorted(evidence)]
                (stage / "result.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
                published = pose.LAYOUT.publish(args.hw, "bundle.motion", {"V": version, "S": args.case}, stage,
                                                recipe=recipe, producer="cad-motion freecad_assembly.py",
                                                status=summary["status"], replace=args.replace)
                summary.update(bundle=str(published.path), reused=published.reused)
            except Exception:
                shutil.rmtree(stage, ignore_errors=True)
                raise
            if args.job_dir is None:
                shutil.rmtree(job_dir, ignore_errors=True)
        elif args.job_dir:
            summary["job_dir"] = str(job_dir)
        if temporary is not None:
            temporary.cleanup()
        print(json.dumps(summary, indent=2))
        return 1 if failed else 0
    except (pose.MotionError, OSError, pose.LAYOUT.LayoutError, pose.LAYOUT.PublishConflict) as error:
        print(f"freecad_assembly: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # an OCCT or FreeCAD failure is infrastructure, never a check result
        traceback.print_exc()
        sys.exit(2)
