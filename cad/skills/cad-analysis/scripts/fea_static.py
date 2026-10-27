#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["pyyaml>=6.0"]
# ///
"""Run a static linear FreeCAD FEM analysis from a case YAML file."""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import uuid
from pathlib import Path
from typing import Any

import yaml

from fea_part_selection import OCCURRENCE_REF
from freecad_lookup import find_freecad


class CaseError(ValueError):
    """Invalid case input or unusable solver output."""


def error(message: str, *, code: str = "invalid_case") -> dict[str, Any]:
    return {"status": "error", "error": {"code": code, "message": message}}

def apply_required_safety_factor(result: dict[str, Any], required: float | None) -> dict[str, Any]:
    """Mark a completed solve failed only when its requested yield margin is missed."""
    factor = result.get("safety_factor_yield")
    result["required_safety_factor"] = required
    result["status"] = "fail" if required is not None and factor is not None and factor < required else "pass"
    return result


def result_exit_code(result: dict[str, Any]) -> int:
    """Map completed checks to CLI codes; malformed or absent results are no-result."""
    return {"pass": 0, "fail": 1}.get(result.get("status"), 2)


def selector(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict) or len(value) != 1:
        raise CaseError(f"{name} must contain exactly one of indices or plane")
    if "indices" in value:
        indices = value["indices"]
        if not isinstance(indices, list) or not indices or any(
            not isinstance(index, int) or isinstance(index, bool) or index < 1 for index in indices
        ):
            raise CaseError(f"{name}.indices must be non-empty 1-based positive integers")
        return {"indices": indices}
    plane = value.get("plane")
    if not isinstance(plane, dict) or plane.get("axis") not in ("x", "y", "z"):
        raise CaseError(f"{name}.plane must specify axis x, y, or z")
    for key in ("value", "tolerance"):
        number = plane.get(key)
        if not isinstance(number, (int, float)) or isinstance(number, bool) or not math.isfinite(number):
            raise CaseError(f"{name}.plane.{key} must be a finite number in mm")
    if plane["tolerance"] < 0:
        raise CaseError(f"{name}.plane.tolerance must be non-negative")
    return {"plane": plane}

def selected_face_indices(face_count: int, selector: dict[str, Any], faces: Any = None) -> list[int]:
    """Resolve a selector against a shape, failing when no face matches."""
    if "indices" in selector:
        indices = selector["indices"]
    else:
        plane = selector["plane"]
        axis = plane["axis"].upper()
        target = float(plane["value"])
        tolerance = float(plane["tolerance"])
        indices = []
        for index, face in enumerate(faces or (), 1):
            bounds = face.BoundBox
            low, high = getattr(bounds, axis + "Min"), getattr(bounds, axis + "Max")
            if abs(low - target) <= tolerance and abs(high - target) <= tolerance:
                indices.append(index)
    if not indices:
        raise CaseError("face selector matched no faces")
    if any(index > face_count for index in indices):
        raise CaseError("face index is out of range")
    return indices


