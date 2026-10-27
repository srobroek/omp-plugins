#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["defusedxml>=0.7.1", "pyyaml>=6.0"]
# ///
"""Generate checked projected SVG and PDF drawings from STEP geometry."""

from __future__ import annotations

import argparse
import json
import math
import uuid
from pathlib import Path
from typing import Any

import yaml
from defusedxml import ElementTree as SafeET

import drawing_document
import freecad_runtime
import layout_check
import sheet
import sheet_export

FREECADCMD = freecad_runtime.find_freecadcmd()
TECHDRAW_JOB = Path(__file__).resolve().parent / "techdraw_job.py"


def fail(code: str, message: str) -> dict[str, Any]:
    return {"status": "error", "error": {"code": code, "message": message}}


def load_mapping(path: Path, label: str) -> dict[str, Any]:
    try:
        value = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise ValueError(f"cannot read {label} YAML: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"{label} YAML must contain a mapping")
    return value


def read_inputs(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any], Path, list[dict[str, Any]]]:
    step = args.step.resolve()
    if not step.is_file():
        raise ValueError(f"STEP file does not exist: {step}")
    part = load_mapping(args.part.resolve(), "part")
    product = load_mapping(args.product.resolve(), "product")
    for field in ("PN", "rev", "title", "material"):
        if not isinstance(part.get(field), (str, int, float)) or not str(part[field]).strip():
            raise ValueError(f"part.{field} must be a non-empty string or number")
    if product.get("regime") not in sheet.SPECS:
        raise ValueError("product.regime must be 'iso' or 'asme'")
    tolerance = product.get("general_tolerance")
    if not isinstance(tolerance, (str, int, float)) or isinstance(tolerance, bool) or not str(tolerance).strip():
        raise ValueError("product.general_tolerance must be a non-empty string or number")
    if not math.isfinite(args.scale) or args.scale <= 0:
        raise ValueError("scale must be positive and finite")
    metrics = load_mapping(args.metrics.resolve(), "metrics")
    pn = str(part["PN"])
    parts = metrics.get("parts")
    if not isinstance(parts, dict) or not isinstance(parts.get(pn), dict):
        raise ValueError(f"metrics.parts must contain the part {pn}")
    holes = parts[pn].get("holes")
    if not isinstance(holes, list):
        raise ValueError(f"metrics.parts.{pn}.holes must be a list")
    for index, hole in enumerate(holes):
        if not isinstance(hole, dict):
            raise ValueError(f"metrics.parts.{pn}.holes[{index}] must be a mapping")
        hole_id, diameter, axis, position = hole.get("id"), hole.get("diameter_mm"), hole.get("axis"), hole.get("position")
        if not isinstance(hole_id, str) or not hole_id.strip():
            raise ValueError(f"metrics.parts.{pn}.holes[{index}].id must be a non-empty string")
        if (not isinstance(diameter, (int, float)) or isinstance(diameter, bool)
                or not math.isfinite(diameter) or diameter <= 0):
            raise ValueError(f"metrics.parts.{pn}.holes[{index}].diameter_mm must be positive and finite")
        for field, vector in (("axis", axis), ("position", position)):
            if (not isinstance(vector, list) or len(vector) != 3
                    or any(not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value)
                           for value in vector)):
                raise ValueError(f"metrics.parts.{pn}.holes[{index}].{field} must be a 3-number vector")
        if not any(axis):
            raise ValueError(f"metrics.parts.{pn}.holes[{index}].axis must be non-zero")
    return part, product, step, holes


def techdraw_job(step: Path, spec: sheet.SheetSpec, scale: float, holes: list[dict[str, Any]]) -> dict[str, Any]:
    """Job for techdraw_job.py: projection arrangement, fit area, annotation margins and bores."""
    area = spec.view_area()
    return {"step": str(step), "template": str(spec.template), "projection_type": spec.projection_type,
            "spacing": sheet.VIEW_SPACING, "area": [area.x0, area.y0, area.x1, area.y1], "margins": spec.margins(),
            "scales": drawing_document.candidate_scales(scale), "holes": holes}


