#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["pyyaml>=6.0"]
# ///
"""Generate an overall-dimension FreeCAD TechDraw PDF and SVG."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any

import yaml

FREECAD = Path(os.environ.get("FREECAD_LAUNCHER", "/Applications/FreeCAD.app/Contents/MacOS/FreeCAD"))
RESOURCES = Path("/Applications/FreeCAD.app/Contents/Resources")
TEMPLATES = RESOURCES / "share/Mod/TechDraw/Templates"


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


def read_inputs(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any], Path]:
    step = args.step.resolve()
    if not step.is_file():
        raise ValueError(f"STEP file does not exist: {step}")
    part = load_mapping(args.part.resolve(), "part")
    product = load_mapping(args.product.resolve(), "product")
    for field in ("PN", "rev", "title", "material"):
        if not isinstance(part.get(field), (str, int, float)) or not str(part[field]).strip():
            raise ValueError(f"part.{field} must be a non-empty string or number")
    if product.get("regime") not in ("iso", "asme"):
        raise ValueError("product.regime must be 'iso' or 'asme'")
    tolerance = product.get("general_tolerance")
    if not isinstance(tolerance, (str, int, float)) or isinstance(tolerance, bool) or not str(tolerance).strip():
        raise ValueError("product.general_tolerance must be a non-empty string or number")
    if args.scale <= 0:
        raise ValueError("scale must be positive")
    return part, product, step


def choose_template(regime: str) -> tuple[Path | None, dict[str, bool]]:
    candidates = {
        "iso": TEMPLATES / "ISO/A4_Landscape_ISO5457_minimal.svg",
        "asme": TEMPLATES / "ASME/ANSIA_Landscape.svg",
    }
    found = {name: path.is_file() for name, path in candidates.items()}
    template = candidates[regime]
    return (template if found[regime] else None), found


def make_macro(
    *, run_id: str, step: Path, part: dict[str, Any], product: dict[str, Any], scale: float,
    template: Path | None, output: Path, marker: Path,
) -> str:
    payload = {
        "run_id": run_id,
        "step": str(step),
        "part": part,
        "product": product,
        "scale": scale,
        "template": str(template) if template else "",
        "pdf": str(output / f"drawing_{run_id}.pdf"),
        "svg": str(output / f"drawing_{run_id}.svg"),
        "marker": str(marker),
    }
    data = json.dumps(payload)
    return f'''import json, os, time
import FreeCAD as App, FreeCADGui as Gui, Import
import TechDrawGui
JOB=json.loads({data!r})
def run():
    doc=App.newDocument("PartDrawing")
    try:
        Import.insert(JOB["step"], doc.Name); doc.recompute()
        objects=[o for o in doc.Objects if hasattr(o,"Shape") and not o.Shape.isNull()]
        if not objects: raise RuntimeError("STEP has no drawable shape")
        sheet=doc.addObject("TechDraw::DrawPage", "Page")
        if not JOB["template"]: raise RuntimeError("no shipped template is available for this regime")
        template=doc.addObject("TechDraw::DrawSVGTemplate", "Template")
        template.Template=JOB["template"]; sheet.Template=template
        pn=str(JOB["part"]["PN"]); rev=str(JOB["part"]["rev"])
        title=str(JOB["part"]["title"]); material=str(JOB["part"]["material"])
        tolerance=str(JOB["product"]["general_tolerance"])
        scale_text="1 : %.4g" % (1.0/float(JOB["scale"]))
        fields={{"drawing_number":pn, "revision_index":rev, "title":title,
                "part_material":material, "general_tolerances":tolerance,
                "DrawingTitle1":title, "DrawingTitle2":"PN: "+pn+" | Rev: "+rev,
                "DrawingTitle3":"Material: "+material+" | Tol: "+tolerance,
                "Title":title, "Subtitle":"PN: "+pn+" | Rev: "+rev,
                "Code":"Tolerance: "+tolerance, "Weight":"Material: "+material,
                "scale":scale_text}}
        editable=template.EditableTexts
        for field,value in fields.items():
            if field in editable: editable[field]=value
        template.EditableTexts=editable
        views=[]
        for name,direction,x,y in (("Front",(0,-1,0),75,120),("Top",(0,0,1),155,120),("Right",(1,0,0),235,120)):
            view=doc.addObject("TechDraw::DrawViewPart", "View"+name)
            sheet.addView(view); view.Source=objects; view.Direction=App.Vector(*direction)
            view.Scale=JOB["scale"]; view.X=x; view.Y=y; views.append(view)
        doc.recompute()
        for view in views:
            try: edges=view.getVisibleEdges()
            except Exception: edges=[]
            if edges:
                dimension=doc.addObject("TechDraw::DrawViewDimension", "Overall"+view.Name)
                sheet.addView(dimension); dimension.Type="Distance"; dimension.References2D=[(view,"Edge0")]
        doc.recompute()
        for _ in range(10): Gui.updateGui(); time.sleep(.1)
        TechDrawGui.exportPageAsPdf(sheet, JOB["pdf"])
        TechDrawGui.exportPageAsSvg(sheet, JOB["svg"])
        for path in (JOB["pdf"],JOB["svg"]):
            if not os.path.isfile(path) or os.path.getsize(path)==0: raise RuntimeError("empty or missing drawing export: "+path)
        result={{"status":"pass", "run_id":JOB["run_id"], "pdf":JOB["pdf"], "svg":JOB["svg"], "template":JOB["template"], "warnings":[]}}
        with open(JOB["marker"],"w",encoding="utf-8") as f: json.dump(result,f,indent=2); f.write("\\n")
    finally:
        try: Gui.getMainWindow().close()
        except Exception: pass
        App.closeDocument(doc.Name)
try: run()
except Exception as exc:
    result={{"status":"error", "run_id":JOB["run_id"], "error":{{"code":"drawing_failed", "message":str(exc)}}, "warnings":[]}}
    with open(JOB["marker"],"w",encoding="utf-8") as f: json.dump(result,f,indent=2); f.write("\\n")
os._exit(0)
'''


def run(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    part, product, step = read_inputs(args)
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    template, templates = choose_template(product["regime"])
    run_id = uuid.uuid4().hex
    macro = output / f"drawing_{run_id}.FCMacro"
    marker = output / f"drawing_{run_id}.complete.json"
    macro.write_text(make_macro(run_id=run_id, step=step, part=part, product=product, scale=args.scale,
                                template=template, output=output, marker=marker), encoding="utf-8")
    try:
        completed = subprocess.run([str(FREECAD), str(macro)], cwd=output,
                                   env={**os.environ, "QT_QPA_PLATFORM": "offscreen"}, capture_output=True, text=True)
    except OSError as exc:
        return fail("freecad_unavailable", f"cannot start FreeCAD GUI launcher: {exc}"), 2
    if not marker.is_file():
        return {**fail("missing_completion_marker", "FreeCAD did not write the run-specific completion marker"),
                "details": {"returncode": completed.returncode, "stderr": completed.stderr[-4000:], "templates_found": templates}}, 1
    try:
        result = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return fail("invalid_marker", f"cannot parse completion marker: {exc}"), 1
    if result.get("run_id") != run_id:
        return fail("invalid_marker", "completion marker run id does not match this invocation"), 1
    result["templates_found"] = templates
    result["warnings"] = result.get("warnings", [])
    if completed.returncode == 139:
        result["warnings"].append("FreeCAD exited with 139 after writing the completion marker; outputs were validated.")
    elif completed.returncode != 0:
        result["warnings"].append(f"FreeCAD exited with status {completed.returncode}.")
        result["status"] = "error"
        result["error"] = {"code": "freecad_failed", "message": f"FreeCAD exited with status {completed.returncode}"}
    if completed.stderr.strip():
        result["warnings"].append("FreeCAD emitted diagnostics on stderr.")
    if result.get("status") != "pass":
        return result, 1
    artifacts: dict[str, Path] = {}
    for key in ("pdf", "svg"):
        artifact = Path(result.get(key, ""))
        if not artifact.is_file() or artifact.stat().st_size <= 0:
            return fail("invalid_export", f"missing or empty {key.upper()} output: {artifact}"), 1
        if artifact.stat().st_mtime_ns < macro.stat().st_mtime_ns:
            return fail("stale_export", f"{key.upper()} was not freshly written by this run"), 1
        artifacts[key] = artifact
    destinations = {"pdf": output / "drawing.pdf", "svg": output / "drawing.svg"}
    for key, artifact in artifacts.items():
        artifact.replace(destinations[key])
        result[key] = str(destinations[key])
    result["status"] = "pass"
    return result, 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("step", type=Path)
    parser.add_argument("--part", required=True, type=Path)
    parser.add_argument("--product", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--scale", type=float, default=1.0, help="drawing scale ratio (default: 1)")
    args = parser.parse_args(argv)
    if not FREECAD.is_file():
        print(json.dumps(fail("freecad_unavailable", f"FreeCAD is not installed at {FREECAD}")))
        return 2
    try:
        result, status = run(args)
    except ValueError as exc:
        result, status = fail("invalid_input", str(exc)), 2
    except OSError as exc:
        result, status = fail("io_error", str(exc)), 2
    print(json.dumps(result, indent=2))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
