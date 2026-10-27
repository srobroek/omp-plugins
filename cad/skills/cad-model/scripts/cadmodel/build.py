"""`run`: build every part model into hw/versions/<label>/ and point hw/versions/latest.json at it."""

from __future__ import annotations

import ast
import contextlib
import hashlib
import json
import os
import platform
import shutil
import signal
import subprocess
import tempfile
import time
from concurrent.futures import FIRST_EXCEPTION, ThreadPoolExecutor, wait
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

from cadmodel import holes, mesh, occ, scriptenv
from cadmodel.motion import load_pose

SCRIPTS = Path(__file__).resolve().parents[1]
MATERIALS = SCRIPTS.parent / "assets" / "materials.yaml"
KERNELS = ("cadquery", "build123d")
RUNNERS = {kernel: SCRIPTS / f"run_{kernel}.py" for kernel in KERNELS}
ORCHESTRATOR_DISTS = ("cadquery-ocp-novtk", "trimesh", "numpy", "pyyaml")
FEATURES_FILE = "drawing-features.json"  # the drawing_features hook results of one version


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


def is_pn(text: str) -> bool:
    """A part number exactly: cad-motion's PN prefix and nothing after it."""
    return load_pose().PN_PREFIX.fullmatch(text) is not None


def finding(pn: str, check: str, message: str, kind: str = "ContractError", where: str | None = None) -> dict[str, Any]:
    """One `run` failure finding, the shape references/outputs.md documents."""
    return {"pn": pn, "check": check, "type": kind, "message": message, "where": where}


def label_number(label: str) -> int:
    match = load_pose().VERSION_LABEL.match(label)
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


def discover(hw: Path) -> tuple[list[PartSource], list[dict[str, Any]]]:
    """Every hw/parts/<PN>/model.py, plus a contract finding per model folder not named by a PN."""
    import yaml

    parts, findings = [], []
    for model in sorted((hw / "parts").glob("*/model.py")):
        pn = model.parent.name
        if not is_pn(pn):
            findings.append(finding(pn, "contract", f"hw/parts/{pn}/ holds a model.py but {pn!r} is not a part "
                                                    "number like LMP-0001; name the folder by its PN"))
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
    if not parts and not findings:
        raise UsageError(f"no hw/parts/<PN>/model.py under {hw}")
    return parts, findings


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
            findings.append(finding(part.pn, "contract",
                                    f"KERNEL is {part.kernel!r}; declare KERNEL = \"cadquery\" or \"build123d\""))
        elif requested != "auto" and part.kernel != requested:
            findings.append(finding(part.pn, "kernel",
                                    f"declares KERNEL = {part.kernel!r} but --kernel {requested} was requested"))
        else:
            groups.setdefault(part.kernel, []).append(part)
    return groups, findings


def run_kernels(requests: Mapping[str, list[dict[str, str]]]) -> dict[str, dict[str, Any]]:
    """Run every kernel's runner subprocess at once and collect their JSON results.

    `requests` maps a kernel to its request parts, `{pn, name, model, step}` (protocol in runner.py).
    Each runner writes its result to its own file in a private temporary folder, so nothing it or
    OCCT prints can stand in for the result; its stdout and stderr are one console stream. Each
    runner is fed and drained by its own thread, so no runner waits for another to finish. When
    one fails, every runner still running is killed with its process group (uv and the kernel's
    Python) before this raises, so none writes a STEP after the caller removes its output folder.
    """
    if shutil.which("uv") is None:
        raise UsageError("uv is required to run the kernel environments")
    with tempfile.TemporaryDirectory(prefix="cad-model-runners-") as tmp:
        procs: dict[str, tuple[subprocess.Popen[str], float]] = {}
        try:
            for kernel in requests:
                proc = subprocess.Popen(scriptenv.script_command(RUNNERS[kernel]),
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                        text=True, start_new_session=True)
                procs[kernel] = (proc, time.perf_counter())
        except BaseException:
            _stop(proc for proc, _ in procs.values())
            raise
        with ThreadPoolExecutor(max_workers=len(procs)) as pool:
            futures = {pool.submit(_runner_result, kernel, proc, started, requests[kernel],
                                   Path(tmp) / f"{kernel}.json"): kernel
                       for kernel, (proc, started) in procs.items()}
            try:
                done, _ = wait(futures, return_when=FIRST_EXCEPTION)
                for future in done:
                    future.result()
            except BaseException:
                _stop(proc for proc, _ in procs.values())
                raise
        return {kernel: future.result() for future, kernel in futures.items()}