def verify_svg_content(svg: Path, part: dict[str,Any]) -> tuple[bool,str,int]:
    try: root=SafeET.parse(str(svg),forbid_dtd=True).getroot()
    except Exception as exc: return False,f"invalid or unsafe SVG output: {exc}",0
    ns={"svg":"http://www.w3.org/2000/svg"}
    path_count=len(root.findall(".//svg:path",ns))
    texts=["".join(node.itertext()) for node in root.findall(".//svg:text",ns)]
    required=(str(part["PN"]),str(part["rev"]),str(part["title"]),str(part["material"]))
    missing=[value for value in required if not any(value in text for text in texts)]
    if path_count<12 or missing: return False,f"empty_drawing: paths={path_count}, missing fields={missing}",path_count
    return True,"",path_count


def run(args: argparse.Namespace) -> tuple[dict[str,Any],int]:
    part,product,step,holes=read_inputs(args)
    output=args.output_dir.resolve(); output.mkdir(parents=True,exist_ok=True)
    spec=sheet.SPECS[product["regime"]]
    templates={name: candidate.template.is_file() for name,candidate in sheet.SPECS.items()}
    if not templates[spec.regime]: return fail("template_missing",f"no {spec.regime} template at {spec.template}"),2
    data,message=freecad_runtime.run_job(FREECADCMD,TECHDRAW_JOB,techdraw_job(step,spec,args.scale,holes),output,args.timeout)
    if data is None:
        return fail("empty_drawing" if str(message).startswith("empty_drawing") else "projection_failed",message),1
    try: drawing=sheet.compose(data,part,product,spec)
    except ValueError as exc:
        return fail("metrics_mismatch" if str(exc).startswith("metrics_mismatch") else "empty_drawing",str(exc)),1
    run_id=uuid.uuid4().hex
    violations=layout_check.check_layout(drawing.svg,spec.regions,drawing.placeholders)
    if violations:
        rejected=output/f"drawing_{run_id}.rejected.svg"
        rejected.write_text(drawing.svg,encoding="utf-8")
        return fail("layout_check_failed",f"{rejected}: "+"; ".join(violations)),1
    svg=output/"drawing.svg"; pdf=output/"drawing.pdf"; png=output/f"drawing_{run_id}.png"
    marker=output/f"drawing_{run_id}.complete.json"
    svg.write_text(drawing.svg,encoding="utf-8")
    valid,message,path_count=verify_svg_content(svg,part)
    if not valid: return fail("empty_drawing",message),1
    required=[str(part[k]) for k in ("PN","rev","title","material")]+[str(product["general_tolerance"])]
    try: exported=sheet_export.export_sheet(FREECADCMD,svg,pdf,png,required,args.timeout)
    except sheet_export.ExportError as exc: return fail(exc.code,str(exc)),1 if exc.code=="empty_drawing" else 2
    report={"status":"pass","run_id":run_id,"pdf":str(pdf),"svg":str(svg),"rendered_png":str(png),"export":exported,
            "template":str(spec.template),"templates_found":templates,"projection":"FreeCAD TechDraw DrawProjGroup",
            "projection_method":"first-angle" if spec.first_angle else "third-angle",
            "scale":data["scale"],"layout_check":"pass","visible_paths":path_count,"face_count":data["face_count"],
            "hole_diameters_mm":[h["diameter_mm"] for h in holes],"warnings":list(drawing.warnings)}
    marker.write_text(json.dumps(report,indent=2)+"\n",encoding="utf-8")
    return report,0


def main(argv: list[str]|None=None) -> int:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("step",type=Path)
    parser.add_argument("--part",required=True,type=Path)
    parser.add_argument("--product",required=True,type=Path)
    parser.add_argument("--metrics",required=True,type=Path,help="metrics.json from the same model version as the STEP")
    parser.add_argument("--output-dir",required=True,type=Path)
    parser.add_argument("--scale",type=float,default=1.0,help="largest drawing scale; smaller standard scales are tried when the views do not fit")
    parser.add_argument("--timeout",type=float,default=120.0)
    args=parser.parse_args(argv)
    if args.timeout<=0: parser.error("--timeout must be positive")
    if FREECADCMD is None:
        print(json.dumps(fail("freecad_unavailable","freecadcmd not found; set FREECADCMD or put freecadcmd on PATH"))); return 2
    if not FREECADCMD.is_file():
        print(json.dumps(fail("freecad_unavailable",f"FreeCAD is not installed at {FREECADCMD}"))); return 2
    try: result,status=run(args)
    except ValueError as exc: result,status=fail("invalid_input",str(exc)),2
    except OSError as exc: result,status=fail("io_error",str(exc)),2
    print(json.dumps(result,indent=2)); return status


if __name__=="__main__": raise SystemExit(main())
