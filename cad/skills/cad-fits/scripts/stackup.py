# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6.0"]
# ///
"""One-dimensional linear tolerance stack-up: worst case and RSS.

Usage: uv run --script stackup.py STACK.yaml

Stack file:
    id: STK-001
    title: Pin end float
    units: mm
    requirement: {min: 0.05, max: 0.60, method: worst_case}  # min and/or max; method worst_case|rss
    contributors:
      - id: A
        description: housing bore depth
        nominal: 20.0
        tol_plus: 0.10      # or `tol: 0.10` for a symmetric +/- tolerance
        tol_minus: 0.10     # magnitudes, both >= 0
        direction: 1        # 1 adds to the closing dimension, -1 subtracts

Each contributor is centred on its mid-limit before stacking, so asymmetric
tolerances shift the mean: mean_i = nominal + (tol_plus - tol_minus) / 2 and
half_i = (tol_plus + tol_minus) / 2. The closing dimension is
mean = sum(direction_i * mean_i); worst case is mean +/- sum(half_i) and RSS is
mean +/- sqrt(sum(half_i ** 2)).

stdout: JSON result. stderr: diagnostics.
Exit 0 = requirement met by the governing method, 1 = not met,
2 = usage or input error.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import sys
from pathlib import Path
from typing import Any

LAYOUT_PATH = Path(__file__).resolve().parents[2] / "cad-record" / "scripts" / "layout.py"
_SPEC = importlib.util.spec_from_file_location("cad_record_layout", LAYOUT_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise ImportError(f"{LAYOUT_PATH} not found")
LAYOUT = sys.modules.get("cad_record_layout")
if LAYOUT is None:
    LAYOUT = importlib.util.module_from_spec(_SPEC)
    sys.modules["cad_record_layout"] = LAYOUT
    _SPEC.loader.exec_module(LAYOUT)

METHODS = ("worst_case", "rss")
RESULT_DECIMALS = 6


class StackError(ValueError):
    """The stack definition violates the input contract."""


def _number(value: Any, where: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise StackError(f"{where} must be a finite number, got {value!r}")
    return float(value)


def _tolerance(entry: dict[str, Any], where: str) -> tuple[float, float]:
    if "tol" in entry:
        if "tol_plus" in entry or "tol_minus" in entry:
            raise StackError(f"{where}: give either tol or tol_plus/tol_minus, not both")
        plus = minus = _number(entry["tol"], f"{where}.tol")
    else:
        if "tol_plus" not in entry or "tol_minus" not in entry:
            raise StackError(f"{where}: needs tol, or both tol_plus and tol_minus")
        plus = _number(entry["tol_plus"], f"{where}.tol_plus")
        minus = _number(entry["tol_minus"], f"{where}.tol_minus")
    if plus < 0 or minus < 0:
        raise StackError(f"{where}: tolerances are magnitudes and must be >= 0")
    return plus, minus


def _round(value: float) -> float:
    return round(value, RESULT_DECIMALS) + 0.0  # + 0.0 turns -0.0 into 0.0


def _verdict(low: float, high: float, req_min: float | None, req_max: float | None) -> bool:
    return (req_min is None or low >= req_min) and (req_max is None or high <= req_max)


def compute(stack: dict[str, Any]) -> dict[str, Any]:
    """Evaluate a parsed stack definition; raise StackError on invalid input."""
    if not isinstance(stack, dict):
        raise StackError("stack file must be a mapping")
    contributors = stack.get("contributors")
    if not isinstance(contributors, list) or not contributors:
        raise StackError("contributors must be a non-empty list")

    nominal = mean = wc_half = sum_sq = 0.0
    rows = []
    for index, entry in enumerate(contributors):
        where = f"contributors[{index}]"
        if not isinstance(entry, dict):
            raise StackError(f"{where} must be a mapping")
        direction = entry.get("direction")
        if direction not in (1, -1) or isinstance(direction, bool):
            raise StackError(f"{where}.direction must be 1 or -1, got {direction!r}")
        value = _number(entry.get("nominal"), f"{where}.nominal")
        plus, minus = _tolerance(entry, where)
        half = (plus + minus) / 2
        centre = value + (plus - minus) / 2
        nominal += direction * value
        mean += direction * centre
        wc_half += half
        sum_sq += half * half
        rows.append(
            {
                "id": entry.get("id", str(index + 1)),
                "direction": direction,
                "nominal": value,
                "tol_plus": plus,
                "tol_minus": minus,
                "mean": _round(centre),
                "half_tolerance": _round(half),
            }
        )

    rss_half = math.sqrt(sum_sq)
    for row in rows:
        half = row["half_tolerance"]
        row["wc_contribution_pct"] = _round(100 * half / wc_half) if wc_half else 0.0
        row["rss_contribution_pct"] = _round(100 * half * half / sum_sq) if sum_sq else 0.0

    results = {
        "worst_case": {"min": _round(mean - wc_half), "max": _round(mean + wc_half), "half_range": _round(wc_half)},
        "rss": {"min": _round(mean - rss_half), "max": _round(mean + rss_half), "half_range": _round(rss_half)},
    }

    requirement = stack.get("requirement")
    verdict: dict[str, Any] | None = None
    if requirement is not None:
        if not isinstance(requirement, dict):
            raise StackError("requirement must be a mapping")
        req_min = None if requirement.get("min") is None else _number(requirement["min"], "requirement.min")
        req_max = None if requirement.get("max") is None else _number(requirement["max"], "requirement.max")
        if req_min is None and req_max is None:
            raise StackError("requirement needs min, max, or both")
        method = requirement.get("method", "worst_case")
        if method not in METHODS:
            raise StackError(f"requirement.method must be one of {METHODS}, got {method!r}")
        passes = {name: _verdict(r["min"], r["max"], req_min, req_max) for name, r in results.items()}
        verdict = {"min": req_min, "max": req_max, "method": method, "pass": passes[method], "pass_by_method": passes}

    return {
        "id": stack.get("id"),
        "title": stack.get("title"),
        "units": stack.get("units", "mm"),
        "nominal": _round(nominal),
        "mean": _round(mean),
        **results,
        "contributors": rows,
        "requirement": verdict,
    }


def load_stack(path: Path) -> Any:
    import yaml  # imported here so `compute` stays importable without the script environment

    with path.open(encoding="utf-8") as handle:
        try:
            return yaml.safe_load(handle)
        except yaml.YAMLError as error:
            raise StackError(f"invalid YAML: {error}") from error
def _scratch_hw(path: Path) -> Path:
    """Locate the project anchor of a standalone .cad-work output for layout.scratch_path."""
    parts = path.resolve().parts
    index = parts.index(".cad-work") if ".cad-work" in parts else len(parts) - 1
    return Path(*parts[:index]) / "hw"




def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="1D worst-case and RSS tolerance stack-up")
    parser.add_argument("stack", type=Path, help="stack definition YAML")
    parser.add_argument("--hw", type=Path, help="hardware project hw/; required with --version")
    parser.add_argument("--version", help="built version to bind into hw/analysis/vN/<stack-id>/")
    parser.add_argument("--replace", action="store_true", help="retain and replace a different recipe")
    parser.add_argument("--out", type=Path, help="scratch result JSON path, only under .cad-work")
    args = parser.parse_args(argv)
    if bool(args.hw) != bool(args.version):
        parser.error("--hw and --version must be provided together")
    try:
        stack_path = args.stack.resolve()
        stack = load_stack(stack_path)
        result = compute(stack)
        requirement = result["requirement"]
        status = "fail" if requirement is not None and not requirement["pass"] else "pass"
        if args.hw:
            result["status"] = status
        if args.hw:
            version, _, _ = LAYOUT.built_version(args.hw, args.version)
            stack_id = result.get("id")
            if not isinstance(stack_id, str) or not stack_id:
                raise StackError("stack id is required for versioned publication")
            params = {"V": version, "S": stack_id}
            if args.out is not None:
                raise StackError("--out is only allowed for standalone scratch output")
            recipe = {
                "source_yaml_sha256": hashlib.sha256(stack_path.read_bytes()).hexdigest(),
                "options": {"result_decimals": RESULT_DECIMALS,
                            "method": (stack.get("requirement") or {}).get("method", "worst_case")},
            }
            reused = LAYOUT.reusable(args.hw, "bundle.analysis", params, recipe, replace=args.replace)
            if reused is not None:
                result = json.loads((reused / "results.json").read_text(encoding="utf-8"))
                result["bundle"] = str(reused)
                result["reused"] = True
                status = result["status"]
            else:
                stage = LAYOUT.staging(args.hw, "bundle.analysis")
                output = stage / "results.json"
                output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
                published = LAYOUT.publish(args.hw, "bundle.analysis", params, stage,
                                           recipe=recipe, producer="cad-fits stackup.py", status=status,
                                           replace=args.replace)
                result["bundle"] = str(published.path)
                result["reused"] = published.reused
        elif args.out is not None:
            target = LAYOUT.scratch_path(_scratch_hw(args.out), args.out, "--out")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        json.dump(result, sys.stdout, indent=2)
        sys.stdout.write("\n")
        if status == "fail":
            print(f"stackup: requirement not met ({requirement['method']})", file=sys.stderr)
        return 1 if status == "fail" else 0
    except OSError as error:
        print(f"stackup: cannot read {args.stack}: {error}", file=sys.stderr)
        return 2
    except (StackError, LAYOUT.LayoutError) as error:
        print(f"stackup: {args.stack}: {error}", file=sys.stderr)
        return 2

if __name__ == "__main__":
    sys.exit(main())
