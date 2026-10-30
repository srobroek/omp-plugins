"""`run`: build every part model into hw/versions/<label>/ and point hw/versions/latest.json at it.

A version holds the installed definitions, the assembly, its record snapshot (record/) and the
manufacturing outputs of every custom-made part (manufacturing/<PN>/, cadmodel.manufacture). It is
sealed only when every part builds and every manufacturing output passes its blocking checks.

Only parts whose build inputs changed are built: the part folder's files (model.py, sources/), the
request fields from part.yaml, the kernel environment (`provenance.runtime`) and the plugin and
project sources the runner loaded. Every other part reuses its earlier output from the store
(`cadmodel.store`) byte for byte, once that output still hashes to its record; the version holds a
hard link to it where the filesystem allows, else a copy.
"""

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

from cadmodel import holes, manufacture, mesh, occ, orientation, provenance, record, scriptenv, store
from cadmodel.motion import load_pose

SCRIPTS = Path(__file__).resolve().parents[1]
MATERIALS = SCRIPTS.parent / "assets" / "materials.yaml"
KERNELS = ("cadquery", "build123d")
RUNNERS = {kernel: SCRIPTS / f"run_{kernel}.py" for kernel in KERNELS}
ORCHESTRATOR_DISTS = ("cadquery-ocp-novtk", "trimesh", "numpy", "pyyaml")
FEATURES_FILE = "drawing-features.json"  # the drawing_features hook results of one version
# part-map.json, metrics.json and manifest.json format: 2 adds occurrences; files without the key are version 1
SCHEMA_VERSION = 2
CACHE_FORMAT = 1  # bump when what a runner writes for a part changes without any keyed input changing
REQUEST_FIELDS = ("pn", "name", "model_frame", "manufacture")  # the request fields a part build depends on


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
    model_frame: str  # part.yaml model_frame: assembly_zero (default) or part_local

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


def part_folders(hw: Path) -> list[str]:
    """The PN-named folders of hw/parts/ that hold a part.yaml: the part records of the design."""
    root = hw / "parts"
    if not root.is_dir():
        return []
    return sorted(p.name for p in root.iterdir() if p.is_dir() and is_pn(p.name) and (p / "part.yaml").is_file())


def parse_records(files: Mapping[str, bytes]) -> dict[str, dict[str, Any]]:
    """The part records of a record snapshot (`record.snapshot`), parsed from its bytes, keyed by PN."""
    import yaml

    records = {}
    for name, data in files.items():
        if name.startswith("parts/") and name.endswith("/part.yaml"):
            try:
                parsed = yaml.safe_load(data.decode("utf-8"))
            except (UnicodeDecodeError, yaml.YAMLError) as error:
                raise UsageError(f"hw/{name}: {error}") from error
            if not isinstance(parsed, dict):
                raise UsageError(f"hw/{name} is not a mapping")
            records[name.split("/")[1]] = parsed
    return records


def discover(hw: Path, records: Mapping[str, Mapping[str, Any]]) -> tuple[list[PartSource], list[dict[str, Any]]]:
    """Every hw/parts/<PN>/model.py with its part record, plus a contract finding per model folder not named by a PN."""
    parts, findings = [], []
    for model in sorted((hw / "parts").glob("*/model.py")):
        pn = model.parent.name
        if not is_pn(pn):
            findings.append(finding(pn, "contract", f"hw/parts/{pn}/ holds a model.py but {pn!r} is not a part "
                                                    "number like LMP-0001; name the folder by its PN"))
            continue
        part = records.get(pn)
        if part is None:
            raise UsageError(f"{model.parent}/part.yaml is missing")
        if not isinstance(part.get("title"), str):
            raise UsageError(f"{model.parent}/part.yaml has no title")
        target = part.get("mass_target")
        parts.append(PartSource(pn, part["title"], part.get("material"),
                                float(target) if isinstance(target, (int, float)) else None,
                                model.resolve(), declared_kernel(model),
                                str(part.get("model_frame", "assembly_zero"))))
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


