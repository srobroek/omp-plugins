"""What a STEP file declares in its text: its schema and its length unit; and the read-back drift rule."""

from __future__ import annotations

import re
from pathlib import Path

AP242 = "AP242_MANAGED_MODEL_BASED_3D_ENGINEERING"
READBACK_REL = 1e-6  # STEP read-back volume vs the kernel's in-memory volume
SCHEMA_LINE = re.compile(r"FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'")
# An SI length unit: ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) ), the prefix `$` for metres.
SI_LENGTH = re.compile(r"LENGTH_UNIT\s*\(\s*\)\s*NAMED_UNIT\s*\(\s*\*\s*\)\s*SI_UNIT\s*\(\s*(\$|\.[A-Z]+\.)\s*,\s*\.METRE\.\s*\)")
PREFIXES = {"$": "m", ".MILLI.": "mm", ".CENTI.": "cm", ".MICRO.": "um", ".KILO.": "km"}


def schema(path: Path) -> str | None:
    """The first FILE_SCHEMA entry of the header, or None."""
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        match = SCHEMA_LINE.search(handle.read(8192))
    return match.group(1) if match else None


def length_units(path: Path) -> list[str]:
    """Every length unit the file declares, sorted: `mm` for SI_UNIT(.MILLI.,.METRE.); a unit that is not an SI
    length (an inch conversion, say) reads as `other`."""
    text = path.read_text(encoding="utf-8", errors="replace")
    found = {PREFIXES.get(prefix, prefix) for prefix in SI_LENGTH.findall(text)}
    if text.count("LENGTH_UNIT") > len(SI_LENGTH.findall(text)):
        found.add("other")
    return sorted(found)
