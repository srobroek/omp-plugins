# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["cadquery-ocp-novtk==8.0.1.1.0", "pyyaml>=6.0", "trimesh==4.*", "numpy>=1.26"]
# ///
"""Build, check, and diff versions of a hardware design from its part model scripts.

Usage:
    uv run --script cad_model.py run <hw-dir> --label vN [--kernel auto|cadquery|build123d]
                                     [--attach PN=PARENT_PN ...]
    uv run --script cad_model.py check vN --hw hw [--out FILE]
       [--pair PN:PN ...] [--allow-interference PN:PN ...] [--expect-solids PN=N ...]
    uv run --script cad_model.py diff vA vB [--hw HW] [--out FILE]

run   executes every hw/parts/<PN>/model.py in its declared kernel's own uv environment
      (run_cadquery.py, run_build123d.py), then writes hw/versions/vN/:
        parts/<PN>.step   AP242, one product named "<PN> <title>", zero pose
        assembly.step     AP242, top product "<product id> vN" placing every part at the
                          joints' nominal pose (cad-motion pose.py)
        assembly.glb      binary glTF of assembly.step, metres, +Y up, node names = products
        part-map.json     PN -> glTF node and mesh names
        metrics.json      per part: volume, area, bbox, solids, holes, mass from assets/materials.yaml
        manifest.json     per part: kernel, model path, source sha256, params, kernel volume;
                          tool versions per environment; pose; joint pairs with joint id and type;
                          file hashes
      and hw/versions/latest.json pointing at that version (paths relative to hw/). Labels
      increase: an existing label or one below the newest built version is refused.
check runs the geometry checks on a built version; diff compares two built versions.

stdout: one JSON document. stderr: diagnostics.
Exit codes: 0 pass, 1 a part model failed (run) or a blocking check failed (check),
2 usage or infrastructure error.
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path

from cadmodel import build


def _pair(text: str) -> tuple[str, str]:
    a, sep, b = text.partition(":")
    if not sep or not build.is_pn(a) or not build.is_pn(b) or a == b:
        raise argparse.ArgumentTypeError(f"expected PN:PN, got {text!r}")
    return a, b


def _expect(text: str) -> tuple[str, int]:
    pn, sep, n = text.partition("=")
    if not sep or not build.is_pn(pn) or not n.isdigit():
        raise argparse.ArgumentTypeError(f"expected PN=COUNT, got {text!r}")
    return pn, int(n)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="Build, check, and diff CAD design versions")
    sub = root.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="build hw/versions/<label>/ from the part model scripts")
    run.add_argument("hw", type=Path, help="hardware design record directory (hw/)")
    run.add_argument("--label", required=True, help="version label: v1, v2, ...")
    run.add_argument("--kernel", choices=("auto", *build.KERNELS), default="auto",
                     help="auto: each part's declared KERNEL; otherwise every part must declare this kernel")
    run.add_argument("--attach", action="append", default=[], metavar="PN=PARENT_PN",
                     help="rigidly attach a part without a joint (repeatable)")
    check = sub.add_parser("check", help="geometry checks on a built version")
    check.add_argument("label")
    check.add_argument("--hw", type=Path, default=Path("hw"))
    check.add_argument("--pair", action="append", type=_pair, metavar="PN:PN",
                       help="check only these pairs for interference (default: all pairs)")
    check.add_argument("--allow-interference", action="append", type=_pair, default=[], metavar="PN:PN",
                       help="undeclared intentional overlap: reported, not blocking (repeatable)")
    check.add_argument("--expect-solids", action="append", type=_expect, default=[], metavar="PN=N",
                       help="expected solid count; overrides the previous version as baseline")
    check.add_argument("--out", type=Path, help="also write the result JSON here")
    diff = sub.add_parser("diff", help="compare two built versions")
    diff.add_argument("a")
    diff.add_argument("b")
    diff.add_argument("--hw", type=Path, default=Path("hw"))
    diff.add_argument("--out", type=Path, help="also write the result JSON here")
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    from cadmodel.motion import load_pose

    pose = load_pose()
    try:
        with pose.stdout_to_stderr():
            if args.command == "run":
                code, result = build.run(args.hw, args.label, args.kernel, args.attach)
            elif args.command == "check":
                from cadmodel.check import check

                code, result = check(args.hw, args.label, args.pair, args.allow_interference, dict(args.expect_solids))
            else:
                from cadmodel.diff import diff

                code, result = diff(args.hw, args.a, args.b)
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
