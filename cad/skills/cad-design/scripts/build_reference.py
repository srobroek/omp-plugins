#!/usr/bin/env python3
"""Build cad-design reference parts in one kernel and write one STEP AP242 per part.

Usage:
    python3 build_reference.py --kernel cadquery|build123d --out DIR
        [--models DIR] [--hw HW] [--only PN ...]

--models  directory of `<PN>.py` files that follow the model.py contract
          (default: assets/reference/lamp-arm/<kernel>/).
--hw      design record whose parts/<PN>/part.yaml titles name the STEP
          products `<PN> <title>` (default: the cad-record lamp-arm template).
--out     receives `<PN>.step` per part plus `build.json`.

The script re-runs itself inside the kernel's uv environment (KERNEL_ENVS);
the first OCP import in a fresh environment can take minutes. Geometry is
written through cad-motion's kernel-neutral AP242 writer, so both kernels'
files have the same product structure and names.

stdout: JSON {kernel, parts: {PN: {params_keys, seconds, step}}, errors}.
Exit 0 = every part built, 1 = a part violated the model.py contract or
failed to build, 2 = usage or infrastructure error.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys
import time
import traceback
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
SKILL = HERE.parent
POSE_PATH = SKILL.parent / "cad-motion" / "scripts" / "pose.py"
DEFAULT_HW = SKILL.parent / "cad-record" / "assets" / "project-template" / "hw"
REFERENCE = SKILL / "assets" / "reference" / "lamp-arm"
ENV_MARKER = "CAD_DESIGN_KERNEL_ENV"
PYTHON = "3.12"
KERNEL_ENVS = {
    "cadquery": ["cadquery==2.8.0", "cadquery-ocp==7.9.3.1.1", "vtk==9.6.2", "pyyaml>=6.0"],
    "build123d": ["build123d==0.13.0", "cadquery-ocp-novtk==8.0.1.1.0", "pyyaml>=6.0"],
}


class ContractError(RuntimeError):
    """A model file breaks the model.py contract; maps to exit 1."""


def kernel_command(kernel: str, script: Path, argv: list[str]) -> list[str]:
    """`uv run` command that executes `script` with `argv` inside the kernel environment."""
    command = ["uv", "run", "--no-project", "--python", PYTHON]
    for requirement in KERNEL_ENVS[kernel]:
        command += ["--with", requirement]
    return [*command, "python", str(script), *argv]


def reexec_in_kernel_env(kernel: str, argv: list[str]) -> int:
    env = {**os.environ, ENV_MARKER: kernel}
    try:
        return subprocess.run(kernel_command(kernel, Path(__file__).resolve(), argv), env=env).returncode
    except FileNotFoundError:
        print(json.dumps({"kernel": kernel, "parts": {}, "errors": ["uv is not on PATH"]}))
        return 2


def load_module(name: str, path: Path) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ContractError(f"{path}: not importable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def part_titles(hw: Path) -> dict[str, str]:
    import yaml

    titles = {}
    for record in sorted((hw / "parts").glob("*/part.yaml")):
        data = yaml.safe_load(record.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("title"), str):
            titles[record.parent.name] = data["title"]
    return titles


def to_topods(result: Any, kernel: str) -> Any:
    """The OCP shape behind a kernel object returned by build(); only one part per file."""
    if kernel == "cadquery":
        import cadquery as cq

        if isinstance(result, cq.Workplane):
            result = result.val()
        if not isinstance(result, cq.Shape):
            raise ContractError(f"build() returned {type(result).__name__}, expected a cadquery Shape")
    else:
        import build123d as bd

        if isinstance(result, bd.BuildPart):
            result = result.part
        if not isinstance(result, bd.Shape):
            raise ContractError(f"build() returned {type(result).__name__}, expected a build123d Shape")
    if result.wrapped is None or result.wrapped.IsNull():
        raise ContractError("build() returned an empty shape")
    return result.wrapped


def check_contract(module: Any, kernel: str, path: Path) -> dict[str, Any]:
    if getattr(module, "KERNEL", None) != kernel:
        raise ContractError(f"{path.name}: KERNEL is {getattr(module, 'KERNEL', None)!r}, expected {kernel!r}")
    params = getattr(module, "PARAMS", None)
    if not isinstance(params, dict):
        raise ContractError(f"{path.name}: PARAMS must be a dict")
    try:
        json.dumps(params)
    except TypeError as error:
        raise ContractError(f"{path.name}: PARAMS is not JSON-serialisable: {error}") from error
    if not callable(getattr(module, "build", None)):
        raise ContractError(f"{path.name}: no build(params) function")
    return params


def build_all(kernel: str, models: Path, hw: Path, out: Path, only: list[str]) -> tuple[dict[str, Any], list[str]]:
    pose = load_module("cad_motion_pose", POSE_PATH)
    titles = part_titles(hw)
    out.mkdir(parents=True, exist_ok=True)
    parts: dict[str, Any] = {}
    errors: list[str] = []
    for path in sorted(models.glob("*.py")):
        pn = path.stem
        if only and pn not in only:
            continue
        started = time.monotonic()
        try:
            module = load_module(f"cad_design_{kernel}_{pn.replace('-', '_')}", path)
            params = check_contract(module, kernel, path)
            with pose.stdout_to_stderr():
                shape = to_topods(module.build(json.loads(json.dumps(params))), kernel)
            name = f"{pn} {titles[pn]}" if pn in titles else pn
            step = out / f"{pn}.step"
            pose.write_step(step, None, [(pose.Part(pn, name, shape), pose.Rigid.identity())])
        except Exception as error:  # one failing part must not hide the others
            errors.append(f"{pn}: {type(error).__name__}: {error}")
            traceback.print_exc(file=sys.stderr)
            continue
        parts[pn] = {
            "params_keys": sorted(params),
            "seconds": round(time.monotonic() - started, 2),
            "step": str(step),
            "name": name,
        }
    return parts, errors


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    parser = argparse.ArgumentParser(description="Build cad-design reference parts to STEP AP242")
    parser.add_argument("--kernel", choices=sorted(KERNEL_ENVS), required=True)
    parser.add_argument("--models", type=Path)
    parser.add_argument("--hw", type=Path, default=DEFAULT_HW)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--only", nargs="*", default=[], metavar="PN")
    args = parser.parse_args(argv)
    if os.environ.get(ENV_MARKER) != args.kernel:
        return reexec_in_kernel_env(args.kernel, argv)
    models = args.models or REFERENCE / args.kernel
    if not models.is_dir():
        print(json.dumps({"kernel": args.kernel, "parts": {}, "errors": [f"models directory not found: {models}"]}))
        return 2
    try:
        parts, errors = build_all(args.kernel, models, args.hw, args.out, args.only)
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"kernel": args.kernel, "parts": {}, "errors": [f"{type(error).__name__}: {error}"]}))
        return 2
    report = {"kernel": args.kernel, "parts": parts, "errors": errors}
    (args.out / "build.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
