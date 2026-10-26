#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["pyyaml>=6.0"]
# ///
"""Build cad-design reference parts in one kernel and write one STEP AP242 per part.

Usage:
    python3 build_reference.py --kernel cadquery|build123d --out DIR
        [--models DIR] [--hw HW] [--only PN ...]

--models  directory of `<PN>.py` files that follow the model.py contract
          (default: assets/reference/lamp-arm/<kernel>/).
--hw      design record whose parts/<PN>/part.yaml titles name the STEP
          products `<PN> <title>` (default: the cad-record lamp-arm template).
--out     receives `<PN>.step` per part plus `build.json`.

The parts are built by cad-model's kernel runner (`run_cadquery.py` or
`run_build123d.py`, protocol in cadmodel/runner.py), exactly as `cad_model.py
run` builds them: the same uv environment, the same model.py contract checks
(`cadmodel.runner.build_part`), and cad-motion's kernel-neutral AP242 writer, so
a model that builds here builds there. The script first re-runs itself under its
own uv script environment (pyyaml, for the titles); the first OCP import in a
fresh kernel environment can take minutes. Each part also records what only the
in-memory shape shows: BRepCheck on the kernel shape (a STEP read-back can heal
an invalid face) and its volume, which form_check compares with the STEP
read-back.

stdout: JSON {kernel, parts: {PN: {params_keys, seconds, step, name, kernel_valid,
kernel_errors, kernel_volume_mm3}}, errors}. stderr: the runner's diagnostics.
Exit 0 = every part built, 1 = a part violated the model.py contract or
failed to build, 2 = usage or infrastructure error.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import traceback
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
SKILL = HERE.parent
CAD_MODEL_SCRIPTS = SKILL.parent / "cad-model" / "scripts"
DEFAULT_HW = SKILL.parent / "cad-record" / "assets" / "project-template" / "hw"
REFERENCE = SKILL / "assets" / "reference" / "lamp-arm"
ENV_MARKER = "CAD_DESIGN_BUILD_ENV"


def reexec_in_script_env(argv: list[str]) -> int:
    env = {**os.environ, ENV_MARKER: "1"}
    try:
        return subprocess.run(["uv", "run", "--quiet", "--script", str(Path(__file__).resolve()), *argv],
                              env=env).returncode
    except FileNotFoundError:
        print(json.dumps({"kernel": None, "parts": {}, "errors": ["uv is not on PATH"]}))
        return 2


def part_titles(hw: Path) -> dict[str, str]:
    import yaml

    titles = {}
    for record in sorted((hw / "parts").glob("*/part.yaml")):
        data = yaml.safe_load(record.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("title"), str):
            titles[record.parent.name] = data["title"]
    return titles


def build_all(kernel: str, models: Path, hw: Path, out: Path, only: list[str]) -> tuple[dict[str, Any], list[str]]:
    """Build every `<PN>.py` under `models` (or the `only` ones) with cad-model's runner for `kernel`."""
    from cadmodel import build

    titles = part_titles(hw)
    out.mkdir(parents=True, exist_ok=True)
    request = [{"pn": path.stem, "name": f"{path.stem} {titles[path.stem]}" if path.stem in titles else path.stem,
                "model": str(path.resolve()), "step": str(out.resolve() / f"{path.stem}.step")}
               for path in sorted(models.glob("*.py")) if not only or path.stem in only]
    result = build.run_kernels({kernel: request})[kernel]
    sys.stderr.write(result["stderr_tail"])
    parts: dict[str, Any] = {}
    errors: list[str] = []
    for item in request:
        built = result["parts"][item["pn"]]
        if not built["ok"]:
            error = built["error"]
            where = f" at {error['where']}" if error["where"] else ""
            errors.append(f"{item['pn']}: {error['type']}: {error['message']}{where}")
            continue
        parts[item["pn"]] = {
            "params_keys": sorted(built["params"]),
            "seconds": built["build_s"],
            "step": item["step"],
            "name": item["name"],
            "kernel_valid": built["kernel_valid"],
            "kernel_errors": built["kernel_errors"],
            "kernel_volume_mm3": built["kernel_volume_mm3"],
        }
    return parts, errors


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if os.environ.get(ENV_MARKER) != "1":
        return reexec_in_script_env(argv)
    sys.path.insert(0, str(CAD_MODEL_SCRIPTS))
    from cadmodel import build

    parser = argparse.ArgumentParser(description="Build cad-design reference parts to STEP AP242")
    parser.add_argument("--kernel", choices=build.KERNELS, required=True)
    parser.add_argument("--models", type=Path)
    parser.add_argument("--hw", type=Path, default=DEFAULT_HW)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--only", nargs="*", default=[], metavar="PN")
    args = parser.parse_args(argv)
    models = args.models or REFERENCE / args.kernel
    if not models.is_dir():
        print(json.dumps({"kernel": args.kernel, "parts": {}, "errors": [f"models directory not found: {models}"]}))
        return 2
    try:
        parts, errors = build_all(args.kernel, models, args.hw, args.out, args.only)
    except Exception as error:  # noqa: BLE001 - a runner or uv failure is no result, never a part failure
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"kernel": args.kernel, "parts": {}, "errors": [f"{type(error).__name__}: {error}"]}))
        return 2
    report = {"kernel": args.kernel, "parts": parts, "errors": errors}
    (args.out / "build.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
