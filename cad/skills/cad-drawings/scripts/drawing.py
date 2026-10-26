#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["defusedxml>=0.7.1", "pyyaml>=6.0"]
# ///
"""Generate checked projected SVG and PDF drawings from STEP geometry."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any

import yaml

FREECAD_SITE_PACKAGES = Path("/Applications/FreeCAD.app/Contents/Resources/lib/python3.11/site-packages")
if FREECAD_SITE_PACKAGES.is_dir():
    sys.path.insert(0, str(FREECAD_SITE_PACKAGES))
from defusedxml import ElementTree as SafeET

FREECADCMD = Path(os.environ.get("FREECADCMD", "/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd"))
RESOURCES = Path("/Applications/FreeCAD.app/Contents/Resources")
TEMPLATES = RESOURCES / "share/Mod/TechDraw/Templates"

def _terminate_process_group(process: subprocess.Popen[str]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        process.wait()
        return
    deadline=time.monotonic()+2
    while process.poll() is None and time.monotonic()<deadline:
        time.sleep(0.05)
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()

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
    if product.get("regime") not in ("iso", "asme"):
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
    return part, product, step, holes

def choose_template(regime: str) -> tuple[Path | None, dict[str, bool]]:
    candidates = {
        "iso": TEMPLATES / "ISO/A4_Landscape_ISO5457_minimal.svg",
        "asme": TEMPLATES / "ASME/ANSIA_Landscape.svg",
    }
    found = {name: path.is_file() for name, path in candidates.items()}
    template = candidates[regime]
    return (template if found[regime] else None), found


def tex(value: Any) -> str:
    return str(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def run_freecad_projection(step: Path, output: Path, timeout: float) -> tuple[dict[str, Any] | None, str]:
    run_id = uuid.uuid4().hex
    result_path = output / f"projection_{run_id}.json"
    job_path = output / f"projection_{run_id}.py"
    job = {"step": str(step), "result": str(result_path)}
    source = f'''import json, traceback
import FreeCAD as App, Part, TechDraw
JOB=json.loads({json.dumps(job)!r})
try:
    shape=Part.read(JOB["step"])
    if shape.isNull() or not shape.Faces: raise RuntimeError("STEP has no faces to project")
    projections={{}}
    for name,direction in (("front",App.Vector(0,-1,0)),("top",App.Vector(0,0,1)),("right",App.Vector(1,0,0))):
        # On a drawing view, cylindrical side surfaces normal to its projection are silhouette edges only.
        source=Part.makeCompound([face for face in shape.Faces if not (hasattr(face.Surface,"Radius") and abs(face.normalAt(0,0).dot(direction))>0.95)])
        fragment=TechDraw.projectToSVG(source,direction)
        if not fragment.strip() or "<path" not in fragment: raise RuntimeError("empty "+name+" projection")
        projections[name]=fragment
    holes=[]
    for face in shape.Faces:
        surface=face.Surface
        if hasattr(surface,"Radius") and face.Orientation=="Reversed":
            axis=surface.Axis; center=surface.Center; diameter=float(surface.Radius)*2
            duplicate=any(abs(h["diameter_mm"]-diameter)<1e-5 and all(abs(a-b)<1e-5 for a,b in zip(h["axis"],(axis.x,axis.y,axis.z))) and all(abs(a-b)<1e-5 for a,b in zip(h["center"],(center.x,center.y,center.z))) for h in holes)
            if not duplicate:
                holes.append({{"diameter_mm":diameter,"axis":[axis.x,axis.y,axis.z],"center":[center.x,center.y,center.z]}})
    with open(JOB["result"],"w",encoding="utf-8") as f:
        json.dump({{"status":"pass", "projections":projections, "holes":holes, "face_count":len(shape.Faces)}},f)
except Exception as exc:
    with open(JOB["result"],"w",encoding="utf-8") as f:
        json.dump({{"status":"error", "error":str(exc), "traceback":traceback.format_exc()}},f)
'''
    job_path.write_text(source, encoding="utf-8")
    process: subprocess.Popen[str] | None = None
    try:
        process = subprocess.Popen([str(FREECADCMD), str(job_path)], cwd=output, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        stdout,stderr=process.communicate(timeout=timeout)
    except FileNotFoundError:
        return None, f"FreeCAD command line application not found: {FREECADCMD}"
    except subprocess.TimeoutExpired:
        if process is not None:
            _terminate_process_group(process)
            process.communicate()
        return None, f"FreeCAD projection exceeded {timeout:g} seconds"
    except BaseException:
        if process is not None:
            _terminate_process_group(process)
            process.communicate()
        raise
    else:
        _terminate_process_group(process)
    completed_returncode=process.returncode
    if not result_path.is_file():
        return None, f"FreeCAD projection wrote no result marker (exit {completed_returncode}): {stderr[-1500:]}"
    try:
        result = json.loads(result_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return None, f"invalid FreeCAD projection result: {exc}"
    if result.get("status") != "pass":
        return None, result.get("error", "projection failed")
    return result, ""


def projection_bounds(fragment: str) -> tuple[float, float, float, float]:
    coords = [tuple(map(float, point)) for point in re.findall(
        r"[ML]\s*(-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s+"
        r"(-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)", fragment)]
    if len(coords) < 2:
        return 0.0, 0.0, 0.0, 0.0
    xs, ys = zip(*coords)
    return min(xs), min(ys), max(xs), max(ys)


def dim_width(name: str, x1: float, x2: float, y: float, value: float) -> str:
    mid = (x1+x2)/2
    return (f'<g id="{name}" stroke="#111" fill="#111" stroke-width="0.22">'
            f'<line x1="{x1:.3f}" y1="{y:.3f}" x2="{x2:.3f}" y2="{y:.3f}"/>'
            f'<line x1="{x1:.3f}" y1="{y-1:.3f}" x2="{x1:.3f}" y2="{y+1:.3f}"/>'
            f'<line x1="{x2:.3f}" y1="{y-1:.3f}" x2="{x2:.3f}" y2="{y+1:.3f}"/>'
            f'<text x="{mid:.3f}" y="{y-1.3:.3f}" font-size="2.8" stroke="none">{value:.2f}</text></g>')


def dim_height(name: str, x: float, y1: float, y2: float, value: float) -> str:
    mid = (y1+y2)/2
    return (f'<g id="{name}" stroke="#111" fill="#111" stroke-width="0.22">'
            f'<line x1="{x:.3f}" y1="{y1:.3f}" x2="{x:.3f}" y2="{y2:.3f}"/>'
            f'<line x1="{x-1:.3f}" y1="{y1:.3f}" x2="{x+1:.3f}" y2="{y1:.3f}"/>'
            f'<line x1="{x-1:.3f}" y1="{y2:.3f}" x2="{x+1:.3f}" y2="{y2:.3f}"/>'
            f'<text x="{x+1:.3f}" y="{mid:.3f}" font-size="2.8" stroke="none" transform="rotate(-90 {x+1:.3f} {mid:.3f})">{value:.2f}</text></g>')


def _place_view(name: str, bounds: tuple[float,float,float,float], cx: float, cy: float, scale: float,
                fragment: str, rotation: float = 0.0) -> str:
    x0,y0,x1,y1=bounds
    cx0,cy0=(x0+x1)/2,(y0+y1)/2
    fragment=re.sub(r'\s+transform="scale\(1, -1\)"', "", fragment)
    if rotation:
        transform=f"translate({cx:.5f} {cy:.5f}) rotate({rotation:g}) scale({scale:.8f} {-scale:.8f}) translate({-cx0:.5f} {-cy0:.5f})"
    else:
        transform=f"translate({cx:.5f} {cy:.5f}) scale({scale:.8f} {-scale:.8f}) translate({-cx0:.5f} {-cy0:.5f})"
    return f'<g id="view-{name}" transform="{transform}" fill="none" stroke="#111" stroke-width="0.35">{fragment}</g>'


def set_template_field(template_text: str, field: str, value: Any) -> str:
    field_pattern=re.compile(rf'<text\b(?=[^>]*\bfreecad:editable="{re.escape(field)}")[^>]*>.*?</text>',re.S)
    match=field_pattern.search(template_text)
    if match is None:
        raise ValueError(f"drawing template is missing editable field: {field}")
    element=match.group(0)
    if field in ("DrawingTitle1","drawing_number"):
        element=re.sub(r'font-size:[0-9.]+px','font-size:2.8px',element)
        element=re.sub(r'font-size="[0-9.]+px"','font-size="2.8px"',element)
    elif field in ("DrawingTitle2","DrawingTitle3","revision_index"):
        element=re.sub(r'font-size:[0-9.]+px','font-size:2.4px',element)
        element=re.sub(r'font-size="[0-9.]+px"','font-size="2.4px"',element)
    elif field=="title":
        element=re.sub(r'font-size="[0-9.]+px"','font-size="3.8px"',element)
    span_pattern=re.compile(r'(<tspan\b[^>]*>).*?(</tspan>)',re.S)
    updated,count=span_pattern.subn(lambda span:f"{span.group(1)}{tex(value)}{span.group(2)}",element,count=1)
    if count != 1:
        raise ValueError(f"drawing template editable field has no text span: {field}")
    return template_text[:match.start()]+updated+template_text[match.end():]


def make_sheet(data: dict[str, Any], part: dict[str, Any], product: dict[str, Any], requested_scale: float,
               template: Path) -> tuple[str, float]:
    projections=data["projections"]
    bounds={name:projection_bounds(projections[name]) for name in ("front","top","right")}
    if any(b[2]<=b[0] or b[3]<=b[1] for b in bounds.values()):
        raise ValueError("empty_drawing: at least one orthographic projection has zero extent")
    fw,fh=bounds["front"][2]-bounds["front"][0],bounds["front"][3]-bounds["front"][1]
    tw,th=bounds["top"][2]-bounds["top"][0],bounds["top"][3]-bounds["top"][1]
    rw,rh=bounds["right"][2]-bounds["right"][0],bounds["right"][3]-bounds["right"][1]
    sheet_width,sheet_height=(297.0,210.0) if product["regime"]=="iso" else (279.4,215.9)
    gap=10.0
    # Rotate the front silhouette so its long axis is horizontal on the sheet.
    front_width,front_height=fh,fw
    # Compute available sheet scale from the rotated front view's projected footprint.
    # Rotation aligns the side view's model Z extent with the front view's sheet Y axis.
    side_width=rh
    horizontal_span=front_width+side_width+gap
    vertical_span=front_height+th+gap
    actual_scale=min(requested_scale,(sheet_width-32)/horizontal_span,(sheet_height-82)/vertical_span)
    front_c=(sheet_width/2,78.0)
    if product["regime"]=="iso":
        top_c=(front_c[0],front_c[1]+(front_height+th)*actual_scale/2+gap/2)
        right_c=(front_c[0]-(front_width+side_width)*actual_scale/2-gap/2,front_c[1])
        symbol=['<g id="first_angle_projection_symbol"><path d="M 256 145 L 264 146.8 L 264 149.2 L 256 151 Z" fill="none" stroke="#111" stroke-width="0.35"/>',
                '<circle cx="270" cy="148" r="3.2" fill="none" stroke="#111" stroke-width="0.35"/></g>']
    else:
        top_c=(front_c[0],front_c[1]-(front_height+th)*actual_scale/2-gap/2)
        right_c=(front_c[0]+(front_width+side_width)*actual_scale/2+gap/2,front_c[1])
        symbol=['<g id="third_angle_projection_symbol"><circle cx="260" cy="148" r="3.2" fill="none" stroke="#111" stroke-width="0.35"/>',
                '<path d="M 268 146.2 L 276 144.5 L 276 151.5 L 268 149.8 Z" fill="none" stroke="#111" stroke-width="0.35"/></g>']
    views={"front":_place_view("front",bounds["front"],*front_c,actual_scale,projections["front"],rotation=90),
           "top":_place_view("top",bounds["top"],*top_c,actual_scale,projections["top"]),
           "right":_place_view("right",bounds["right"],*right_c,actual_scale,projections["right"])}
    fx1=front_c[0]-front_width*actual_scale/2; fx2=front_c[0]+front_width*actual_scale/2
    fy1=front_c[1]-front_height*actual_scale/2; fy2=front_c[1]+front_height*actual_scale/2
    dims=[dim_width("overall-front-width",fx1,fx2,fy1-4.0,front_width),
          dim_height("overall-front-height",fx2+4.0,fy1,fy2,front_height)]
    projected_x_center=(bounds["front"][0]+bounds["front"][2])/2
    projected_y_center=(bounds["front"][1]+bounds["front"][3])/2
    holes=data.get("holes", [])
    for index,hole in enumerate(holes[:5]):
        if abs(hole["axis"][1])<0.95:
            continue
        center=hole["position"]
        # Front projection local axes are (-Z, X); rotate(90) maps those to sheet (X, Z).
        hx=front_c[0]+(center[0]-projected_y_center)*actual_scale
        hy=front_c[1]+(-center[2]-projected_x_center)*actual_scale
        label_x=max(18,min(sheet_width-35,hx+12))
        label_y=max(26,min(sheet_height-55,hy-10-index*2))
        dims.append(f'<g id="hole-diameter-{hole["id"]}" stroke="#111" fill="#111" stroke-width="0.25"><path d="M {hx:.3f} {hy:.3f} L {label_x+1:.3f} {label_y+0.6:.3f}"/><text x="{label_x:.3f}" y="{label_y:.3f}" font-size="2.8" stroke="none">⌀ {hole["diameter_mm"]:.2f}</text></g>')
    contents="".join(views.values())+"".join(dims)+"".join(symbol)
    template_text=template.read_text(encoding="utf-8")
    if product["regime"]=="iso":
        fields={"drawing_number":part["PN"],"revision_index":part["rev"],"title":part["title"],
                "part_material":part["material"],"general_tolerances":product["general_tolerance"],
                "scale":f"1 : {1/actual_scale:.4g}"}
    else:
        fields={}
    if product["regime"]=="iso":
        for field,text in {"identification_number_label":"PN:","revision_index_label":"Rev:",
                           "general_tolerances_label":"Tolerance:","part_material_label":"Material:"}.items():
            template_text=re.sub(rf'(<text id="{field}"[^>]*>).*?(</text>)',rf'\1{text}\2',template_text,flags=re.S)
        for field,value in fields.items(): template_text=set_template_field(template_text,field,value)
    else:
        template_text=re.sub(r'<text\b(?=[^>]*\bfreecad:editable="(?:CompanyName|CompanyAddress|DrawnBy|CheckedBy|Approved1|Approved2|Code|Weight|Sheet|DrawingTitle1|DrawingTitle2|DrawingTitle3|drawing_number|revision_index|scale)")[^>]*>.*?</text>',"",template_text,flags=re.S)
        template_text=re.sub(r'<text\b(?=[^>]*\bid="BlockJ Size")[^>]*>.*?</text>',"",template_text,flags=re.S)
        title_fields=(
            ("Title",part["title"]),
            ("Part number",part["PN"]),
            ("Revision",part["rev"]),
            ("Material",part["material"]),
            ("Tolerance",product["general_tolerance"]),
            ("Scale",f"1 : {1/actual_scale:.4g}"),
        )
        x,y,width,height=159.85,153.42,99.501,48.216
        row_height=height/len(title_fields)
        fields_svg=[f'<rect x="{x}" y="{y}" width="{width}" height="{height}" fill="#fff" stroke="#111" stroke-width="0.25"/>']
        for index,(label,value) in enumerate(title_fields):
            row_y=y+index*row_height
            fields_svg.append(f'<rect id="cad-asme-title-field-{index}" x="{x}" y="{row_y:.3f}" width="{width}" height="{row_height:.3f}" fill="none" stroke="#111" stroke-width="0.25"/>')
            fields_svg.append(f'<text x="{x+2:.3f}" y="{row_y+3.0:.3f}" font-family="sans-serif" font-size="2.0">{label}:</text>')
            fields_svg.append(f'<text x="{x+2:.3f}" y="{row_y+6.2:.3f}" font-family="sans-serif" font-size="2.8">{tex(value)}</text>')
        template_text=template_text.replace("</svg>","".join(fields_svg)+"</svg>",1)
    opening=re.search(r'<svg\b[^>]*>',template_text,re.S)
    if not opening: raise ValueError("invalid shipped SVG drawing template")
    white=f'<rect id="paper-background" x="0" y="0" width="{sheet_width}" height="{sheet_height}" fill="#fff"/>\n'
    template_text=template_text[:opening.end()]+white+template_text[opening.end():]
    return template_text.rsplit("</svg>",1)[0]+'\n<g id="cad-drawing-content">'+contents+'\n</g>\n</svg>\n',actual_scale


def render_pdf(svg: Path, pdf: Path, png: Path, timeout: float, required_text: list[str]) -> tuple[bool,str]:
    helper=Path(__file__).resolve().parents[1]/"tests"/"render_pdf_probe.swift"
    try:
        result=subprocess.run(["swift",str(helper),str(svg),str(pdf),str(png),*required_text],capture_output=True,text=True,timeout=timeout)
    except FileNotFoundError: return False,"Swift/macOS PDF renderer unavailable"
    except subprocess.TimeoutExpired: return False,"macOS SVG-to-PDF rendering timed out"
    if result.returncode!=0 or not pdf.is_file() or pdf.stat().st_size==0 or not png.is_file() or png.stat().st_size==0:
        return False,(result.stderr or result.stdout)[-1500:]
    return True,""


def render_svg(svg: Path, png: Path, timeout: float) -> tuple[bool,str]:
    helper=Path(__file__).resolve().parents[1]/"tests"/"render_svg_probe.swift"
    try: result=subprocess.run(["swift",str(helper),str(svg),str(png)],capture_output=True,text=True,timeout=timeout)
    except FileNotFoundError: return False,"Swift/macOS SVG rasterizer unavailable"
    except subprocess.TimeoutExpired: return False,"SVG rasterization timed out"
    if result.returncode!=0 or not png.is_file() or png.stat().st_size==0: return False,(result.stderr or result.stdout)[-1500:]
    return True,""


def verify_svg_content(svg: Path, png: Path, part: dict[str,Any]) -> tuple[bool,str,int]:
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
    template,templates=choose_template(product["regime"])
    if template is None: return fail("template_missing",f"no shipped {product['regime']} template exists"),2
    data,message=run_freecad_projection(step,output,args.timeout)
    if data is None: return fail("projection_failed",message),1
    data["holes"]=holes
    try: svg_content,actual_scale=make_sheet(data,part,product,args.scale,template)
    except ValueError as exc: return fail("empty_drawing",str(exc)),1
    run_id=uuid.uuid4().hex
    svg=output/"drawing.svg"; pdf=output/"drawing.pdf"
    svg_png=output/f"drawing_{run_id}_svg.png"; pdf_png=output/f"drawing_{run_id}_pdf.png"
    marker=output/f"drawing_{run_id}.complete.json"
    svg.write_text(svg_content,encoding="utf-8")
    ok,message=render_svg(svg,svg_png,args.timeout)
    if not ok: return fail("empty_drawing",message),1
    valid,message,path_count=verify_svg_content(svg,svg_png,part)
    if not valid: return fail("empty_drawing",message),1
    required=[str(part[k]) for k in ("PN","rev","title")]
    if product["regime"]=="iso":
        required.extend((str(part["material"]),str(product["general_tolerance"])))
    ok,message=render_pdf(svg,pdf,pdf_png,args.timeout,required)
    if not ok:
        code="empty_drawing" if "missing" in message or "blank" in message else "pdf_conversion_unavailable"
        return fail(code,message),1 if code=="empty_drawing" else 2
    report={"status":"pass","run_id":run_id,"pdf":str(pdf),"svg":str(svg),"rendered_svg_png":str(svg_png),"rendered_pdf_png":str(pdf_png),
            "template":str(template),"templates_found":templates,"projection":"FreeCAD TechDraw.projectToSVG",
            "projection_method":"first-angle" if product["regime"]=="iso" else "third-angle",
            "scale":actual_scale,"visible_paths":path_count,"face_count":data["face_count"],
            "hole_diameters_mm":[h["diameter_mm"] for h in holes],"warnings":data.get("warnings",[])}
    marker.write_text(json.dumps(report,indent=2)+"\n",encoding="utf-8")
    return report,0




def main(argv: list[str]|None=None) -> int:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("step",type=Path)
    parser.add_argument("--part",required=True,type=Path)
    parser.add_argument("--product",required=True,type=Path)
    parser.add_argument("--metrics",required=True,type=Path,help="metrics.json from the same model version as the STEP")
    parser.add_argument("--output-dir",required=True,type=Path)
    parser.add_argument("--scale",type=float,default=1.0)
    parser.add_argument("--timeout",type=float,default=120.0)
    args=parser.parse_args(argv)
    if args.timeout<=0: parser.error("--timeout must be positive")
    if not FREECADCMD.is_file():
        print(json.dumps(fail("freecad_unavailable",f"FreeCAD is not installed at {FREECADCMD}"))); return 2
    try: result,status=run(args)
    except ValueError as exc: result,status=fail("invalid_input",str(exc)),2
    except OSError as exc: result,status=fail("io_error",str(exc)),2
    print(json.dumps(result,indent=2)); return status


if __name__=="__main__": raise SystemExit(main())