def runtime_of(kernel: str) -> dict[str, Any]:
    """The kernel environment's `provenance.runtime`, from its runner's `--tools` mode: no kernel import."""
    if shutil.which("uv") is None:
        raise UsageError("uv is required to run the kernel environments")
    proc = subprocess.Popen(scriptenv.script_command(RUNNERS[kernel], "--tools"), stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        out, err = proc.communicate()  # no timeout: a cold environment installs first
    except BaseException:
        _stop([proc])
        raise
    try:
        if proc.returncode != 0:
            raise ValueError(f"exited {proc.returncode}")
        return json.loads(out.strip().splitlines()[-1])
    except (ValueError, IndexError) as error:
        raise UsageError(f"{kernel} runner --tools failed ({error}): {err[-2000:]}") from error


def part_inputs(source: PartSource) -> dict[str, str]:
    """sha256 of every file of the part's folder its build can read (`provenance.folder_inputs`)."""
    return provenance.folder_inputs(source.model.parent)


def build_key(request: Mapping[str, Any], kernel: str, runtime: Mapping[str, Any], inputs: Mapping[str, str]) -> str:
    """The store key of one part build: everything its output depends on except the runner sources,
    which its record lists because only the runner knows them (`sources_hold`)."""
    return store.key({"format": CACHE_FORMAT, "kind": "part", "kernel": kernel, "runtime": runtime,
                      "request": {name: request[name] for name in REQUEST_FIELDS}, "inputs": inputs})


def project_sources(found: Mapping[str, str], hw: Path) -> dict[str, dict[str, str]]:
    """A runner's `sources`, keyed below the plugin's skills folder and below hw/, so a record names the
    files of whichever plugin copy and project checkout runs next."""
    keyed: dict[str, dict[str, str]] = {"hw": {}, "skills": {}}
    for path, sha in found.items():
        for name, base in (("hw", hw), ("skills", provenance.SKILLS)):
            if Path(path).is_relative_to(base):
                keyed[name][Path(path).relative_to(base).as_posix()] = sha
                break
    return keyed


def sources_hold(recorded: Any, hw: Path, seen: dict[Path, str | None]) -> bool:
    """Whether every source a part record lists still has its recorded sha256; `seen` caches hashes."""
    if not isinstance(recorded, Mapping):
        return False
    for name, base in (("hw", hw), ("skills", provenance.SKILLS)):
        for rel, sha in (recorded.get(name) or {}).items():
            path = base / rel
            if path not in seen:
                seen[path] = sha256(path) if path.is_file() else None
            if seen[path] != sha:
                return False
    return True


def reusable(cached: Mapping[str, Any], request: Mapping[str, Any], hw: Path, seen: dict[Path, str | None]) -> bool:
    """Whether a part record read from the store can stand in for building the part of `request`: a
    successful result, the STEP files the request needs, and runner sources that still hold."""
    objects, result = cached.get("objects", {}), cached.get("result")
    return ("step" in objects and (not request["manufacture_step"] or "manufacture_step" in objects)
            and isinstance(result, Mapping) and result.get("ok") is True and cached.get("kernel") in KERNELS
            and sources_hold(cached.get("sources"), hw, seen))


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
    """Definition-level metrics of one PN, in its model frame."""
    vol, centre = occ.mass_properties(shape)
    low, high = occ.bbox(shape)
    density = density_for(source.material, table)
    return {
        "product": source.product,
        "model_frame": source.model_frame,
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


def occurrence_metrics(pn: str, shape: Any, rigid: Any, part: Mapping[str, Any]) -> dict[str, Any]:
    """One occurrence at the built pose: its placement, the box of its placed geometry (not a rotated
    definition box) and its centre and holes carried by the placement."""
    pose = load_pose()
    low, high = occ.bbox(pose.placed(shape, rigid))
    turn = pose.Rigid(rigid.rot, (0.0, 0.0, 0.0))
    return {
        "PN": pn,
        "transform": rigid.rows(9),
        "centre_of_volume_mm": list(rigid.apply(tuple(part["centre_of_volume_mm"]))),
        "bbox_mm": {"min": list(low), "max": list(high), "size": [high[i] - low[i] for i in range(3)]},
        "holes": [{**hole, "axis": [round(c, 9) + 0.0 for c in turn.apply(tuple(hole["axis"]))],
                   "position": [round(c, 6) + 0.0 for c in rigid.apply(tuple(hole["position"]))]}
                  for hole in part["holes"]],
    }


def write_json(path: Path, data: Any) -> None:
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    try:
        os.replace(tmp, path)
    except OSError:
        tmp.unlink(missing_ok=True)
        raise


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def build_volume_of(files: Mapping[str, bytes]) -> orientation.BuildVolume | None:
    """The printer volume product.yaml declares in a record snapshot, or None."""
    import yaml

    try:
        product = yaml.safe_load(files["product.yaml"].decode("utf-8")) if "product.yaml" in files else {}
        return orientation.BuildVolume.declared(product)
    except (UnicodeDecodeError, yaml.YAMLError, ValueError) as error:
        raise UsageError(f"hw/product.yaml: {error}") from error


def run(hw: Path, label: str, kernel: str, attach: Iterable[str]) -> tuple[int, dict[str, Any]]:
    pose = load_pose()
    timings: dict[str, float] = {}
    started = time.perf_counter()
    number = label_number(label)
    hw = hw.resolve()
    versions = hw / "versions"
    final = versions / label
    if final.exists():
        raise version_exists(label, final)
    newest = max(built_numbers(hw), default=0)
    if number <= newest:
        raise UsageError(f"{label} is not after the newest version v{newest}; labels increase, pick v{newest + 1}")
    files = record.snapshot(hw, part_folders(hw))  # the record this version is built from, read once
    records = parse_records(files)
    sources, findings = discover(hw, records)
    model_sha = {p.pn: sha256(p.model) for p in sources}
    by_pn = {p.pn: p for p in sources}
    assembly = pose.load_assembly(hw)
    attached = pose.attach_joints(attach, assembly)
    groups, kernel_findings = select_kernels(sources, kernel)
    plans, refused = manufacture.plan(records)
    findings += kernel_findings + [finding(pn, "manufacture", message) for pn, message in refused]
    volume = build_volume_of(files)
    if findings:
        return 1, {"status": "fail", "label": label, "findings": findings}

    layout = record.load_layout()
    record_dir = layout.resolve(hw, "version.record", V=label).relative_to(layout.version_dir(hw, label)).as_posix()
    states_of = {pn: p.policy.relationship for pn, p in plans.items()}
    parts_store = store.Store(hw)
    work = versions / f".{label}.partial-{os.getpid()}"
    shutil.rmtree(work, ignore_errors=True)
    (work / "parts").mkdir(parents=True)
    states = Path(tempfile.mkdtemp(prefix="cad-model-states-"))  # build_manufacture shapes, read back by make
    try:
        requests = {p.pn: {"pn": p.pn, "name": p.product, "model_frame": p.model_frame, "model": str(p.model),
                           "step": str(work / "parts" / f"{p.pn}.step"), "manufacture": states_of.get(p.pn),
                           "manufacture_step": (str(states / f"{p.pn}.step")
                                                if states_of.get(p.pn) == "different" else None)}
                    for p in sources}
        runtimes = {k: runtime_of(k) for k in groups}
        inputs = {p.pn: part_inputs(p) for p in sources}
        keys = {p.pn: build_key(requests[p.pn], k, runtimes[k], inputs[p.pn])
                for k, members in groups.items() for p in members}
        seen: dict[Path, str | None] = {}
        reused = {pn: cached for pn, cached in ((pn, parts_store.record(key)) for pn, key in keys.items())
                  if cached is not None and reusable(cached, requests[pn], hw, seen)}
        for pn, cached in list(reused.items()):  # an object store gc removed since record() is a miss: build it
            step, state = Path(requests[pn]["step"]), requests[pn]["manufacture_step"]
            if not (parts_store.place(cached["objects"]["step"], step)
                    and (not state or parts_store.place(cached["objects"]["manufacture_step"], Path(state)))):
                step.unlink(missing_ok=True)  # never leave the runner a read-only link to write through
                del reused[pn]
        objects_of = {pn: cached["objects"] for pn, cached in reused.items()}
        pending = {k: [requests[p.pn] for p in members if p.pn not in reused] for k, members in groups.items()}
        results = run_kernels({k: parts for k, parts in pending.items() if parts}) if any(pending.values()) else {}
        timings["kernels_s"] = round(time.perf_counter() - started, 3)
        unsaved = []  # built from inputs that changed after they were keyed: never cached, so built again next run
        for kernel, result in results.items():  # kept even when another part fails, so a rerun builds only that one
            for pn, res in result["parts"].items():
                if not res["ok"]:
                    continue
                objects_of[pn] = {"step": parts_store.intern(Path(requests[pn]["step"]))}
                if requests[pn]["manufacture_step"]:
                    objects_of[pn]["manufacture_step"] = parts_store.intern(Path(requests[pn]["manufacture_step"]))
                if (res.get("inputs") == inputs[pn] and res.get("inputs_stable") is True
                        and part_inputs(by_pn[pn]) == inputs[pn]):
                    parts_store.save(keys[pn], {"kind": "part", "pn": pn, "kernel": kernel, "tools": result["tools"],
                                                "sources": project_sources(result["sources"], hw), "result": res,
                                                "objects": objects_of[pn]})
                else:
                    unsaved.append(pn)
        failed = [finding(pn, "build", res["error"]["message"], res["error"]["type"], res["error"]["where"])
                  for result in results.values() for pn, res in result["parts"].items() if not res["ok"]]
        if failed:
            return 1, {"status": "fail", "label": label, "findings": failed,
                       "runners": {k: {"import_s": r["import_s"], "wall_s": r["wall_s"]} for k, r in results.items()}}

        built = {**{pn: (cached["kernel"], cached["result"]) for pn, cached in reused.items()},
                 **{pn: (k, res) for k, result in results.items() for pn, res in result["parts"].items()}}
        state_shas = {pn: objects["manufacture_step"] for pn, objects in objects_of.items() if "manufacture_step" in objects}
        warnings = [{"pn": pn, "message": message}
                    for pn, (_, part) in sorted(built.items()) for message in part.get("warnings", [])]
        parts = pose.load_definitions(hw, work / "parts")
        chain = pose.assembly_chain(assembly, parts, attached)
        pose.require_geometry(chain, parts)
        values = chain.complete({})  # independent nominals, coupled joints derived from them
        limits = chain.limit_findings(values)
        if limits:
            raise pose.MotionError("the nominal pose is outside the joint limits: "
                                   + "; ".join(f["message"] for f in limits))
        transforms, motions = chain.transforms(values), chain.motions(values)
        mark = time.perf_counter()
        made, rows, made_reused = manufacture.make(work, hw, label, plans, {pn: p.product for pn, p in by_pn.items()},
                                                   parts, {pn: res for pn, (_, res) in built.items()},
                                                   pose.load_definitions(hw, states), volume, parts_store, state_shas)
        timings["manufacturing_s"] = round(time.perf_counter() - mark, 3)
        unmade = {pn: row for pn, row in rows.items() if row["status"] == "fail"}
        if unmade:
            return 1, {"status": "fail", "label": label, "manufacturing": unmade,
                       "findings": [finding(pn, "manufacture", manufacture.failure_message(row), "ManufactureError")
                                    for pn, row in unmade.items()]}
        top = f"{pose.product_id(hw)} {label}"
        pose.write_assembly_step(work / "assembly.step", top, parts, [chain.inventory.get(i) for i in chain.ids],
                                 transforms)
        mark = time.perf_counter()
        glb_info = mesh.write_glb(work / "assembly.step", work / "assembly.glb")
        mapping = mesh.part_map(work / "assembly.glb", chain, {pn: by_pn[pn].product for pn in parts})
        timings["glb_s"] = round(time.perf_counter() - mark, 3)
        write_json(work / "part-map.json", {"schema_version": SCHEMA_VERSION, **mapping})

        table = load_densities()
        metrics = {pn: part_metrics(parts[pn].shape, by_pn[pn], table) for pn in sorted(parts)}
        placed = {oid: occurrence_metrics(chain.pn(oid), parts[chain.pn(oid)].shape, transforms[oid],
                                          metrics[chain.pn(oid)]) for oid in chain.ids}
        quantity = {pn: sum(1 for oid in chain.ids if chain.pn(oid) == pn) for pn in parts}
        write_json(work / "metrics.json", {
            "schema_version": SCHEMA_VERSION, "label": label,
            "frame": ("parts: each PN's model_frame (assembly_zero: assembly coordinates at the zero pose); "
                      "occurrences: assembly coordinates at the built (nominal) pose"),
            "units": {"length": "mm", "mass": "g"},
            "density_table": str(MATERIALS.relative_to(SCRIPTS.parent)),
            "parts": metrics,
            "occurrences": placed,
            "totals": {"volume_mm3": sum(metrics[o["PN"]]["volume_mm3"] for o in placed.values()),
                       "mass_g": sum(metrics[o["PN"]]["mass_g"] for o in placed.values()
                                     if metrics[o["PN"]]["mass_g"] is not None),
                       "quantity": quantity,
                       "parts_without_density": sorted(pn for pn, m in metrics.items() if m["mass_g"] is None),
                       "occurrences_without_density": sorted(oid for oid, o in placed.items()
                                                             if metrics[o["PN"]]["mass_g"] is None)},
        })
        features = {pn: built[pn][1]["drawing_features"] for pn in sorted(parts)
                    if built[pn][1]["drawing_features"] is not None}
        if features:
            write_json(work / FEATURES_FILE, {"label": label, "units": {"length": "mm"},
                                              "frames": {pn: by_pn[pn].model_frame for pn in features},
                                              "parts": features})

        group_of = {member: group.id for group in assembly.groups for member in group.members}
        manifest = {
            "schema_version": SCHEMA_VERSION,
            "label": label,
            "number": number,
            "created_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "product_id": pose.product_id(hw),
            "top_product": top,
            "kernel_option": kernel,
            "assembly_yaml_sha256": digest(files["assembly.yaml"]),
            "attach": list(attach),
            "occurrences": {oid: {"PN": chain.pn(oid), "ref": chain.ref(oid),
                                  "explicit": chain.inventory.get(oid).explicit, "group": group_of.get(oid),
                                  "rest": chain.rests[oid].rows(9)} for oid in chain.ids},
            "pose": {"values": values, "transforms": {oid: transforms[oid].rows(9) for oid in chain.ids},
                     "motions": {oid: motions[oid].rows(9) for oid in chain.ids}},
            "joints": [{"id": j.id, "type": j.type, "parent": j.parent, "child": j.child, "axis": list(j.axis),
                        "origin": list(j.origin), "min": j.min, "max": j.max, "nominal": j.nominal}
                       for j in chain.joints],
            "joint_pairs": sorted(({"pair": sorted([j.parent, j.child]), "joint": j.id, "type": j.type}
                                   for j in chain.joints), key=lambda entry: (entry["pair"], entry["joint"])),
            "ground": chain.root,
            "glb": glb_info,
            "tools": {"orchestrator": orchestrator_tools(),  # a kernel whose parts were all reused did not start
                      **{k: ({**results[k]["tools"], "import_s": results[k]["import_s"]} if k in results
                             else dict(runtimes[k]["tools"])) for k in groups}},
            "parts": {pn: {
                "title": by_pn[pn].title,
                "product": by_pn[pn].product,
                "model_frame": by_pn[pn].model_frame,
                "occurrences": [oid for oid in chain.ids if chain.pn(oid) == pn],
                "kernel": built[pn][0],
                "model": str(by_pn[pn].model.relative_to(hw)),
                "source_sha256": model_sha[pn],
                "record_sha256": digest(files[f"parts/{pn}/part.yaml"]),
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
        manifest["record"] = {f"{record_dir}/{name}": sha
                              for name, sha in record.write_snapshot(work / record_dir, files).items()}
        manifest["manufacturing"] = made
        if record.snapshot(hw, part_folders(hw)) != files or {p.pn: part_inputs(p) for p in sources} != inputs:
            raise UsageError("hw/ records, part models or part sources changed while the version was built; nothing "
                             f"was written and {sorted(unsaved) or 'no part'} was not cached; run again")
        manifest["files"] = {p.relative_to(work).as_posix(): sha256(p) for p in sorted(work.rglob("*")) if p.is_file()}
        stray = [name for name in manifest["files"] if layout.classify(f"hw/versions/{label}/{name}") is None]
        if stray:
            raise UsageError(f"run staged files outside the cad-record layout: {stray}")
        write_json(work / "manifest.json", manifest)
        publish(work, final, label)
    finally:
        shutil.rmtree(work, ignore_errors=True)
        shutil.rmtree(states, ignore_errors=True)

    try:
        point_latest(hw, label, manifest)
    except OSError as error:
        raise UsageError(f"{label} is sealed at {final} and kept, but hw/versions/latest.json could not be written "
                         f"({error}); point it at {label} without rebuilding: cad_model.py latest {hw} --label {label}"
                         ) from error
    timings["total_s"] = round(time.perf_counter() - started, 3)
    made_paths = {pn for pn, entry in made.items() if entry["path"] is not None}
    return 0, {
        "status": "pass", "label": label, "version_dir": str(final),
        "parts": {pn: {"kernel": built[pn][0], "build": "reused" if pn in reused else "built",
                       "volume_mm3": metrics[pn]["volume_mm3"], "solids": metrics[pn]["solids"],
                       "mass_g": metrics[pn]["mass_g"], "quantity": quantity[pn]} for pn in sorted(parts)},
        "manufacturing": {pn: {"status": entry["status"], "complete": entry["complete"], "path": entry["path"],
                               "process": entry.get("process"), "state": entry.get("state", {}).get("relationship"),
                               "build": None if pn not in made_paths else "reused" if pn in made_reused else "built"}
                          for pn, entry in made.items()},
        "cache": {"parts": {"built": len(parts) - len(reused), "reused": len(reused)},
                  "manufacturing": {"built": len(made_paths - made_reused), "reused": len(made_reused)},
                  **({"unsaved": sorted(unsaved)} if unsaved else {})},
        "warnings": warnings,
        "latest": str(versions / "latest.json"),
        "timings_s": {**timings, **{f"{k}_import_s": r["import_s"] for k, r in results.items()},
                      **{f"{k}_runner_wall_s": r["wall_s"] for k, r in results.items()}},
    }


def latest_pointer(label: str, manifest: Mapping[str, Any]) -> dict[str, Any]:
    """hw/versions/latest.json for a sealed version, from its manifest; paths relative to hw/."""
    rel = f"versions/{label}"
    latest = {"label": label, "assembly_step": f"{rel}/assembly.step",
              "parts": {pn: f"{rel}/{info['step']}" for pn, info in sorted(manifest["parts"].items())},
              "glb": f"{rel}/assembly.glb", "metrics": f"{rel}/metrics.json",
              "part_map": f"{rel}/part-map.json", "manifest": f"{rel}/manifest.json"}
    if manifest.get("drawing_features"):
        latest["drawing_features"] = f"{rel}/{manifest['drawing_features']}"
    made = {pn: f"{rel}/{entry['path']}" for pn, entry in sorted((manifest.get("manufacturing") or {}).items())
            if entry.get("path")}
    if made:
        latest["manufacturing"] = made
    return latest


def point_latest(hw: Path, label: str, manifest: Mapping[str, Any]) -> None:
    write_json(hw / "versions" / "latest.json", latest_pointer(label, manifest))


def reconcile_latest(hw: Path, label: str) -> tuple[int, dict[str, Any]]:
    """Point latest.json at the newest built version after a pointer write failed, without rebuilding:
    the version must verify byte for byte against its manifest first."""
    hw = hw.resolve()
    folder = version_dir(hw, label)
    newest = max(built_numbers(hw))
    if label_number(label) != newest:
        raise UsageError(f"{label} is not the newest built version v{newest}; latest.json names the newest version")
    problems = record.load_layout().verify(folder)
    if problems:
        raise UsageError(f"{folder} does not verify against its manifest, so latest.json is unchanged: {problems}")
    manifest = read_json(folder / "manifest.json")
    point_latest(hw, label, manifest)
    return 0, {"status": "pass", "label": label, "latest": str(hw / "versions" / "latest.json"),
               "verified_files": len(manifest["files"])}


def store_gc(hw: Path, dry_run: bool = False) -> tuple[int, dict[str, Any]]:
    """`store gc`: drop what no version or release manifest references from the part store. Refused
    while a version is being staged, and when a manifest cannot be read, so it never removes an object
    a manifest names."""
    hw = hw.resolve()
    versions = hw / "versions"
    staging = sorted(p.name for p in versions.glob(".v*.partial-*")) if versions.is_dir() else []
    if staging:
        raise UsageError(f"{versions} holds staging folders {staging}: a cad-model run is in progress or was "
                         "interrupted; delete them once no run is in progress, then run gc again")
    manifests = sorted([*versions.glob("v*/manifest.json"), *(hw / "releases").glob("*/manifest.json")])
    referenced: set[str] = set()
    for path in manifests:
        manifest = read_json(path)
        inventory = manifest.get("files") if isinstance(manifest, dict) else None
        if not isinstance(inventory, dict):
            raise UsageError(f"{path} has no files inventory; gc removed nothing")
        for value in inventory.values():  # a v2 release manifest lists {sha256, original}
            sha = value.get("sha256") if isinstance(value, Mapping) else value
            if isinstance(sha, str):
                referenced.add(sha)
    result = store.Store(hw).gc(referenced, dry_run)
    return 0, {"status": "pass", "dry_run": dry_run, "manifests": len(manifests), **result}


def version_exists(label: str, final: Path) -> UsageError:
    return UsageError(f"version {label} already exists at {final}; versions are immutable, choose a new label")


def publish(work: Path, final: Path, label: str) -> None:
    """Rename the staged version into place. A version another run published under the same label after
    `run` checked it is kept as it is: the rename fails rather than merging into or replacing it."""
    try:
        os.replace(work, final)
    except OSError as error:
        if final.exists():
            raise version_exists(label, final) from error
        raise



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

