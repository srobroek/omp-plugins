# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["cadquery-ocp-novtk==8.0.1.1.0", "pyyaml>=6.0", "numpy>=1.26", "python-fcl==0.7.0.11"]
# ///
"""Audit a sweep's mesh-cleared requests by measuring them exactly.

Usage:
    uv run --script skill://cad-flow/scripts/run.py cad-motion/scripts/spot_check.py --hw HW --version vN
        --result BUNDLE [--all-mesh-poses] [--jobs 1|N|auto] [--cache DIR | --no-cache] [--time-limit 600]

A fast sweep leaves a request unmeasured when the mesh bound of mesh_bound.py proves it more than the
band clear of its pair's clearing threshold (`cleared`, method "mesh"). An audit measures such a
request exactly with pose.py's `interference` and checks, unrounded, that the exact distance lies in
the request's own [lower, upper] bounds (within pair_measure.SLACK_MM), that it is above the strict
floor threshold + band - 2 x the mesh deflection, and that the pair does not overlap. One that fails
any of these is a failure: the mesh bound was wrong there.

The sweep runs this audit itself unless `--no-spot-check`: for every pair with a mesh-cleared request,
the one of the smallest mesh lower bound, whether or not the pair's reported minimum is exact. This
script audits a published sweep bundle (`--result hw/motion/vN/CASE`) from its evidence/ statistics:
by default the same per-pair choice, with `--all-mesh-poses` every unique mesh-cleared pose (each
pair's distinct relative placements once). With the cache, an exact reading the cache already holds is
reused; `--no-cache` measures every one again, independently of earlier runs.

stdout: JSON {status, mode, checked, failures, max_abs_mesh_minus_exact_mm, largest_deviations, ...}.
Exit 0 = every audited request passes, 1 = a failure, 2 = usage, a stale or unreadable bundle, or an
audit the time limit stopped.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import sys
import time
import traceback
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any


def _load(name: str, path: Path) -> Any:
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


HERE = Path(__file__).resolve().parent
pose = _load("cad_motion_pose", HERE / "pose.py")
pair_measure = _load("cad_motion_pair_measure", HERE / "pair_measure.py")
LISTED = 10  # largest |mesh - exact| deviations listed


def _bound(value: float | None) -> float:
    return math.inf if value is None else value


def picks_per_pair(statistics: Mapping[str, Any]) -> list[dict[str, Any]]:
    """For every pair with a mesh-cleared request, the one of the smallest mesh lower bound."""
    picks = []
    for key, stats in statistics["pairs"].items():
        bound = stats.get("bound")
        if bound is not None and bound.get("mesh") is not None:
            mesh = bound["mesh"]
            picks.append({"pair": int(key), "sample": mesh["sample"], "lower": mesh["lower"], "upper": mesh["upper"]})
    return sorted(picks, key=lambda pick: pick["pair"])


def audit(chain: Any, plan: Any, picks: Sequence[Mapping[str, Any]], session: Any, mesh: Any, band: float,
          deflection: float, deadline: float, unique: bool = False) -> dict[str, Any]:
    """Measure each pick ({pair: index into plan.measured, sample: index, lower, upper}) exactly and
    check it: within its own bounds, above threshold + band - 2 x `deflection`, without overlap.
    With `unique`, a pair's picks at one relative placement are measured once, the smallest lower
    bound standing for them. {checks, failures, unmeasured}."""
    samples = {item.sample.index: item.sample for item in plan.samples}
    chosen: dict[Any, dict[str, Any]] = {}
    for pick in picks:
        a, b = pair = plan.measured[pick["pair"]]
        placement = chain.relative_transforms(samples[pick["sample"]].values, [pair])[pair]
        key = (pick["pair"], placement.rot, placement.trans) if unique else len(chosen)
        if key not in chosen or pick["lower"] < chosen[key]["lower"]:
            chosen[key] = {**pick, "placement": placement}
    items = list(chosen.values())
    requests = [pair_measure.Request(chain.pn(plan.measured[item["pair"]][0]), chain.pn(plan.measured[item["pair"]][1]),
                                     item["placement"], sample_id=item["sample"], mode="exact", require_exact=True)
                for item in items]
    outcomes = session.measure(requests, deadline=deadline) if requests else []
    checks, failures, unmeasured = [], [], 0
    for item, request, outcome in zip(items, requests, outcomes):
        a, b = pair = plan.measured[item["pair"]]
        sample = samples[item["sample"]]
        lower, upper = item["lower"], _bound(item["upper"])
        floor = max(pose.OVERLAP_GATE_MM, plan.clearing[pair]) + band - 2 * deflection
        query = mesh.query(request.a, request.b, request.placement)
        check = {"pair": [chain.ref(a), chain.ref(b)], "sample": sample.index,
                 "independent_pose": {k: round(v, 6) + 0.0 for k, v in sample.settings.items()},
                 "bound_mm": [lower, None if math.isinf(upper) else upper], "floor_mm": floor,
                 "mesh_mm": query.mesh_mm}
        if outcome is None:
            unmeasured += 1
            check.update(ok=False, error="not measured before the time limit")
        elif not isinstance(outcome, pair_measure.Measured):
            check.update(ok=False, error=getattr(outcome, "message", type(outcome).__name__))
        else:
            slack = pair_measure.SLACK_MM
            exact, overlap = outcome.distance_mm, outcome.overlap_mm3
            check.update(exact_mm=exact, overlap_mm3=overlap,
                         ok=lower - slack <= exact <= upper + slack and exact > floor and overlap == 0.0)
        checks.append(check)
        if not check["ok"]:
            failures.append(check)
    return {"checks": checks, "failures": failures, "unmeasured": unmeasured}


def per_pair(chain: Any, plan: Any, statistics: Mapping[str, Any], session: Any, mesh: Any, band: float,
             deflection: float, deadline: float) -> dict[str, Any]:
    """The sweep's own spot check: every pair's closest mesh-cleared request."""
    return audit(chain, plan, picks_per_pair(statistics), session, mesh, band, deflection, deadline)


def summary(result: Mapping[str, Any]) -> dict[str, Any]:
    """An audit as the sweep reports it: counts, the failures and the largest deviations."""
    measured = [check for check in result["checks"] if "exact_mm" in check and check["mesh_mm"] is not None]
    deviations = sorted(measured, key=lambda check: -abs(check["mesh_mm"] - check["exact_mm"]))
    return {"checked": len(result["checks"]), "failures": list(result["failures"]),
            "max_abs_mesh_minus_exact_mm": abs(deviations[0]["mesh_mm"] - deviations[0]["exact_mm"]) if deviations else None,
            "largest_deviations": deviations[:LISTED]}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Measure a sweep's mesh-cleared requests exactly")
    parser.add_argument("--hw", type=Path, required=True, help="hardware design record directory (hw/)")
    parser.add_argument("--version", required=True, help="the built version the sweep measured (vN or latest)")
    parser.add_argument("--result", type=Path, required=True, metavar="BUNDLE", help="the published sweep bundle")
    parser.add_argument("--all-mesh-poses", action="store_true",
                        help="every unique mesh-cleared pose, not each pair's closest one")
    parser.add_argument("--jobs", type=pair_measure.jobs_argument, default="1", metavar="N|auto")
    caching = parser.add_mutually_exclusive_group()
    caching.add_argument("--cache", type=Path, metavar="DIR", help="pair cache directory (default: hw/.cad)")
    caching.add_argument("--no-cache", action="store_true", help="measure every request again, using no cache")
    parser.add_argument("--time-limit", type=float, default=600.0, help="seconds before the audit stops as incomplete")
    args = parser.parse_args(argv)
    if not (math.isfinite(args.time_limit) and args.time_limit > 0):
        print("spot_check: --time-limit must be a finite number > 0", file=sys.stderr)
        return 2
    sweep = _load("cad_motion_sweep", HERE / "sweep.py")
    started = time.monotonic()
    try:
        version, version_dir, record_hw = pose.LAYOUT.built_version(args.hw, args.version)
        bundle = args.result
        problems = pose.LAYOUT.verify(bundle)
        if problems:
            raise pose.MotionError(f"{bundle} does not verify: {problems[0]}")
        try:
            statistics, provenance, _ = sweep.read_statistics(bundle / "evidence")
        except (OSError, ValueError, KeyError) as error:
            raise pose.MotionError(f"{bundle} has no readable sweep statistics (evidence/): {error}") from None
        if provenance.get("schema") != sweep.RESULT_SCHEMA:
            raise pose.MotionError(f"{bundle}: statistics schema {provenance.get('schema')!r}, expected {sweep.RESULT_SCHEMA}")
        if provenance["source_version_manifest_sha256"] != pose.input_sha256(version_dir):
            raise pose.MotionError(f"{bundle} was swept on other inputs than {version}")
        options = sweep.build_parser().parse_args(["--hw", str(args.hw), "--version", version, *provenance["argv"]])
        options.version_dir, options.record_hw = version_dir, record_hw
        if options.exact:
            raise pose.MotionError(f"{bundle} is an --exact sweep: nothing was mesh-cleared")
        run = sweep.prepare(options, version, version_dir, record_hw)
        plan = sweep.plan(run.chain, run.samples, run.pairs, run.fitted, run.requirements, options.min_clearance,
                          run.margins, selection=set())
        if [sweep.subsystems.pair_id(pair) for pair in plan.measured] != provenance["all_pair_ids"]:
            raise pose.MotionError(f"{bundle}: its pairs are not this version's; sweep it again")
        shapes = {pn: part.shape for pn, part in run.definitions.items()}
        mesh_module, mesh, description = sweep.mesh_bounds(shapes)
        if mesh is None:
            raise pose.MotionError(f"mesh bounds unavailable: {description}")
        rule = pair_measure.RuleVersion.current(mesh, options.mesh_band)
        picks = statistics["mesh_cleared"] if args.all_mesh_poses else picks_per_pair(statistics)
        cache = None if args.no_cache else pair_measure.PairCache(args.cache or pair_measure.default_cache_dir(args.hw))
        measurer = pair_measure.PairMeasurer(shapes, geometry_ids=pose.geometry_ids(run.definitions), rule=rule,
                                             jobs=args.jobs, cache=cache, mesh=mesh)
        deadline = time.monotonic() + args.time_limit
        try:
            with measurer.session(None) as session:
                found = audit(run.chain, plan, picks, session, mesh, options.mesh_band,
                              mesh_module.LINEAR_DEFLECTION_MM, deadline, unique=args.all_mesh_poses)
        finally:
            if cache is not None:
                cache.close()
        report = summary(found)
        status = "incomplete" if found["unmeasured"] else ("fail" if found["failures"] else "pass")
        print(json.dumps({"status": status, "mode": "all_mesh_poses" if args.all_mesh_poses else "per_pair",
                          "bundle": str(bundle), "mesh_cleared_requests": len(statistics["mesh_cleared"]),
                          **report, "unmeasured": found["unmeasured"], "band_mm": options.mesh_band,
                          "deflection_mm": mesh_module.LINEAR_DEFLECTION_MM, "cache": not args.no_cache,
                          "rule_sha256": {"sweep": provenance["rule_sha256"], "audit": rule.digest.hex()},
                          "seconds": round(time.monotonic() - started, 2)}, indent=2))
        return {"pass": 0, "fail": 1}.get(status, 2)
    except (pose.MotionError, OSError, pose.LAYOUT.LayoutError) as error:
        print(f"spot_check: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # a kernel failure is infrastructure, never an audit result
        traceback.print_exc()
        sys.exit(2)