def load_case(path: Path) -> dict[str, Any]:
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise CaseError(f"cannot read case YAML: {exc}") from exc
    if not isinstance(raw, dict):
        raise CaseError("case YAML must contain a mapping")
    step_value = raw.get("step")
    if not isinstance(step_value, str) or not step_value:
        raise CaseError("step must be a non-empty path")
    step = Path(step_value)
    if not step.is_absolute():
        step = (path.parent / step).resolve()
    if not step.is_file():
        raise CaseError(f"STEP file does not exist: {step}")
    material = raw.get("material")
    if not isinstance(material, dict):
        raise CaseError("material must be a mapping")
    for key in ("E", "nu", "density", "yield"):
        value = material.get(key)
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
            raise CaseError(f"material.{key} must be a finite number")
    if material["E"] <= 0 or material["density"] <= 0 or material["yield"] <= 0:
        raise CaseError("material E, density, and yield must be positive")
    if not 0 < material["nu"] < 0.5:
        raise CaseError("material.nu must be between 0 and 0.5")
    size = raw.get("mesh_size")
    if not isinstance(size, (int, float)) or isinstance(size, bool) or not math.isfinite(size) or size <= 0:
        raise CaseError("mesh_size must be a positive finite number in mm")
    part = raw.get("part")
    if part is not None and (not isinstance(part, str) or not part):
        raise CaseError("part must be a non-empty part number")
    solid_index = raw.get("solid_index")
    if solid_index is not None and (
        not isinstance(solid_index, int) or isinstance(solid_index, bool) or solid_index < 1
    ):
        raise CaseError("solid_index must be a positive 1-based integer")
    occurrence = raw.get("occurrence")
    if occurrence is not None and (not isinstance(occurrence, str) or OCCURRENCE_REF.fullmatch(occurrence) is None):
        raise CaseError('occurrence must be one occurrence reference "@id"; select a part placed once by part')
    selectors = [key for key in ("part", "occurrence", "solid_index") if raw.get(key) is not None]
    if len(selectors) > 1:
        raise CaseError(f"{' and '.join(selectors)} are mutually exclusive")
    required_safety_factor = raw.get("required_safety_factor")
    if required_safety_factor is not None and (
        not isinstance(required_safety_factor, (int, float))
        or isinstance(required_safety_factor, bool)
        or not math.isfinite(required_safety_factor)
        or required_safety_factor <= 0
    ):
        raise CaseError("required_safety_factor must be a positive finite number")
    if "pose" in raw:
        pose = raw["pose"]
        if not isinstance(pose, dict) or not pose or any(
            not isinstance(joint, str) or not joint
            or not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value)
            for joint, value in pose.items()
        ):
            raise CaseError("pose must map joint IDs to finite numeric values")
    raw["fixed_faces"] = selector(raw.get("fixed_faces"), "fixed_faces")
    loads = raw.get("loads")
    if not isinstance(loads, list) or not loads:
        raise CaseError("loads must be a non-empty list")
    for index, load in enumerate(loads):
        if not isinstance(load, dict):
            raise CaseError(f"loads[{index}] must be a mapping")
        load["selector"] = selector(load.get("selector"), f"loads[{index}].selector")
        force = load.get("force")
        if not isinstance(force, list) or len(force) != 3 or any(
            not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v) for v in force
        ):
            raise CaseError(f"loads[{index}].force must be three finite components in N")
        if not any(force):
            raise CaseError(f"loads[{index}].force must not be zero")
    raw["_step"] = str(step)
    return raw


def run_directory(case_path: Path, run_id: str) -> Path:
    """Return the isolated working directory for one case run."""
    return case_path.parent.resolve() / "runs" / run_id


