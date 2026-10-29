# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["cadquery-ocp-novtk==8.0.1.1.0", "pyyaml>=6.0"]
# ///
"""Build a FreeCAD 1.1.4 Assembly from the joint record, simulate it headless,
and check every frame against the joint limits.

Usage:
    uv run --script skill://cad-flow/scripts/run.py cad-motion/scripts/freecad_assembly.py --hw HW
        (--step ASSEMBLY.step | --parts-dir DIR | --version vN|latest)
        [--attach REF=PARENT_REF ...] [--report-part REF ...] [--time-step 0.01]
        [--freecad FREECADCMD] [--job-dir DIR] [--timeout 600]

Inputs and kinematics are pose.py's (same options, same occurrence chain). The
job: writes one STEP per part definition into the job directory, imports it
once per occurrence into a FreeCAD Assembly at the occurrence's placement,
grounds the chain's ground occurrence, creates one joint per record joint
(revolute -> Revolute, prismatic -> Slider, fixed -> Fixed) with the joint
frame J (origin, Z along axis) expressed in each object's own frame,
P_parent^-1 J and P_child^-1 J (P the rest placement), as its connector
placements and the limit properties enabled, and adds one simulation that
drives every movable joint with `min + (max - min) * time` over time 0..1.
FreeCAD generates the frames; the job records every occurrence's placement
per frame.

FreeCAD's solver does not enforce joint limits, so this script measures each
joint's value per frame from the parent and child motions (placements with the
rest placements stripped) and checks it against [min, max]. It also reports
the residual (how far a frame departs from the joint's freedom) as a
solver-consistency check.

freecadcmd can exit 139 after finishing. The result counts only when the job
printed this run's completion marker and wrote a fresh result file carrying
the same run id; a non-zero exit after that is reported as a warning.

A record with coupled joints (coupling.py) is refused before FreeCAD starts:
the Assembly simulation drives every joint independently and has no coupling
callback, so its frames would not be the coupled motion. pose.py and sweep.py
derive coupled joints from their drivers.

stdout: JSON. stderr: diagnostics.
Exit 0 = all frames within limits, 1 = a limit violation or joint residual,
2 = usage or infrastructure error (FreeCAD missing, job failed, no marker).
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import os
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


LIMIT_TOL = {"deg": 1e-3, "mm": 1e-3}
RESIDUAL_TOL_DEG, RESIDUAL_TOL_MM = 1e-3, 1e-3
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

    doc = App.newDocument("CadMotion")
    assembly = doc.addObject("Assembly::AssemblyObject", "Assembly")
    assembly.Type = "Assembly"
    objects = {}
    rest_inverse = {}
    shapes = {}
    for part in SPEC["parts"]:
        obj = doc.addObject("Part::Feature", "".join(c if c.isalnum() else "_" for c in part["id"]))
        obj.Label = part["name"]
        if part["path"] not in shapes:
            shapes[part["path"]] = Part.read(part["path"])
        obj.Shape = shapes[part["path"]]
        base, quaternion = part["start_placement"]
        obj.Placement = App.Placement(App.Vector(*base), App.Rotation(*quaternion))
        base, quaternion = part["rest_inverse"]
        rest_inverse[part["id"]] = App.Placement(App.Vector(*base), App.Rotation(*quaternion))
        assembly.addObject(obj)
        objects[part["id"]] = obj
    doc.recompute()

    group = assembly.newObject("Assembly::JointGroup", "Joints")
    JointObject.GroundedJoint(group.newObject("App::FeaturePython", "Ground"), objects[SPEC["root"]])
    kinds = {"fixed": 0, "revolute": 1, "prismatic": 3}
    joints = {}
    for record in SPEC["joints"]:
        joint = group.newObject("App::FeaturePython", record["name"])
        JointObject.Joint(joint, kinds[record["type"]])
        joint.Label = record["id"]
        joint.Reference1 = (objects[record["parent"]], [""])
        joint.Reference2 = (objects[record["child"]], [""])
        # The joint frame J is in assembly coordinates at the zero pose; each connector is J in its
        # object's own frame, P^-1 J, so a differently placed occurrence of one definition still meets it.
        frame = App.Placement(App.Vector(*record["origin"]),
                              App.Rotation(App.Vector(0, 0, 1), App.Vector(*record["axis"])))
        joint.Detach1 = True
        joint.Detach2 = True
        joint.Placement1 = rest_inverse[record["parent"]].multiply(frame)
        joint.Placement2 = rest_inverse[record["child"]].multiply(frame)
        if record["type"] == "revolute":
            joint.EnableAngleMin = joint.EnableAngleMax = True
            joint.AngleMin, joint.AngleMax = record["min"], record["max"]
        elif record["type"] == "prismatic":
            joint.EnableLengthMin = joint.EnableLengthMax = True
            joint.LengthMin, joint.LengthMax = record["min"], record["max"]
        joints[record["id"]] = joint
    doc.recompute()
    assembly.solve()

    simulation = assembly.newObject("Assembly::SimulationGroup", "Simulations").newObject("App::FeaturePython", "Simulation")
    Sim.Simulation(simulation)
    simulation.aTimeStart, simulation.bTimeEnd, simulation.cTimeStepOutput = 0.0, 1.0, SPEC["time_step"]
    for motion_spec in SPEC["motions"]:
        motion = assembly.newObject("App::FeaturePython", "Motion")
        Sim.Motion(motion, motion_spec["kind"], joints[motion_spec["joint"]], motion_spec["formula"])
        simulation.addObject(motion)
    doc.recompute()
    assembly.solve()
    assembly.generateSimulation(simulation)
    count = assembly.numberOfFrames()
    frames = []
    for index in range(count):
        assembly.updateForFrame(index)
        frames.append({oid: [list(obj.Placement.Base), list(obj.Placement.Rotation.Q)] for oid, obj in objects.items()})
    finish({"version": list(App.Version()[:4]), "frames": frames})
except Exception:
    finish({"error": traceback.format_exc()})
'''




def motion_formula(joint: Any) -> str:
    """Drive the joint linearly from min at time 0 to max at time 1.

    FreeCAD evaluates an Angular motion formula in radians, unlike the joint's
    AngleMin/AngleMax properties, which are degrees.
    """
    low, span = joint.min, joint.max - joint.min
    if joint.type == "revolute":
        low, span = math.radians(low), math.radians(span)
    return f"{low!r} + {span!r}*time"


def job_spec(chain: Any, part_paths: dict[str, Path], names: dict[str, str], run_id: str,
             result: Path, time_step: float) -> dict[str, Any]:
    """The FreeCAD job: one object per occurrence id, `part_paths` and `names` per PN."""
    # Parts start at the motion's time-0 pose (every joint at min): solving from
    # the zero pose straight to a start angle far from it can land FreeCAD on
    # the joint's other branch, 180 degrees off.
    start = chain.transforms({j.id: j.min for j in chain.movable})
    return {
        "run_id": run_id,
        "marker": f"CAD_MOTION_DONE {run_id}",
        "result": str(result),
        "time_step": time_step,
        "root": chain.root,
        "parts": [
            {"id": oid, "pn": chain.pn(oid), "name": names[chain.pn(oid)], "path": str(part_paths[chain.pn(oid)]),
             "start_placement": [list(start[oid].trans), list(start[oid].quaternion())],
             "rest_inverse": [list(chain.rests[oid].inverse().trans), list(chain.rests[oid].inverse().quaternion())]}
            for oid in chain.ids
        ],
        "joints": [
            {"id": j.id, "name": "Joint_" + "".join(c if c.isalnum() else "_" for c in j.id), "type": j.type,
             "parent": j.parent, "child": j.child, "origin": list(j.origin), "axis": list(j.axis),
             "min": j.min, "max": j.max}
            for j in chain.joints
        ],
        "motions": [
            {"joint": j.id, "kind": "Angular" if j.type == "revolute" else "Linear", "formula": motion_formula(j)}
            for j in chain.movable
        ],
    }


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
    """Refuse a record with coupled joints: the simulation would drive them independently."""
    couplings = assembly.couplings
    if couplings.laws:
        laws = "; ".join(couplings.describe(jid) for jid in couplings.order)
        raise pose.MotionError(
            f"coupled joints are not supported by the FreeCAD Assembly simulation, which drives every joint "
            f"independently ({laws}); verify coupled motion with pose.py --set on an independent joint and "
            f"sweep.py, which derive every coupled joint from its driver")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="FreeCAD Assembly simulation with limit checks")
    pose.add_geometry_arguments(parser)
    parser.add_argument("--report-part", action="append", default=[], metavar="REF",
                        help="occurrence whose start/mid/end placements are reported (default: every joint child)")
    parser.add_argument("--time-step", type=float, default=0.01, help="simulation output step over time 0..1")
    parser.add_argument("--freecad", type=Path, help="freecadcmd binary")
    parser.add_argument("--job-dir", type=Path, help="scratch job directory under .cad-work (versioned runs retain solver files automatically)")
    parser.add_argument("--case", default="freecad-assembly", help="case id for the immutable motion bundle")
    parser.add_argument("--replace", action="store_true", help="retain and replace a different recipe")
    parser.add_argument("--timeout", type=float, default=600.0, help="seconds before the FreeCAD process is stopped")
    args = parser.parse_args(argv)
    started = time.monotonic()
    try:
        version, record_hw, version_dir = None, args.hw, None
        if args.version:
            version, version_dir, record_hw = pose.LAYOUT.built_version(args.hw, args.version)
            args.version, args.version_dir, args.record_hw = version, version_dir, record_hw
            pose.LAYOUT.resolve(args.hw, "bundle.motion", V=version, S=args.case)
        if args.job_dir is not None:
            args.job_dir = pose.LAYOUT.scratch_path(args.hw, args.job_dir, "--job-dir")
        if not 0.0 < args.time_step <= 0.5:
            raise pose.MotionError("--time-step must be in (0, 0.5]")
        if not 0 < args.timeout:
            raise pose.MotionError("--timeout must be positive")
        freecad = find_freecad(args.freecad)
        if freecad is None:
            raise pose.MotionError("freecadcmd not found; pass --freecad or set FREECADCMD")
        assembly = pose.load_assembly(args.hw, record_hw)
        refuse_coupled(assembly)
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
                   "frames": len(frames), "placements_change": moved, "motions": spec["motions"],
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
