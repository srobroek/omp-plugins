# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6.0"]
# ///
"""Check that a trial left a valid design record containing the expected part.

Usage: uv run --script record_check.py <hw-dir> --pn <PN> [--validator <validate.py>]

Two questions, answered separately:
  part_present  hw/parts/<PN>/part.yaml and model.py exist and part.yaml names <PN>.
  valid         the record validates. With --validator (cad-record's validate.py),
                that script decides: `uv run --script validate.py <hw-dir>`, exit
                0 valid, 1 invalid, 2 infrastructure error. Without it, a builtin
                check applies the shared-contract rules for product.yaml and every
                part.yaml (PN and rev patterns, process enum).

stdout: {"part_present": bool, "valid": bool, "validator": "cad-record"|"builtin",
         "problems": [str]}
Exit 0 = both hold; 1 = a check failed; 2 = usage or validator infrastructure error.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

import yaml

PN = re.compile(r"^[A-Z]{2,5}-\d{4}$")
REV = re.compile(r"^(X[1-9]\d*|[A-HJ-NPRTUVWY])$")
PROCESSES = {"fdm", "cnc", "purchased"}
RIGOR = {"maker", "pro", "regulated"}
REGIME = {"iso", "asme"}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("hw", type=Path)
    parser.add_argument("--pn", required=True)
    parser.add_argument("--validator", type=Path)
    args = parser.parse_args(argv[1:])

    problems: list[str] = []
    present = part_present(args.hw, args.pn, problems)
    if args.validator:
        valid, infra = run_validator(args.validator, args.hw, problems)
        if infra:
            print("\n".join(problems), file=sys.stderr)
            return 2
        validator = "cad-record"
    else:
        valid = builtin_valid(args.hw, problems)
        validator = "builtin"
    json.dump({"part_present": present, "valid": valid, "validator": validator, "problems": problems}, sys.stdout, sort_keys=True)
    sys.stdout.write("\n")
    return 0 if present and valid else 1


def _load(path: Path, problems: list[str]):
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        problems.append(f"{path.name}: unreadable ({type(exc).__name__})")
        return None


def part_present(hw: Path, pn: str, problems: list[str]) -> bool:
    part_dir = hw / "parts" / pn
    if not (part_dir / "part.yaml").is_file():
        problems.append(f"parts/{pn}/part.yaml missing")
        return False
    if not (part_dir / "model.py").is_file():
        problems.append(f"parts/{pn}/model.py missing")
        return False
    data = _load(part_dir / "part.yaml", problems)
    if not isinstance(data, dict) or data.get("PN", data.get("pn")) != pn:
        problems.append(f"parts/{pn}/part.yaml does not name PN {pn}")
        return False
    return True


def run_validator(validator: Path, hw: Path, problems: list[str]) -> tuple[bool, bool]:
    """Return (valid, infrastructure_error)."""
    try:
        done = subprocess.run(
            ["uv", "run", "--script", str(validator), str(hw)], capture_output=True, text=True, timeout=300, check=False
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        problems.append(f"validator did not run: {exc}")
        return False, True
    if done.returncode == 2:
        problems.append(f"validator infrastructure error: {done.stderr.strip()[-500:]}")
        return False, True
    if done.returncode != 0:
        problems.append(f"validator rejected the record: {(done.stdout or done.stderr).strip()[-500:]}")
    return done.returncode == 0, False


def builtin_valid(hw: Path, problems: list[str]) -> bool:
    start = len(problems)
    product = _load(hw / "product.yaml", problems) if (hw / "product.yaml").is_file() else None
    if not isinstance(product, dict):
        problems.append("product.yaml missing or not a mapping")
    else:
        if not product.get("id"):
            problems.append("product.yaml: id missing")
        if product.get("units") != "mm":
            problems.append("product.yaml: units must be mm")
        if product.get("rigor", "pro") not in RIGOR:
            problems.append("product.yaml: rigor must be maker|pro|regulated")
        if product.get("regime") not in REGIME:
            problems.append("product.yaml: regime must be iso|asme")
    for part_yaml in sorted((hw / "parts").glob("*/part.yaml")):
        data = _load(part_yaml, problems)
        name = part_yaml.parent.name
        if not isinstance(data, dict):
            problems.append(f"parts/{name}/part.yaml is not a mapping")
            continue
        pn = data.get("PN", data.get("pn"))
        if not isinstance(pn, str) or not PN.fullmatch(pn) or pn != name:
            problems.append(f"parts/{name}: PN {pn!r} must match {PN.pattern} and the directory name")
        rev = data.get("rev")
        if not isinstance(rev, str) or not REV.fullmatch(rev):
            problems.append(f"parts/{name}: rev {rev!r} must match {REV.pattern}")
        if data.get("process") not in PROCESSES:
            problems.append(f"parts/{name}: process must be fdm|cnc|purchased")
        if not data.get("title"):
            problems.append(f"parts/{name}: title missing")
    return len(problems) == start


if __name__ == "__main__":
    sys.exit(main(sys.argv))