def _runner_result(kernel: str, proc: subprocess.Popen[str], started: float, parts: list[dict[str, str]],
                   result_path: Path) -> dict[str, Any]:
    request = json.dumps({"result": str(result_path), "parts": parts})
    console, _ = proc.communicate(request)  # no timeout: a cold OCP import takes minutes
    if proc.returncode != 0:
        raise UsageError(f"{kernel} runner exited {proc.returncode}: {console[-3000:]}")
    try:
        result = json.loads(result_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise UsageError(f"{kernel} runner wrote no result ({error}): {console[-1000:]}") from error
    result["wall_s"] = round(time.perf_counter() - started, 3)
    result["console_tail"] = console[-2000:]
    return result


def _stop(procs: Iterable[subprocess.Popen[str]]) -> None:
    """Kill each runner still running, with every process in its session, and reap it."""
    procs = list(procs)
    for proc in procs:
        if proc.poll() is None:
            if os.name == "posix":
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(proc.pid, signal.SIGKILL)
            else:
                proc.kill()
    for proc in procs:
        proc.wait()


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
    newest = max(built_numbers(hw), default=0)
    if number <= newest:
        raise UsageError(f"{label} is not after the newest version v{newest}; labels increase, pick v{newest + 1}")
    sources, findings = discover(hw)
    by_pn = {p.pn: p for p in sources}
    assembly = pose.load_assembly(hw)
    joints = [*assembly.joints, *pose.attach_joints(attach)]
    groups, kernel_findings = select_kernels(sources, kernel)
    findings += kernel_findings
    if findings:
        return 1, {"status": "fail", "label": label, "findings": findings}

    work = versions / f".{label}.partial-{os.getpid()}"
    shutil.rmtree(work, ignore_errors=True)
    (work / "parts").mkdir(parents=True)
    try:
        results = run_kernels({k: [{"pn": p.pn, "name": p.product, "model": str(p.model),
                                    "step": str(work / "parts" / f"{p.pn}.step")} for p in members]
                               for k, members in groups.items()})
        timings["kernels_s"] = round(time.perf_counter() - started, 3)
        failed = [finding(pn, "build", res["error"]["message"], res["error"]["type"], res["error"]["where"])
                  for result in results.values() for pn, res in result["parts"].items() if not res["ok"]]
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
        features = {pn: built[pn][1]["drawing_features"] for pn in sorted(parts)
                    if built[pn][1]["drawing_features"] is not None}
        if features:
            write_json(work / FEATURES_FILE, {"label": label, "frame": "assembly_zero", "units": {"length": "mm"},
                                              "parts": features})

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
            "joint_pairs": sorted(({"pair": sorted([j.parent, j.child]), "joint": j.id, "type": j.type} for j in joints),
                                  key=lambda entry: (entry["pair"], entry["joint"])),
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
        if features:
            manifest["drawing_features"] = FEATURES_FILE
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
    if features:
        latest["drawing_features"] = f"{rel}/{FEATURES_FILE}"
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


def built_numbers(hw: Path) -> list[int]:
    """The label numbers of the built versions (manifest.json present) under hw/versions/."""
    label = load_pose().VERSION_LABEL
    found = []
    for folder in (hw / "versions").glob("v*"):
        match = label.match(folder.name)
        if match and (folder / "manifest.json").is_file():
            found.append(int(match.group(1)))
    return found


def previous_label(hw: Path, label: str) -> str | None:
    number = label_number(label)
    earlier = [n for n in built_numbers(hw) if n < number]
    return f"v{max(earlier)}" if earlier else None


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise UsageError(f"cannot read {path}: {error}") from error

