"""`run`: build every part model into hw/versions/<label>/ and point hw/versions/latest.json at it."""

from __future__ import annotations

import ast
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from cadmodel import holes, mesh, occ
from cadmodel.motion import load_pose

SCRIPTS = Path(__file__).resolve().parents[1]
MATERIALS = SCRIPTS.parent / "assets" / "materials.yaml"
KERNELS = ("cadquery", "build123d")
RUNNERS = {kernel: SCRIPTS / f"run_{kernel}.py" for kernel in KERNELS}
LABEL = re.compile(r"^v([1-9][0-9]*)$")
PN = re.compile(r"^[A-Z]{2,5}-\d{4}$")
ORCHESTRATOR_DISTS = ("cadquery-ocp-novtk", "trimesh", "numpy", "pyyaml")


class UsageError(RuntimeError):
    """Inputs or infrastructure unusable; exit 2."""


@dataclass(frozen=True)
class PartSource:
    pn: str
    title: str
    material: str | None
    mass_target_g: float | None
    model: Path
    kernel: str | None  # declared KERNEL, None when missing or not a string literal

    @property
    def product(self) -> str:
        return f"{self.pn} {self.title}"


def label_number(label: str) -> int:
    match = LABEL.match(label)
    if not match:
        raise UsageError(f"version label must look like v1, v2, ...; got {label!r}")
    return int(match.group(1))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def declared_kernel(model: Path) -> str | None:
    """The top-level `KERNEL = "..."` literal, read without importing the model."""
    try:
        tree = ast.parse(model.read_text(encoding="utf-8"), filename=str(model))
    except (OSError, SyntaxError, UnicodeDecodeError):
        return None
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "KERNEL" for t in node.targets):
            if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                return node.value.value
    return None


def discover(hw: Path) -> list[PartSource]:
    import yaml

    parts = []
    for model in sorted((hw / "parts").glob("*/model.py")):
        pn = model.parent.name
        if not PN.match(pn):
            continue
        try:
            record = yaml.safe_load((model.parent / "part.yaml").read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError) as error:
            raise UsageError(f"{model.parent}/part.yaml: {error}") from error
        if not isinstance(record, dict) or not isinstance(record.get("title"), str):
            raise UsageError(f"{model.parent}/part.yaml has no title")
        target = record.get("mass_target")
        parts.append(PartSource(pn, record["title"], record.get("material"),
                                float(target) if isinstance(target, (int, float)) else None,
                                model.resolve(), declared_kernel(model)))
    if not parts:
        raise UsageError(f"no hw/parts/<PN>/model.py under {hw}")
    return parts


def load_densities() -> dict[str, float]:
    import yaml

    data = yaml.safe_load(MATERIALS.read_text(encoding="utf-8"))
    return {" ".join(name.lower().split()): float(value) for name, value in data["densities_g_cm3"].items()}


def density_for(material: str | None, table: dict[str, float]) -> float | None:
    return table.get(" ".join(material.lower().split())) if isinstance(material, str) else None


def select_kernels(parts: list[PartSource], requested: str) -> tuple[dict[str, list[PartSource]], list[dict[str, Any]]]:
    """Parts per kernel runner, plus contract findings for parts that cannot be run."""
    groups: dict[str, list[PartSource]] = {}
    findings = []
    for part in parts:
        if part.kernel not in KERNELS:
            findings.append({"pn": part.pn, "check": "contract",
                             "message": f"KERNEL is {part.kernel!r}; declare KERNEL = \"cadquery\" or \"build123d\""})
        elif requested != "auto" and part.kernel != requested:
            findings.append({"pn": part.pn, "check": "kernel",
                             "message": f"declares KERNEL = {part.kernel!r} but --kernel {requested} was requested"})
        else:
            groups.setdefault(part.kernel, []).append(part)
    return groups, findings