def run_job(case_path: Path, case: dict[str, Any], timeout: float = 600.0) -> tuple[dict[str, Any], int]:
    run_id = uuid.uuid4().hex
    run_dir = run_directory(case_path, run_id)
    run_dir.mkdir(parents=True, exist_ok=True)
    job_path = run_dir / f"fea_static_{run_id}.py"
    marker_path = run_dir / f"fea_static_{run_id}.json"
    output_path = case_path.parent.resolve() / "results.json"
    job = {
        "run_id": run_id,
        "step": case["_step"],
        "part": case.get("part"),
        "occurrence": case.get("occurrence"),
        "solid_index": case.get("solid_index"),
        "required_safety_factor": case.get("required_safety_factor"),
        "pose": case.get("pose"),
        "selection_module": str(Path(__file__).with_name("fea_part_selection.py").resolve()),
        "material": case["material"],
        "fixed_faces": case["fixed_faces"],
        "loads": case["loads"],
        "mesh_size": case["mesh_size"],
        "output": str(marker_path),
        "run_directory": str(run_dir),
    }
    # JSON is data, not Python source: the generated job loads it as a literal.
    job_json = json.dumps(job)
    script = f'''import json, os, re, shutil, sys, time, math
import FreeCAD as App, Part, Import, ObjectsFem
from femmesh.gmshtools import GmshTools
from femtools.ccxtools import CcxTools
JOB=json.loads({job_json!r})
sys.path.insert(0, os.path.dirname(JOB["selection_module"]))
from fea_part_selection import select_occurrence, select_solid_index
def selected_faces(obj, selector):
    if "indices" in selector:
        indices=selector["indices"]
    else:
        p=selector["plane"]; axis=p["axis"].upper(); target=float(p["value"]); tol=float(p["tolerance"])
        indices=[]
        for i, face in enumerate(obj.Shape.Faces, 1):
            bb=face.BoundBox
            lo=getattr(bb, axis+"Min"); hi=getattr(bb, axis+"Max")
            if abs(lo-target)<=tol and abs(hi-target)<=tol: indices.append(i)
    if not indices: raise RuntimeError("face selector matched no faces")
    if any(i > len(obj.Shape.Faces) for i in indices): raise RuntimeError("face index is out of range")
    return [(obj, "Face%d" % i) for i in indices]
def import_components(path, doc):
    # One object per STEP component, labelled by its component name (an explicit occurrence's ends
    # [@id]) and placed once by its own placement. UseBaseName is a user preference: it is changed
    # in memory only and restored before FreeCAD saves preferences at exit.
    params=App.ParamGet("User parameter:BaseApp/Preferences/Mod/Import")
    had="UseBaseName" in params.GetBools(); previous=params.GetBool("UseBaseName", True)
    params.SetBool("UseBaseName", False)
    try: Import.insert(path, doc.Name, useLinkGroup=True)
    finally:
        if had: params.SetBool("UseBaseName", previous)
        else: params.RemBool("UseBaseName")
def placed_shape(obj):
    # The object's shape at its own placement, then at each enclosing assembly's, each applied once.
    shape=Part.getShape(obj); group=obj
    while True:
        parents=[p for p in group.InList if p.TypeId in ("App::LinkGroup", "App::Part")]
        if not parents: return shape
        group=parents[0]; shape=shape.copy(); shape.Placement=group.Placement.multiply(shape.Placement)
def selected_occurrence(doc):
    import_components(JOB["step"], doc); doc.recompute()
    objects=list(doc.Objects)
    try: source=objects[select_occurrence([o.Label for o in objects], JOB["occurrence"])]
    except ValueError as e: raise RuntimeError(str(e))
    solids=placed_shape(source).Solids
    if len(solids) != 1: raise RuntimeError("occurrence %s has %d solids; the static solver analyses exactly one" % (JOB["occurrence"], len(solids)))
    geom=doc.addObject("Part::Feature", "SelectedOccurrence"); geom.Shape=solids[0]
    return geom
def selected_part(doc):
    Import.insert(JOB["step"], doc.Name); doc.recompute()
    solids=[(o, solid) for o in doc.Objects if hasattr(o, "Shape") and not o.Shape.isNull()
            for solid in o.Shape.Solids]
    if not solids: raise RuntimeError("STEP contains no solid geometry")
    names=[[name for name in (obj.Label, obj.Name) if name] for obj, _ in solids]
    try: selected=select_solid_index(names, JOB.get("part"), JOB.get("solid_index"))
    except ValueError as e: raise RuntimeError(str(e))
    source,solid=solids[selected]
    if len(source.Shape.Solids) == 1: return source
    geom=doc.addObject("Part::Feature", "SelectedPart")
    geom.Label=source.Label
    geom.Shape=solid
    geom.Placement=source.Placement
    return geom
def run():
    doc=App.newDocument("StaticAnalysis")
    try:
        geom=selected_occurrence(doc) if JOB.get("occurrence") is not None else selected_part(doc)
        a=ObjectsFem.makeAnalysis(doc, "Analysis")
        solver=ObjectsFem.makeSolverCalculiXCcxTools(doc, "CalculiXCcxTools")
        solver.AnalysisType="static"; solver.GeometricalNonlinearity="linear"; solver.WorkingDir=os.path.dirname(JOB["output"]); solver.SplitInputWriter=False; solver.MatrixSolverType="spooles"; a.addObject(solver)
        matobj=ObjectsFem.makeMaterialSolid(doc, "Material"); mat=matobj.Material
        mat["Name"]=JOB["material"].get("name", "Case material")
        mat["YoungsModulus"]="%s MPa" % JOB["material"]["E"]
        mat["PoissonRatio"]=str(JOB["material"]["nu"])
        mat["Density"]="%s kg/m^3" % JOB["material"]["density"]
        matobj.Material=mat; matobj.References=[(geom, "Solid1")]; a.addObject(matobj)
        fixed=ObjectsFem.makeConstraintFixed(doc, "FixedFaces"); fixed.References=selected_faces(geom, JOB["fixed_faces"]); a.addObject(fixed)
        for n, spec in enumerate(JOB["loads"]):
            fx,fy,fz=spec["force"]
            direction=doc.addObject("Part::Feature", "LoadDirection%d" % n); direction.Shape=Part.makeLine(App.Vector(0,0,0), App.Vector(fx,fy,fz))
            force=ObjectsFem.makeConstraintForce(doc, "FaceForce%d" % n); force.References=selected_faces(geom, spec["selector"])
            force.Force="%.12g N" % math.sqrt(fx*fx+fy*fy+fz*fz)
            force.Direction=(direction,["Edge1"]); force.Reversed=False; a.addObject(force)
        mesh=ObjectsFem.makeMeshGmsh(doc, "GmshMesh"); a.addObject(mesh); mesh.Shape=geom; mesh.ElementDimension="3D"; mesh.ElementOrder="2nd"; mesh.HighOrderOptimize="Elastic"; mesh.CharacteristicLengthMax="%s mm" % JOB["mesh_size"]; mesh.CharacteristicLengthMin="%s mm" % (JOB["mesh_size"]*0.5); mesh.OptimizeStd=False; mesh.OptimizeNetgen=False; doc.recompute()
        gm=GmshTools(mesh); gm.prepare()
        gm.write_part_file()
        gm.write_geo()
        geo_path=gm.temp_file_geo
        brep_path=gm.temp_file_geometry
        with open(geo_path, "r", encoding="utf-8") as geo_file: source_geo=geo_file.read()
        source_geo=re.sub(r"(?m)^//.*shape2mesh[.]geo$", "// Gmsh input file: shape2mesh.geo", source_geo)
        source_geo=re.sub(r"(?m)^General[.]NumThreads[ \t]*=[ \t]*[^;]+;", "General.NumThreads = 1;", source_geo)
        source_geo=re.sub(r"(?m)^Mesh[.]Optimize[ \t]*=[ \t]*[^;]+;", "Mesh.Optimize = 0;", source_geo)
        source_geo=re.sub(r"(?m)^Mesh[.]OptimizeNetgen[ \t]*=[ \t]*[^;]+;", "Mesh.OptimizeNetgen = 0;", source_geo)
        source_geo=re.sub(r"(?m)^Mesh[.]HighOrderOptimize[ \t]*=[ \t]*[^;]+;", "Mesh.HighOrderOptimize = 2;", source_geo)
        source_geo=re.sub(r"(?m)^Mesh[.]RandomFactor3D[ \t]*=[ \t]*[^;]+;", "Mesh.RandomFactor3D = 0;", source_geo)
        source_geo="Mesh.RandomSeed = 1;\\n" + source_geo
        with open(geo_path, "w", encoding="utf-8") as geo_file: geo_file.write(source_geo)
        mesh_inputs={{"geometry_sha256":__import__("hashlib").sha256(open(brep_path,"rb").read()).hexdigest(), "geo_sha256":__import__("hashlib").sha256(source_geo.encode("utf-8")).hexdigest()}}
        shutil.copyfile(brep_path, os.path.join(JOB["run_directory"], "GmshGeometry.brep"))
        shutil.copyfile(geo_path, os.path.join(JOB["run_directory"], "GmshInput.geo"))
        gm.compute(); gm.process.waitForFinished(-1)
        gm.update_properties()
        doc.recompute()
        nodes=int(mesh.FemMesh.NodeCount); elements=len(mesh.FemMesh.Volumes)
        if nodes <= 0 or elements <= 0: raise RuntimeError("Gmsh produced an empty mesh")
        solver_started=time.perf_counter(); fea=CcxTools(solver); fea.reset_mesh_purge_results_checked(); fea.update_objects(); fea.setup_working_dir(solver.WorkingDir); fea.setup_ccx()
        problems=fea.check_prerequisites()
        if problems: raise RuntimeError("CalculiX prerequisites failed: %r" % problems)
        fea.write_inp_file(); fea.ccx_run(); fea.load_results(); solve_seconds=time.perf_counter()-solver_started
        results=next((obj for obj in a.Group if hasattr(obj, "vonMises") and hasattr(obj, "DisplacementLengths")), None)
        if results is None: raise RuntimeError("CalculiX did not produce a result object")
        stress=[float(v) for v in results.vonMises]; displacement=[float(v) for v in results.DisplacementLengths]
        if not stress or not displacement: raise RuntimeError("solver returned no stress or displacement results")
        max_stress=max(stress); max_displacement=max(displacement); y=float(JOB["material"]["yield"])
        safety_factor=y/max_stress if max_stress else None
        solver_started=time.perf_counter(); fea=CcxTools(solver); fea.reset_mesh_purge_results_checked(); fea.update_objects(); fea.setup_working_dir(solver.WorkingDir); fea.setup_ccx()
        problems=fea.check_prerequisites()
        if problems: raise RuntimeError("CalculiX prerequisites failed: %r" % problems)
        fea.write_inp_file(); fea.ccx_run(); fea.load_results(); solve_seconds=time.perf_counter()-solver_started
        result={{"run_id":JOB["run_id"], "part":JOB.get("part"), "occurrence":JOB.get("occurrence"), "solid_index":JOB.get("solid_index"), "max_von_mises_mpa":max_stress, "max_displacement_mm":max_displacement, "safety_factor_yield":safety_factor, "node_count":nodes, "element_count":elements, "solve_time_seconds":solve_seconds}}
        result["solver_versions"]={{"freecad":".".join(App.Version()[:3])}}
        result["warnings"]=[]
        result["worst_case_pose"]={{"step":JOB["step"], **({{"pose":JOB["pose"]}} if JOB.get("pose") is not None else {{}})}}
        result["required_safety_factor"]=JOB.get("required_safety_factor")
        result["mesh_input_hashes"]=mesh_inputs
        result["mesh_input_files"]=["GmshGeometry.brep", "GmshInput.geo"]
        result["status"]="fail" if result["required_safety_factor"] is not None and safety_factor is not None and safety_factor < result["required_safety_factor"] else "pass"
        with open(JOB["output"], "w", encoding="utf-8") as f: json.dump(result,f,indent=2); f.write("\\n")
    finally:
        App.closeDocument(doc.Name)
try: run()
except Exception as e:
    result={{"status":"error", "run_id":JOB["run_id"], "error":{{"code":"analysis_failed", "message":str(e)}}, "warnings":[]}}
    with open(JOB["output"],"w",encoding="utf-8") as f: json.dump(result,f,indent=2); f.write("\\n")
'''
    job_path.write_text(script, encoding="utf-8")
    try:
        freecad = find_freecad()
        if freecad is None:
            return error("freecadcmd not found; set FREECADCMD or add it to PATH", code="freecad_unavailable"), 2
        completed = subprocess.run([str(freecad), str(job_path)], cwd=run_dir, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        result = error(f"FreeCAD job exceeded timeout of {timeout} seconds", code="freecad_timeout")
        result.update({"run_id": run_id, "run_directory": str(run_dir)})
        output_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        return result, 2
    except OSError as exc:
        return error(f"cannot start FreeCAD: {exc}", code="freecad_unavailable"), 2
    if not marker_path.is_file():
        result = error("FreeCAD job did not write its run-specific completion marker", code="missing_completion_marker")
        result.update({"run_id": run_id, "run_directory": str(run_dir)})
        result["details"] = {"returncode": completed.returncode, "stderr": completed.stderr[-4000:]}
        output_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        return result, 2
    try:
        result = json.loads(marker_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return error(f"cannot parse FreeCAD result marker: {exc}", code="invalid_result"), 2
    if result.get("run_id") != run_id:
        return error("FreeCAD result marker run id does not match this invocation", code="invalid_result"), 2
    if result.get("status") != "error":
        result = apply_required_safety_factor(result, case.get("required_safety_factor"))
    result["run_directory"] = str(run_dir)
    result["warnings"] = result.get("warnings", [])
    if completed.returncode == 139 and result.get("status") == "pass":
        result["warnings"].append("FreeCAD exited with 139 after writing its result marker; outputs were validated.")
    elif completed.returncode != 0:
        result["warnings"].append(f"FreeCAD exited with status {completed.returncode}.")
        result["status"] = "error"
        result["error"] = {"code": "freecad_failed", "message": f"FreeCAD exited with status {completed.returncode}"}
    if completed.stderr.strip():
        result["warnings"].append("FreeCAD emitted diagnostics on stderr.")
    status = result_exit_code(result)
    if status == 2 and result.get("status") != "error":
        result = error("FreeCAD result has an unknown status", code="invalid_result")
    output_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result, status


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("case", type=Path, help="case YAML")
    args = parser.parse_args(argv)
    if find_freecad() is None:
        print(json.dumps(error("freecadcmd not found; set FREECADCMD or add it to PATH", code="freecad_unavailable")))
        return 2
    try:
        case = load_case(args.case.resolve())
    except CaseError as exc:
        print(json.dumps(error(str(exc))))
        return 2
    try:
        result, status = run_job(args.case.resolve(), case)
    except OSError as exc:
        print(json.dumps(error(str(exc), code="io_error")))
        return 2
    print(json.dumps(result, indent=2))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
