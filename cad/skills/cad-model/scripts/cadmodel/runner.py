"""Kernel runner core: execute part model scripts in one kernel's environment, write per-part STEP.

Each `run_<kernel>.py` is a uv script that pins one kernel environment and calls `main`. The
orchestrator (`cad_model.py run`) sends one JSON request on stdin, naming the file for the result:

    {"result": "/abs/tmp/cadquery.json",
     "parts": [{"pn": "LMP-0003", "name": "LMP-0003 Upper link",
                "model": "/abs/hw/parts/LMP-0003/model.py", "step": "/abs/out/LMP-0003.step"}]}

and reads one JSON result from that file once the runner exits, identical in shape for every kernel:

    {"kernel": "cadquery", "tools": {"python": "3.12.13", "cadquery": "2.8.0", ...},
     "import_s": 3.7,
     "parts": {"LMP-0003": {"ok": true, "params": {...}, "kernel_volume_mm3": 1234.5,
                            "kernel_solids": 1, "kernel_valid": true, "kernel_errors": [], "build_s": 0.4},
               "LMP-0004": {"ok": false, "error": {"type": "SafeEditError", "message": "...",
                                                   "where": "model.py:42 in build"}}}}

A part that fails never stops the others. stdout and stderr are console output only: model output
and OCCT's console messages land there and never reach the result, whenever they are flushed.
Exit 0 when the request was processed (part failures are in the result), 2 when it could not be.
"""

from __future__ import annotations

import importlib
import importlib.metadata
import importlib.util
import json
import platform
import re
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Mapping

from cadmodel import occ
from cadmodel.motion import load_pose

CONTRACT = "model.py must define KERNEL (str), PARAMS (JSON-serialisable dict), and build(params) -> shape"


class ContractError(ValueError):
    """model.py does not follow the part model script contract."""


def tool_versions(dists: tuple[str, ...]) -> dict[str, str]:
    versions = {"python": platform.python_version()}
    for dist in dists:
        try:
            versions[dist] = importlib.metadata.version(dist)
        except importlib.metadata.PackageNotFoundError:
            versions[dist] = "missing"
    return versions


def _load_model(pn: str, path: Path) -> Any:
    name = "cad_model_part_" + re.sub(r"\W", "_", pn)
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ContractError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _params(module: Any) -> dict[str, Any]:
    params = getattr(module, "PARAMS", None)
    if not isinstance(params, dict):
        raise ContractError(f"PARAMS is {type(params).__name__}, expected a dict; {CONTRACT}")
    try:
        return json.loads(json.dumps(params, allow_nan=False))
    except (TypeError, ValueError) as error:
        raise ContractError(f"PARAMS is not JSON-serialisable: {error}") from error


def build_part(kernel: str, request: Mapping[str, str]) -> dict[str, Any]:
    pose = load_pose()
    started = time.perf_counter()
    module = _load_model(request["pn"], Path(request["model"]))
    if getattr(module, "KERNEL", None) != kernel:
        raise ContractError(f"KERNEL is {getattr(module, 'KERNEL', None)!r}, this runner is {kernel!r}")
    params = _params(module)
    build = getattr(module, "build", None)
    if not callable(build):
        raise ContractError(f"build is not callable; {CONTRACT}")
    value = build(json.loads(json.dumps(params)))  # a private copy: build may not alter the record
    shape = occ.to_topods(value)
    if shape is None or shape.IsNull():
        raise ContractError(f"build returned {type(value).__name__}, not a {kernel} shape")
    solids = occ.count(shape, "SOLID")
    if solids == 0:
        raise ContractError("build returned a shape with no solid")
    pose.write_step(Path(request["step"]), None, [(pose.Part(request["pn"], request["name"], shape), pose.Rigid.identity())])
    errors = occ.check_statuses(shape)  # STEP export can hide an invalid solid (an open shell becomes a surface model)
    return {"ok": True, "params": params, "kernel_volume_mm3": occ.volume(shape), "kernel_solids": solids,
            "kernel_valid": not errors, "kernel_errors": errors, "build_s": round(time.perf_counter() - started, 3)}


def _failure(error: BaseException, model: str) -> dict[str, Any]:
    frames = [f for f in traceback.extract_tb(error.__traceback__) if f.filename == model]
    where = f"model.py:{frames[-1].lineno} in {frames[-1].name}" if frames else None
    return {"ok": False, "error": {"type": type(error).__name__, "message": str(error), "where": where}}


def main(kernel: str, dists: tuple[str, ...]) -> int:
    sys.dont_write_bytecode = True  # never leave __pycache__ beside hw/parts/<PN>/model.py
    try:
        request = json.load(sys.stdin)
        parts = request["parts"]
        result = Path(request["result"])
    except (ValueError, KeyError, TypeError) as error:
        print(f"run_{kernel}: bad request on stdin: {error}", file=sys.stderr)
        return 2
    results: dict[str, Any] = {}
    started = time.perf_counter()
    importlib.import_module(kernel)
    import_s = round(time.perf_counter() - started, 3)
    for part in parts:
        try:
            results[part["pn"]] = build_part(kernel, part)
        except Exception as error:  # noqa: BLE001 - every model failure is reported per part
            results[part["pn"]] = _failure(error, str(Path(part["model"])))
    result.write_text(json.dumps({"kernel": kernel, "tools": tool_versions(dists), "import_s": import_s,
                                  "parts": results}) + "\n", encoding="utf-8")
    return 0