def run_kernels(groups: dict[str, list[PartSource]], parts_dir: Path) -> dict[str, dict[str, Any]]:
    """Start one runner subprocess per kernel (concurrently) and collect their JSON results."""
    if shutil.which("uv") is None:
        raise UsageError("uv is required to run the kernel environments")
    procs = {}
    for kernel, members in groups.items():
        request = {"parts": [{"pn": p.pn, "name": p.product, "model": str(p.model),
                              "step": str(parts_dir / f"{p.pn}.step")} for p in members]}
        proc = subprocess.Popen(["uv", "run", "--quiet", "--script", str(RUNNERS[kernel])],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        procs[kernel] = (proc, json.dumps(request), time.perf_counter())
    results = {}
    for kernel, (proc, request, started) in procs.items():
        stdout, stderr = proc.communicate(request)  # no timeout: a cold OCP import takes minutes
        if proc.returncode != 0 or not stdout.strip():
            raise UsageError(f"{kernel} runner exited {proc.returncode}: {stderr[-3000:]}")
        try:
            results[kernel] = json.loads(stdout.strip().splitlines()[-1])
        except ValueError as error:
            raise UsageError(f"{kernel} runner wrote no JSON result: {stdout[-1000:]}") from error
        results[kernel]["wall_s"] = round(time.perf_counter() - started, 3)
        results[kernel]["stderr_tail"] = stderr[-2000:]
    return results


def orchestrator_tools() -> dict[str, str]:
    import importlib.metadata

    versions = {"python": platform.python_version()}
    for dist in ORCHESTRATOR_DISTS:
        try:
            versions[dist] = importlib.metadata.version(dist)
        except importlib.metadata.PackageNotFoundError:
            versions[dist] = "missing"
    return versions


def part_metrics(shape: Any, source: PartSource, table: dict[str, float]) -> dict[str, Any]:
    vol, centre = occ.mass_properties(shape)
    low, high = occ.bbox(shape)
    density = density_for(source.material, table)
    return {
        "product": source.product,
        "material": source.material,
        "density_g_cm3": density,
        "volume_mm3": vol,
        "area_mm2": occ.area(shape),
        "mass_g": vol * density / 1000.0 if density is not None else None,
        "mass_target_g": source.mass_target_g,
        "centre_of_volume_mm": list(centre),
        "bbox_mm": {"min": list(low), "max": list(high), "size": [high[i] - low[i] for i in range(3)]},
        "solids": occ.count(shape, "SOLID"),
        "shells": occ.count(shape, "SHELL"),
        "faces": occ.count(shape, "FACE"),
        "holes": holes.holes(shape),
    }


def write_json(path: Path, data: Any) -> None:
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def run(hw: Path, label: str, kernel: str, attach: Iterable[str]) -> tuple[int, dict[str, Any]]:
    pose = load_pose()
    timings: dict[str, float] = {}
    started = time.perf_counter()
    number = label_number(label)
    hw = hw.resolve()
    versions = hw / "versions"
    final = versions / label
    if final.exists():
        raise UsageError(f"{final} exists; versions are immutable, pick the next label")
    sources = discover(hw)
    by_pn = {p.pn: p for p in sources}
    assembly = pose.load_assembly(hw)
    joints = [*assembly.joints, *pose.attach_joints(attach)]
    groups, findings = select_kernels(sources, kernel)
    if findings:
        return 1, {"status": "fail", "label": label, "findings": findings}

    work = versions / f".{label}.partial-{os.getpid()}"
    shutil.rmtree(work, ignore_errors=True)
    (work / "parts").mkdir(parents=True)
    try:
        results = run_kernels(groups, work / "parts")
        timings["kernels_s"] = round(time.perf_counter() - started, 3)
        failed = [{"pn": pn, "kernel": k, "check": "build", **res["error"]}
                  for k, result in results.items() for pn, res in result["parts"].items() if not res["ok"]]
        if failed:
            return 1, {"status": "fail", "label": label, "findings": failed,
                       "runners": {k: {"import_s": r["import_s"], "wall_s": r["wall_s"]} for k, r in results.items()}}

        built = {pn: (k, res) for k, result in results.items() for pn, res in result["parts"].items()}
        parts = pose.load_parts(hw, parts_dir=work / "parts")
        chain = pose.build_chain(joints, parts)
        pose.require_geometry(chain, parts)
        values = chain.complete({})
        transforms = chain.transforms(values)
        top = f"{pose.product_id(hw)} {label}"
        pose.write_step(work / "assembly.step", top, [(parts[pn], transforms[pn]) for pn in chain.parts])
        mark = time.perf_counter()
        glb_info = mesh.write_glb(work / "assembly.step", work / "assembly.glb")
        mapping = mesh.part_map(work / "assembly.glb", {pn: by_pn[pn].product for pn in parts})
        timings["glb_s"] = round(time.perf_counter() - mark, 3)
        write_json(work / "part-map.json", {"glb": "assembly.glb", "match": "node name starts with the PN",
                                            "parts": mapping})

        table = load_densities()
        metrics = {pn: part_metrics(parts[pn].shape, by_pn[pn], table) for pn in sorted(parts)}
        known = [m["mass_g"] for m in metrics.values() if m["mass_g"] is not None]
        write_json(work / "metrics.json", {
            "label": label, "frame": "assembly coordinates at the zero pose", "units": {"length": "mm", "mass": "g"},
            "density_table": str(MATERIALS.relative_to(SCRIPTS.parent)),
            "parts": metrics,
            "totals": {"volume_mm3": sum(m["volume_mm3"] for m in metrics.values()), "mass_g": sum(known),
                       "parts_without_density": sorted(pn for pn, m in metrics.items() if m["mass_g"] is None)},
        })

        manifest = {
            "label": label,
            "number": number,
            "created_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "product_id": pose.product_id(hw),
            "top_product": top,
            "kernel_option": kernel,
            "assembly_yaml_sha256": sha256(hw / "assembly.yaml"),
            "attach": list(attach),
            "pose": {"values": values, "transforms": {pn: transforms[pn].rows(9) for pn in chain.parts}},
            "joint_pairs": sorted(sorted([j.parent, j.child]) for j in joints),
            "ground": chain.root,
            "glb": glb_info,
            "tools": {"orchestrator": orchestrator_tools(),
                      **{k: {**r["tools"], "import_s": r["import_s"]} for k, r in results.items()}},
            "parts": {pn: {
                "title": by_pn[pn].title,
                "product": by_pn[pn].product,
                "kernel": built[pn][0],
                "model": str(by_pn[pn].model.relative_to(hw)),
                "source_sha256": sha256(by_pn[pn].model),
                "params": built[pn][1]["params"],
                "kernel_volume_mm3": built[pn][1]["kernel_volume_mm3"],
                "kernel_solids": built[pn][1]["kernel_solids"],
                "kernel_valid": built[pn][1]["kernel_valid"],
                "kernel_errors": built[pn][1]["kernel_errors"],
                "step": f"parts/{pn}.step",
            } for pn in sorted(parts)},
        }
        manifest["files"] = {str(p.relative_to(work)): sha256(p) for p in sorted(work.rglob("*")) if p.is_file()}
        write_json(work / "manifest.json", manifest)
        os.replace(work, final)
    finally:
        shutil.rmtree(work, ignore_errors=True)

    rel = f"versions/{label}"
    latest = {"label": label, "assembly_step": f"{rel}/assembly.step",
              "parts": {pn: f"{rel}/parts/{pn}.step" for pn in sorted(parts)},
              "glb": f"{rel}/assembly.glb", "metrics": f"{rel}/metrics.json",
              "part_map": f"{rel}/part-map.json", "manifest": f"{rel}/manifest.json"}
    write_json(versions / "latest.json", latest)
    timings["total_s"] = round(time.perf_counter() - started, 3)
    return 0, {
        "status": "pass", "label": label, "version_dir": str(final),
        "parts": {pn: {"kernel": built[pn][0], "volume_mm3": metrics[pn]["volume_mm3"], "solids": metrics[pn]["solids"],
                       "mass_g": metrics[pn]["mass_g"]} for pn in sorted(parts)},
        "latest": str(versions / "latest.json"),
        "timings_s": {**timings, **{f"{k}_import_s": r["import_s"] for k, r in results.items()},
                      **{f"{k}_runner_wall_s": r["wall_s"] for k, r in results.items()}},
    }


def version_dir(hw: Path, label: str) -> Path:
    label_number(label)
    folder = hw / "versions" / label
    if not (folder / "manifest.json").is_file():
        raise UsageError(f"{folder} holds no built version (manifest.json missing)")
    return folder


def previous_label(hw: Path, label: str) -> str | None:
    number = label_number(label)
    earlier = []
    for folder in (hw / "versions").glob("v*"):
        match = LABEL.match(folder.name)
        if match and int(match.group(1)) < number and (folder / "manifest.json").is_file():
            earlier.append(int(match.group(1)))
    return f"v{max(earlier)}" if earlier else None


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise UsageError(f"cannot read {path}: {error}") from error

