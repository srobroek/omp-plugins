# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["cadquery-ocp-novtk==8.0.1.1.0", "pyyaml>=6.0", "numpy>=1.26", "python-fcl==0.7.0.11"]
# ///
"""Merge subsystem sweeps of one version into the whole sweep's result.

Usage:
    uv run --script skill://cad-flow/scripts/run.py cad-motion/scripts/merge_sweeps.py --hw HW --version vN
        --case NAME --inputs BUNDLE [BUNDLE ...] [--replace]

Each input is a published sweep bundle of `--version` run with `--subsystem` (sweep.py), together
covering every owner of the partition: every subassembly, `interface` and `static`. One input is
enough when its owners own every pair. The merge refuses,
before it writes anything, inputs that were swept on other inputs, options, partition, rule or code
(evidence/partition.json), that did not finish their samples, that leave a pair out or measure one
twice, or whose samples differ. It then reduces their untruncated statistics (evidence/) with the
sweep's own reducer: collisions per global sample from every input, the worst case over the merged
samples (a pose one subsystem finds safe may collide in another, so no input's worst pose is copied),
clearances, requirements, limits and margins with the sweep's own tie-breaks, the between-sample
proofs by conjunction (continuous.merge), the spot checks and suspect measurements united. The
result, published as the bundle `hw/motion/vN/NAME` with the worst pose posed again, is the one the
whole sweep gives, but for its timings and cache counters, which are operational and listed per
input, and its `scope.merged_from`.

stdout: the merged result JSON. Exit 0 = pass, 1 = a finding, 2 = refused inputs or another error,
or an incomplete between-sample proof.
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import importlib.util
import json
import sys
import time
import traceback
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
sweep = _load("cad_motion_sweep", HERE / "sweep.py")
pose, subsystems, continuous = sweep.pose, sweep.subsystems, sweep.continuous
AGREED = ("rule_sha256", "partition_sha256", "source_version_manifest_sha256", "equivalence_sha256", "all_pair_ids")


class MergeError(pose.MotionError):
    """The inputs cannot be merged into one whole sweep."""


@dataclasses.dataclass(frozen=True)
class Input:
    bundle: Path
    result: dict[str, Any]
    statistics: dict[str, Any]
    provenance: dict[str, Any]
    audit: dict[str, Any]
    manifest_sha256: str


def read_input(bundle: Path) -> Input:
    problems = pose.LAYOUT.verify(bundle)
    if problems:
        raise MergeError(f"{bundle} does not verify: {problems[0]}")
    try:
        result = json.loads((bundle / "result.json").read_text(encoding="utf-8"))
        statistics, provenance, audit = sweep.read_statistics(bundle / "evidence")
    except (OSError, ValueError, KeyError) as error:
        raise MergeError(f"{bundle} has no readable sweep statistics (evidence/): {error}") from None
    digest = hashlib.sha256((bundle / "manifest.json").read_bytes()).hexdigest()
    return Input(bundle, result, statistics, provenance, audit, digest)


def check_inputs(inputs: list[Input], version_dir: Path) -> None:
    """Refuse inputs that cannot form exactly one whole sweep: MergeError names the first problem."""
    first = inputs[0].provenance
    for item in inputs:
        provenance = item.provenance
        if provenance.get("schema") != sweep.RESULT_SCHEMA:
            raise MergeError(f"{item.bundle}: statistics schema {provenance.get('schema')!r}, expected {sweep.RESULT_SCHEMA}")
        if provenance["partition_sha256"] is None:
            raise MergeError(f"{item.bundle}: its record has no valid subsystem partition")
        coverage = provenance["coverage"]
        if not (coverage["complete"] and coverage["full_domain"]):
            raise MergeError(f"{item.bundle}: not a complete sweep of every sample (smoke, changed-only or stopped)")
        if not provenance["subsystem_filter"]:
            raise MergeError(f"{item.bundle}: a whole sweep, not a subsystem sweep")
        for key in AGREED:
            if provenance[key] != first[key]:
                raise MergeError(f"{item.bundle} and {inputs[0].bundle} differ in {key}: they are not runs of one sweep")
    if first["source_version_manifest_sha256"] != pose.input_sha256(version_dir):
        raise MergeError("the inputs were swept on other inputs than this version")
    if first["equivalence"]["producers"] != sweep.producer_hashes():
        raise MergeError("the inputs were swept by other cad-motion code; sweep them again")
    seen: dict[str, Path] = {}
    for item in inputs:
        for pair in item.provenance["pair_ids"]:
            if pair in seen:
                raise MergeError(f"pair {pair} is in both {seen[pair]} and {item.bundle}")
            seen[pair] = item.bundle
    missing = [pair for pair in first["all_pair_ids"] if pair not in seen]
    if missing:
        raise MergeError(f"{len(missing)} pairs are in no input, first {missing[0]}; add the sweep of its subsystem")


def merged_audit(inputs: list[Input], order: dict[tuple[str, ...], int]) -> dict[str, Any] | None:
    if all(item.result.get("spot_check") is None for item in inputs):
        return None

    def ordered(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return sorted(rows, key=lambda row: (order[tuple(row["pair"])], row["sample"]))

    return {"checks": ordered([row for item in inputs for row in item.audit.get("checks", [])]),
            "failures": ordered([row for item in inputs for row in item.audit.get("failures", [])]), "unmeasured": 0}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Merge subsystem sweeps into the whole sweep's result")
    parser.add_argument("--hw", type=Path, required=True, help="hardware design record directory (hw/)")
    parser.add_argument("--version", required=True, help="the built version the inputs swept (vN or latest)")
    parser.add_argument("--case", required=True, help="the merged bundle's case ID")
    parser.add_argument("--inputs", type=Path, nargs="+", required=True, metavar="BUNDLE",
                        help="published subsystem sweep bundles covering every owner")
    parser.add_argument("--replace", action="store_true", help="retain and replace a different recipe")
    args = parser.parse_args(argv)
    started = time.monotonic()
    try:
        version, version_dir, record_hw = pose.LAYOUT.built_version(args.hw, args.version)
        inputs = [read_input(bundle) for bundle in args.inputs]
        check_inputs(inputs, version_dir)
        provenance = inputs[0].provenance
        extra = ["--replace"] if args.replace else []
        options = sweep.build_parser().parse_args(["--hw", str(args.hw), "--version", version, "--case", args.case,
                                                   *provenance["argv"], *extra])
        options.version, options.version_dir, options.record_hw = version, version_dir, record_hw
        pose.LAYOUT.resolve(args.hw, "bundle.motion", V=version, S=args.case)
        guard = sweep.claim_run(args.hw, f"{version}/{args.case}")
        try:
            return merge(options, inputs, version, version_dir, record_hw, started)
        finally:
            if guard is not None:
                guard.release()
    except ValueError as error:  # combine_statistics and continuous.merge refuse mismatched inputs
        print(f"merge_sweeps: {error}", file=sys.stderr)
        return 2
    except (pose.MotionError, OSError, pose.LAYOUT.LayoutError, pose.LAYOUT.PublishConflict) as error:
        print(f"merge_sweeps: {error}", file=sys.stderr)
        return 2


def merge(options: argparse.Namespace, inputs: list[Input], version: str, version_dir: Path, record_hw: Path,
          started: float) -> int:
    provenance = inputs[0].provenance
    run = sweep.prepare(options, version, version_dir, record_hw)
    if run.partition is None or run.partition.digest() != provenance["partition_sha256"]:
        raise MergeError("the record's subsystem partition is not the one the inputs were swept with")
    plan = sweep.plan(run.chain, run.samples, run.pairs, run.fitted, run.requirements, options.min_clearance,
                      run.margins, selection=set())
    if [subsystems.pair_id(pair) for pair in plan.measured] != provenance["all_pair_ids"]:
        raise MergeError("the inputs' pairs are not this version's")
    plan = dataclasses.replace(plan, selected=list(range(len(plan.measured))))
    statistics = sweep.combine_statistics([item.statistics for item in inputs])
    if [row["index"] for row in statistics["samples"]] != [sample.index for sample in run.samples]:
        raise MergeError("the inputs' samples are not this sweep's")
    broad_phase = inputs[0].result["broad_phase"]
    if any(item.result["broad_phase"] != broad_phase for item in inputs):
        raise MergeError("the inputs differ in their broad phase")
    chain = run.chain
    order = {tuple(chain.ref(oid) for oid in pair): index for index, pair in enumerate(plan.measured)}
    suspects = sorted((row for item in inputs for row in item.result["suspect_measurements"]),
                      key=lambda row: (row["sample"], order[tuple(row["pair"])]))
    between = continuous.merge([item.result["continuous"] for item in inputs])
    merging = time.monotonic()
    periods = sweep.detect_periods(run)
    timings = {"merge": round(time.monotonic() - started, 2), "periods": round(time.monotonic() - merging, 2),
               "inputs": {str(item.bundle): item.result.get("timings_s", {}) for item in inputs}}
    audit = merged_audit(inputs, order)
    result, state = sweep.report(run, plan, statistics, broad_phase=broad_phase, suspects=suspects, audit=audit,
                                 between=between, complete=True, periods=periods, timings=timings)
    result["scope"]["merged_from"] = [{"bundle": str(item.bundle), "subsystems": item.provenance["subsystem_filter"],
                                       "manifest_sha256": item.manifest_sha256} for item in inputs]
    recipe = {**provenance["equivalence"], "case": options.case, "subsystem": None,
              "merged_from": sorted(item.manifest_sha256 for item in inputs)}
    merged = {**provenance, "subsystem_filter": None, "pair_ids": list(provenance["all_pair_ids"]),
              "merged_from": result["scope"]["merged_from"]}
    sweep.publish(run, result, state, recipe, (statistics, merged, audit), True, producer="cad-motion merge_sweeps.py")
    result["timings_s"]["total"] = round(time.monotonic() - started, 2)
    print(json.dumps(result, indent=2))
    return sweep.exit_code(result["status"])


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # an OCCT failure is infrastructure, never a merge result
        traceback.print_exc()
        sys.exit(2)
