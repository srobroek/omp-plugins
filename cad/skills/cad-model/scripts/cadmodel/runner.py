"""Kernel runner core: execute part model scripts in one kernel's environment, write per-part STEP.

Each `run_<kernel>.py` is a uv script that pins one kernel environment and calls `main`. The
orchestrator (`cad_model.py run`) sends one JSON request on stdin, naming the file for the result:

    {"result": "/abs/tmp/cadquery.json",
     "parts": [{"pn": "LMP-0003", "name": "LMP-0003 Upper link", "model_frame": "assembly_zero",
                "model": "/abs/hw/parts/LMP-0003/model.py", "step": "/abs/out/LMP-0003.step",
                "manufacture": "different", "manufacture_step": "/abs/states/LMP-0003.step"}]}

and reads one JSON result from that file once the runner exits, identical in shape for every kernel:

    {"kernel": "cadquery", "tools": {"python": "3.12.13", "cadquery": "2.8.0", ...},
     "import_s": 3.7,
     "parts": {"LMP-0003": {"ok": true, "params": {...}, "kernel_volume_mm3": 1234.5,
                            "kernel_solids": 1, "kernel_valid": true, "kernel_errors": [], "build_s": 0.4,
                            "drawing_features": {"elbow_bore": {...}} or null,
                            "manufacture": {"kernel_volume_mm3": 1234.5, "kernel_solids": 1,
                                            "kernel_valid": true, "kernel_errors": []} or null},
               "LMP-0004": {"ok": false, "error": {"type": "SafeEditError", "message": "...",
                                                   "where": "model.py:42 in build"}}}}

`drawing_features` is the optional `drawing_features(params, shape)` hook's result, checked by
`feature_locators`: JSON primitives only, never a kernel object; null when the model has no hook.
Each locator's `frame` must be the part's `model_frame` (part.yaml; `assembly_zero` when the
request omits it), the frame build returns its shape in and the per-part STEP keeps.

`manufacture` is part.yaml `manufacture.relationship` of a custom-made part (`same` or
`different`), absent or null otherwise. The optional `build_manufacture(params)` hook builds the
manufacturing state, such as a bent strap's flat blank, and runs exactly when it is `different`:
the runner writes that shape to `manufacture_step` and reports its kernel facts under `manufacture`
(null without the hook). The orchestrator places and exports it; the hook writes no files.

A part that fails never stops the others. stdout and stderr are console output only: model output
and OCCT's console messages land there and never reach the result, whenever they are flushed.
Exit 0 when the request was processed (part failures are in the result), 2 when it could not be.
"""

from __future__ import annotations

import ast
import importlib
import importlib.metadata
import importlib.util
import json
import math
import logging
import platform
import re
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Mapping

from cadmodel import occ
from cadmodel.fonts import osifont_path
from cadmodel.motion import load_pose

CONTRACT = "model.py must define KERNEL (str), PARAMS (JSON-serialisable dict), and build(params) -> shape"
FEATURE_ID = re.compile(r"[a-z][a-z0-9_]*")
FEATURE_FRAMES = ("assembly_zero", "part_local")  # part.yaml model_frame: the coordinates build returns
SUPPORT_TYPES = frozenset({"plane", "cylinder", "cone", "sphere", "torus", "bezier", "bspline",
                           "revolution", "extrusion", "offset", "other"})
LOCATOR_KEYS = frozenset({"kind", "frame", "patches", "anchors", "relations"})
PATCH_KEYS = frozenset({"support_type", "point_mm", "normal", "region"})
ANCHOR_KEYS = frozenset({"point_mm", "direction"})


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


def _validate_text_fonts(module: Any) -> None:
    """Refuse CadQuery/build123d text calls that can fall back to an OS-selected font."""
    source = Path(module.__file__).read_text(encoding="utf-8")
    tree = ast.parse(source, filename=module.__file__)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        function = node.func
        if isinstance(function, ast.Attribute):
            name = function.attr
        elif isinstance(function, ast.Name):
            name = function.id
        else:
            continue
        if name not in {"text", "Text"}:
            continue
        if not any(keyword.arg in {"fontPath", "font_path"} for keyword in node.keywords):
            raise ContractError(f"{Path(module.__file__).name}:{node.lineno}: {name}() must pass an explicit "
                                "font file path with fontPath= or font_path=; system font fallback is refused")


def _params(module: Any) -> dict[str, Any]:
    params = getattr(module, "PARAMS", None)
    if not isinstance(params, dict):
        raise ContractError(f"PARAMS is {type(params).__name__}, expected a dict; {CONTRACT}")
    try:
        return json.loads(json.dumps(params, allow_nan=False))
    except (TypeError, ValueError) as error:
        raise ContractError(f"PARAMS is not JSON-serialisable: {error}") from error


