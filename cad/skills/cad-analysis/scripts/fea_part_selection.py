"""FreeCAD-independent STEP solid selection for static analysis."""

from __future__ import annotations

import re
from collections.abc import Sequence


_PART_NAME = re.compile(r"^([A-Z]{2,5}-\d{4})(?![0-9])")


def select_solid_index(names_by_solid: Sequence[Sequence[str]], part: str | None) -> int:
    """Select one STEP solid by cad-model's PN-first product or label names."""
    available = sorted({
        match.group(1)
        for names in names_by_solid
        for name in names
        if (match := _PART_NAME.match(name)) is not None
    })
    listed = ", ".join(available) if available else "(none recognized)"

    if part is None:
        if len(names_by_solid) == 1:
            return 0
        if not names_by_solid:
            raise ValueError("STEP contains no solid geometry")
        raise ValueError(f"STEP contains {len(names_by_solid)} solids; part is required. Available PNs: {listed}")

    matches = [
        index
        for index, names in enumerate(names_by_solid)
        if any((match := _PART_NAME.match(name)) is not None and match.group(1) == part for name in names)
    ]
    if not matches:
        raise ValueError(f"part {part!r} matches no STEP solid. Available PNs: {listed}")
    if len(matches) > 1:
        raise ValueError(f"part {part!r} matches {len(matches)} STEP solids. Available PNs: {listed}")
    return matches[0]
