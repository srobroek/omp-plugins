# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["cadquery-ocp-novtk==8.0.1.1.0", "pyyaml>=6.0", "trimesh==4.*", "numpy>=1.26"]
# ///
"""Build, check, and diff versions of a hardware design from its part model scripts.

Usage:
    uv run --script skill://cad-flow/scripts/run.py cad-model/scripts/cad_model.py run <hw-dir> --label vN [--kernel auto|cadquery|build123d]
                                     [--attach REF=PARENT_REF ...]
    uv run --script skill://cad-flow/scripts/run.py cad-model/scripts/cad_model.py check vN --hw hw [--out FILE]
       [--pair REF:REF ...] [--allow-interference REF:REF ...] [--expect-solids PN=N ...] [--jobs 1|N|auto]
       [--cache DIR | --no-cache]
    uv run --script skill://cad-flow/scripts/run.py cad-model/scripts/cad_model.py diff vA vB [--hw HW] [--out FILE]
    uv run --script skill://cad-flow/scripts/run.py cad-model/scripts/cad_model.py latest <hw-dir> --label vN

A REF is a PN placed once, or `@id` for one occurrence of hw/assembly.yaml.

run   executes every hw/parts/<PN>/model.py in its declared kernel's own uv environment
      (run_cadquery.py, run_build123d.py), then writes hw/versions/vN/:
        parts/<PN>.step   AP242, one product named "<PN> <title>": the definition, in the
                          part's model_frame
        assembly.step     AP242, top product "<product id> vN" with one product per PN and one
                          component per occurrence at the joints' nominal pose (cad-motion pose.py)
        assembly.glb      binary glTF of assembly.step, metres, +Y up, one node per occurrence
        part-map.json     occurrence -> glTF nodes and meshes, plus the PN aggregate
        metrics.json      per PN: volume, area, bbox, solids, holes, mass from assets/materials.yaml;
                          per occurrence: placement, placed bbox, centre and holes; totals by quantity
        manifest.json     per PN: kernel, model frame, model path, source and record sha256, params,
                          kernel volume; occurrences with rest placements; tool versions; pose
                          (values, placements, motions); joints and joint pairs; the record
                          snapshot; the manufacturing entry of each custom-made PN; file hashes
        record/           the product, interface, assembly and part records the version was built from
        manufacturing/<PN>/  every custom-made PN: part.step (AP242, mm), part.stl (FDM: binary, mm)
                          and manufacturing.json, in the state model.py build_manufacture defines
                          (else the installed definition), placed on the printer bed for FDM
      and hw/versions/latest.json pointing at that version (paths relative to hw/). Labels
      increase: an existing label or one below the newest built version is refused. A part whose
      manufacturing output fails a blocking check fails the run: no version, latest unchanged.
check runs the geometry checks on a built version; diff compares two built versions.
latest points hw/versions/latest.json at the newest built version after `run` sealed it but could
      not write the pointer; it verifies the version against its manifest first and rebuilds nothing.

stdout: one JSON document. stderr: diagnostics.
Exit codes: 0 pass, 1 a part model or a manufacturing output failed (run) or a blocking check failed
(check), 2 usage or infrastructure error.
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path

from cadmodel import build


def _pair(text: str) -> tuple[str, str]:
    from cadmodel.motion import load_pose

    a, sep, b = text.partition(":")
    if not sep or not load_pose().is_ref(a) or not load_pose().is_ref(b) or a == b:
        raise argparse.ArgumentTypeError(f"expected REF:REF (a PN or @occurrence each), got {text!r}")
    return a, b


def _expect(text: str) -> tuple[str, int]:
    pn, sep, n = text.partition("=")
    if not sep or not build.is_pn(pn) or not n.isdigit():
        raise argparse.ArgumentTypeError(f"expected PN=COUNT, got {text!r}")
    return pn, int(n)


def _jobs(text: str) -> int:
    from cadmodel.motion import load_pair_measure

    return load_pair_measure().jobs_argument(text)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="Build, check, and diff CAD design versions")
    sub = root.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="build hw/versions/<label>/ from the part model scripts")
    run.add_argument("hw", type=Path, help="hardware design record directory (hw/)")
    run.add_argument("--label", required=True, help="version label: v1, v2, ...")
    run.add_argument("--kernel", choices=("auto", *build.KERNELS), default="auto",
                     help="auto: each part's declared KERNEL; otherwise every part must declare this kernel")
    run.add_argument("--attach", action="append", default=[], metavar="REF=PARENT_REF",
                     help="rigidly attach an occurrence without a joint (a PN or @id; repeatable)")
    check = sub.add_parser("check", help="geometry checks on a built version")
    check.add_argument("label")
    check.add_argument("--hw", type=Path, default=Path("hw"))
    check.add_argument("--pair", action="append", type=_pair, metavar="REF:REF",
                       help="check only these occurrence pairs for interference (default: all pairs)")
    check.add_argument("--allow-interference", action="append", type=_pair, default=[], metavar="REF:REF",
                       help="undeclared intentional overlap: reported, not blocking (repeatable)")
    check.add_argument("--expect-solids", action="append", type=_expect, default=[], metavar="PN=N",
                       help="expected solid count; overrides the previous version as baseline")
    check.add_argument("--out", type=Path, help="also write the result JSON here")
    check.add_argument("--jobs", type=_jobs, default="1", metavar="N|auto",
                       help="worker processes measuring pairs (1, the default: this process, on OCCT's thread pool; "
                            "auto: the CPU count, at most 8)")
    caching = check.add_mutually_exclusive_group()
    caching.add_argument("--cache", type=Path, metavar="DIR",
                         help="pair measurement cache shared with cad-motion sweep.py (default: "
                              "$XDG_CACHE_HOME/cad-motion, else ~/.cache/cad-motion)")
    caching.add_argument("--no-cache", action="store_true", help="measure every pair, reading and writing no cache")
    diff = sub.add_parser("diff", help="compare two built versions")
    diff.add_argument("a")
    diff.add_argument("b")
    diff.add_argument("--hw", type=Path, default=Path("hw"))
    diff.add_argument("--out", type=Path, help="also write the result JSON here")
    latest = sub.add_parser("latest", help="point hw/versions/latest.json at the newest sealed version")
    latest.add_argument("hw", type=Path, help="hardware design record directory (hw/)")
    latest.add_argument("--label", required=True, help="the sealed version label the pointer write failed for")
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    from cadmodel.motion import load_pair_measure, load_pose

    pose = load_pose()
    try:
        with pose.stdout_to_stderr():
            if args.command == "run":
                code, result = build.run(args.hw, args.label, args.kernel, args.attach)
            elif args.command == "check":
                from cadmodel.check import check

                cache_dir = None if args.no_cache else (args.cache or load_pair_measure().default_cache_dir())
                code, result = check(args.hw, args.label, args.pair, args.allow_interference, dict(args.expect_solids),
                                     cache_dir, args.jobs)
            elif args.command == "diff":
                from cadmodel.diff import diff

                code, result = diff(args.hw, args.a, args.b)
            else:
                code, result = build.reconcile_latest(args.hw, args.label)
    except (build.UsageError, pose.MotionError, OSError) as error:
        print(f"cad_model {args.command}: {error}", file=sys.stderr)
        return 2
    except Exception:  # noqa: BLE001 - an unexpected failure is no result, never a check failure
        traceback.print_exc()
        return 2
    text = json.dumps(result, indent=2)
    if getattr(args, "out", None):
        args.out.write_text(text + "\n", encoding="utf-8")
    print(text)
    return code


if __name__ == "__main__":
    sys.exit(main())