def _vector(value: Any, where: str, *, unit: bool = False) -> list[float]:
    if (not isinstance(value, (list, tuple)) or len(value) != 3
            or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in value)):
        raise ContractError(f"{where} must be three finite numbers")
    vector = [float(v) for v in value]
    if unit and abs(math.hypot(*vector) - 1.0) > 1e-6:
        raise ContractError(f"{where} must be a unit vector")
    return vector


def _keys(value: Any, allowed: frozenset[str], required: frozenset[str], where: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ContractError(f"{where} must be a mapping")
    unknown, missing = sorted(set(value) - allowed), sorted(required - set(value))
    if unknown or missing:
        raise ContractError(f"{where}: unknown keys {unknown}, missing keys {missing}")
    return value


def feature_locators(value: Any, frame: str = "assembly_zero") -> dict[str, Any]:
    """Check a drawing_features result and return its JSON copy: semantic ID -> FeatureLocator.

    FeatureLocator: `kind` (str), `frame` (the part's model frame, `frame`), `patches` (non-empty
    list of `support_type`, `point_mm`, unit `normal`, optional `region` id), optional `anchors`
    (id -> `point_mm`, optional unit `direction`), optional `relations` (name -> feature ids of
    this result). Points are final-surface witnesses, not dimensions, in that frame.
    """
    if frame not in FEATURE_FRAMES:
        raise ContractError(f"model_frame {frame!r} must be one of {list(FEATURE_FRAMES)}")
    if not isinstance(value, dict) or not value:
        raise ContractError("drawing_features must return a non-empty dict of semantic ID -> locator")
    features: dict[str, Any] = {}
    for feature_id, locator in value.items():
        where = f"drawing_features[{feature_id!r}]"
        if not isinstance(feature_id, str) or not FEATURE_ID.fullmatch(feature_id):
            raise ContractError(f"{where}: a semantic ID is lower_snake_case")
        _keys(locator, LOCATOR_KEYS, frozenset({"kind", "frame", "patches"}), where)
        if not isinstance(locator["kind"], str) or not FEATURE_ID.fullmatch(locator["kind"]):
            raise ContractError(f"{where}.kind must be a lower_snake_case string")
        if locator["frame"] != frame:
            raise ContractError(f"{where}.frame must be {frame!r}, the part's model_frame: the coordinates build returns")
        patches = locator["patches"]
        if not isinstance(patches, list) or not patches:
            raise ContractError(f"{where}.patches must be a non-empty list")
        checked: dict[str, Any] = {"kind": locator["kind"], "frame": frame, "patches": []}
        for index, patch in enumerate(patches):
            at = f"{where}.patches[{index}]"
            _keys(patch, PATCH_KEYS, frozenset({"support_type", "point_mm", "normal"}), at)
            if patch["support_type"] not in SUPPORT_TYPES:
                raise ContractError(f"{at}.support_type must be one of {sorted(SUPPORT_TYPES)}")
            entry = {"support_type": patch["support_type"], "point_mm": _vector(patch["point_mm"], f"{at}.point_mm"),
                     "normal": _vector(patch["normal"], f"{at}.normal", unit=True)}
            if "region" in patch:
                if not isinstance(patch["region"], str) or not FEATURE_ID.fullmatch(patch["region"]):
                    raise ContractError(f"{at}.region must be a lower_snake_case string")
                entry["region"] = patch["region"]
            checked["patches"].append(entry)
        if "anchors" in locator:
            if not isinstance(locator["anchors"], dict):
                raise ContractError(f"{where}.anchors must be a mapping")
            checked["anchors"] = {}
            for name, anchor in locator["anchors"].items():
                at = f"{where}.anchors[{name!r}]"
                if not isinstance(name, str) or not FEATURE_ID.fullmatch(name):
                    raise ContractError(f"{at}: an anchor name is lower_snake_case")
                _keys(anchor, ANCHOR_KEYS, frozenset({"point_mm"}), at)
                checked["anchors"][name] = {"point_mm": _vector(anchor["point_mm"], f"{at}.point_mm")}
                if "direction" in anchor:
                    checked["anchors"][name]["direction"] = _vector(anchor["direction"], f"{at}.direction", unit=True)
        if "relations" in locator:
            if not isinstance(locator["relations"], dict):
                raise ContractError(f"{where}.relations must be a mapping")
            checked["relations"] = {}
            for name, targets in locator["relations"].items():
                at = f"{where}.relations[{name!r}]"
                if (not isinstance(name, str) or not FEATURE_ID.fullmatch(name) or not isinstance(targets, list)
                        or not targets or any(not isinstance(t, str) or t not in value or t == feature_id
                                              for t in targets)):
                    raise ContractError(f"{at} must name a non-empty list of the other semantic IDs in this result")
                checked["relations"][name] = list(targets)
        features[feature_id] = checked
    return features


def _shape(value: Any, kernel: str, hook: str) -> tuple[Any, int]:
    """The TopoDS_Shape a hook returned and its solid count; ContractError when it is no solid shape."""
    shape = occ.to_topods(value)
    if shape is None or shape.IsNull():
        raise ContractError(f"{hook} returned {type(value).__name__}, not a {kernel} shape")
    solids = occ.count(shape, "SOLID")
    if solids == 0:
        raise ContractError(f"{hook} returned a shape with no solid")
    return shape, solids


def _manufacture_hook(module: Any, declared: str | None) -> Any:
    """`build_manufacture`, required exactly when part.yaml declares a different manufacturing state."""
    hook = getattr(module, "build_manufacture", None)
    if hook is not None and not callable(hook):
        raise ContractError("build_manufacture is defined but not callable; expected build_manufacture(params) -> shape")
    if declared == "different" and hook is None:
        raise ContractError("part.yaml declares manufacture.relationship: different, but model.py defines no "
                            "build_manufacture(params)")
    if hook is not None and declared != "different":
        raise ContractError("model.py defines build_manufacture(params), but part.yaml does not declare "
                            "manufacture.relationship: different with its state, reason, decision and volume tolerance")
    return hook


def build_part(kernel: str, request: Mapping[str, Any]) -> dict[str, Any]:
    warnings: list[str] = []

    class WarningHandler(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            if record.name == "cadmodel.fillets":
                warnings.append(record.getMessage())

    handler = WarningHandler()
    logger = logging.getLogger("cadmodel.fillets")
    logger.addHandler(handler)
    try:
        result = _build_part(kernel, request)
    finally:
        logger.removeHandler(handler)
    if warnings:
        result["warnings"] = warnings
    return result


def _build_part(kernel: str, request: Mapping[str, Any]) -> dict[str, Any]:
    pose = load_pose()
    started = time.perf_counter()
    module = _load_model(request["pn"], Path(request["model"]))
    if getattr(module, "KERNEL", None) != kernel:
        raise ContractError(f"KERNEL is {getattr(module, 'KERNEL', None)!r}, this runner is {kernel!r}")
    _validate_text_fonts(module)
    params = _params(module)
    build = getattr(module, "build", None)
    if not callable(build):
        raise ContractError(f"build is not callable; {CONTRACT}")
    hook = getattr(module, "drawing_features", None)
    if hook is not None and not callable(hook):
        raise ContractError("drawing_features is defined but not callable; expected drawing_features(params, shape)")
    manufacture_hook = _manufacture_hook(module, request.get("manufacture"))
    build_params = json.loads(json.dumps(params))
    if getattr(module, "REQUIRES_OSIFONT", False):
        build_params["font_path"] = osifont_path()
    value = build(build_params)  # a private copy: build may not alter the record
    shape, solids = _shape(value, kernel, "build")
    # The hook sees build's own result, after every cut and fillet, and its own copy of the parameters.
    frame = request.get("model_frame", "assembly_zero")
    features = feature_locators(hook(json.loads(json.dumps(params)), value), frame) if hook is not None else None
    pose.write_part_step(Path(request["step"]), pose.Part(request["pn"], request["name"], shape))
    errors = occ.check_statuses(shape)  # STEP export can hide an invalid solid (an open shell becomes a surface model)
    manufacture = None
    if manufacture_hook is not None:
        state, state_solids = _shape(manufacture_hook(json.loads(json.dumps(params))), kernel, "build_manufacture")
        pose.write_part_step(Path(request["manufacture_step"]), pose.Part(request["pn"], request["name"], state))
        state_errors = occ.check_statuses(state)
        manufacture = {"kernel_volume_mm3": occ.volume(state), "kernel_solids": state_solids,
                       "kernel_valid": not state_errors, "kernel_errors": state_errors}
    return {"ok": True, "params": params, "kernel_volume_mm3": occ.volume(shape), "kernel_solids": solids,
            "kernel_valid": not errors, "kernel_errors": errors, "build_s": round(time.perf_counter() - started, 3),
            "drawing_features": features, "manufacture": manufacture}

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
