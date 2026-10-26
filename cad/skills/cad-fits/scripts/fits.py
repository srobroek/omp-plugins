# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""ISO 286 limits of size and fit classification (hole basis).

Usage: uv run --script fits.py SIZE FIT [--expect clearance|transition|interference]

SIZE is the nominal size in mm, 0 < SIZE <= 120. FIT is a hole-basis fit such
as H7/g6, or a single tolerance class (H7, g6). Coverage: hole H and shafts
c, d, f, g, h, js, k, m, n, p, s in grades IT6 to IT11, from the ISO 286-1:2010
tables in ../data/iso286.json (provenance in ../data/README.md).

Hole H: EI = 0, ES = IT. Shafts c-h: es = fundamental deviation, ei = es - IT.
Shafts k-s: ei = fundamental deviation, es = ei + IT. js: +/- IT/2 with
half-micrometre precision, as ISO 286-1:2010 Figure 9 and ISO 286-2:2010 print it.

Fit: max_clearance = ES - ei, min_clearance = EI - es; a negative clearance is
an interference. Clearance fit: min_clearance >= 0. Interference fit:
max_clearance <= 0. Otherwise transition (ISO 286-1:2010 3.3.1-3.3.2).

stdout: JSON result. stderr: diagnostics.
Exit 0 = computed (and matches --expect), 1 = classification differs from
--expect, 2 = usage error or a size/class outside the covered tables.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from functools import cache
from pathlib import Path
from typing import Any

DATA = Path(__file__).resolve().parent.parent / "data" / "iso286.json"
CLASS_PATTERN = re.compile(r"^(H|c|d|f|g|h|js|k|m|n|p|s)(\d{1,2})$")
FIT_TYPES = ("clearance", "transition", "interference")
MICRON = Decimal("0.001")


class FitError(ValueError):
    """The size or tolerance class is outside the covered tables."""


@cache
def table() -> dict[str, Any]:
    return json.loads(DATA.read_text(encoding="utf-8"))


def _range_index(size: Decimal, bounds: list[int]) -> int:
    if size <= 0:
        raise FitError(f"nominal size must be above 0 mm, got {size}")
    for index, upper in enumerate(bounds):
        if size <= upper:
            return index
    raise FitError(f"nominal size {size} mm is above the covered {bounds[-1]} mm")


def _parse_class(text: str) -> tuple[str, int]:
    match = CLASS_PATTERN.match(text)
    if not match:
        raise FitError(f"unsupported tolerance class {text!r}; covered: H and c d f g h js k m n p s")
    letter, grade = match.group(1), int(match.group(2))
    if str(grade) not in table()["it"]:
        raise FitError(f"grade IT{grade} in {text!r} is outside the covered IT6-IT11")
    return letter, grade


@dataclass(frozen=True)
class Limits:
    """Limit deviations (micrometres) of one tolerance class at one nominal size."""

    designation: str
    is_hole: bool
    size: Decimal
    it: Decimal
    upper: Decimal
    lower: Decimal

    def as_dict(self) -> dict[str, Any]:
        return {
            "class": self.designation,
            "IT_um": _num(self.it),
            "upper_deviation_um": _num(self.upper),
            "lower_deviation_um": _num(self.lower),
            "max_mm": _num(self.size + self.upper * MICRON),
            "min_mm": _num(self.size + self.lower * MICRON),
        }


def tolerance_class(size: Decimal, text: str) -> Limits:
    """Limit deviations and limits of size for one tolerance class."""
    data = table()
    letter, grade = _parse_class(text)
    it = Decimal(data["it"][str(grade)][_range_index(size, data["it_upper_bounds_mm"])])
    dev = _range_index(size, data["deviation_upper_bounds_mm"])
    if letter == "H":
        lower = Decimal(0)
        upper = it
    elif letter == "js":
        upper, lower = it / 2, -it / 2
    elif letter in data["shaft_es"]:
        upper = Decimal(data["shaft_es"][letter][dev])
        lower = upper - it
    elif letter == "k":
        column = "grades_4_to_7" if 4 <= grade <= 7 else "other_grades"
        lower = Decimal(data["shaft_ei"]["k"][column][dev])
        upper = lower + it
    else:
        lower = Decimal(data["shaft_ei"][letter][dev])
        upper = lower + it
    return Limits(text, letter == "H", size, it, upper, lower)


def _num(value: Decimal) -> int | float:
    value = value.normalize()
    return int(value) if value == value.to_integral_value() else float(value)


def classify(max_clearance: Decimal, min_clearance: Decimal) -> str:
    if min_clearance >= 0:
        return "clearance"
    if max_clearance <= 0:
        return "interference"
    return "transition"


def evaluate(size: Decimal, fit: str) -> dict[str, Any]:
    """Compute one tolerance class or a hole/shaft fit at a nominal size."""
    parts = fit.split("/")
    if len(parts) > 2 or not all(parts):
        raise FitError(f"fit must be HOLE/SHAFT or one class, got {fit!r}")
    classes = [tolerance_class(size, part) for part in parts]
    result: dict[str, Any] = {"nominal_mm": _num(size), "standard": table()["standard"]}
    if len(classes) == 1:
        only = classes[0]
        result["hole" if only.is_hole else "shaft"] = only.as_dict()
        return result
    hole, shaft = classes
    if not hole.is_hole or shaft.is_hole:
        raise FitError(f"fit {fit!r} must be a hole class H then a shaft class")
    max_clearance = hole.upper - shaft.lower
    min_clearance = hole.lower - shaft.upper
    result.update(
        hole=hole.as_dict(),
        shaft=shaft.as_dict(),
        fit={
            "designation": fit,
            "max_clearance_um": _num(max_clearance),
            "min_clearance_um": _num(min_clearance),
            "type": classify(max_clearance, min_clearance),
        },
    )
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="ISO 286 limits of size and fit classification")
    parser.add_argument("size", help="nominal size in mm, 0 < size <= 120")
    parser.add_argument("fit", help="hole-basis fit such as H7/g6, or one class such as g6")
    parser.add_argument("--expect", choices=FIT_TYPES, help="required fit type; exit 1 when it differs")
    args = parser.parse_args(argv)
    try:
        size = Decimal(args.size)
        if not size.is_finite():
            raise InvalidOperation
    except InvalidOperation:
        print(f"fits: size must be a number in mm, got {args.size!r}", file=sys.stderr)
        return 2
    try:
        result = evaluate(size, args.fit)
    except FitError as error:
        print(f"fits: {error}", file=sys.stderr)
        return 2
    if args.expect and "fit" not in result:
        print("fits: --expect needs a HOLE/SHAFT fit", file=sys.stderr)
        return 2
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")
    if args.expect and result["fit"]["type"] != args.expect:
        print(f"fits: {args.fit} at {args.size} mm is {result['fit']['type']}, expected {args.expect}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
