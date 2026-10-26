"""Shared lookup for the FreeCAD command-line executable."""

from __future__ import annotations

import os
import shutil
from pathlib import Path


MACOS_FREECADCMD = Path("/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd")


def find_freecad(explicit: Path | None = None) -> Path | None:
    """Find an executable FreeCAD command, preferring explicit, env, PATH, then bundle."""
    candidates = (explicit, os.environ.get("FREECADCMD"), shutil.which("freecadcmd"), MACOS_FREECADCMD)
    for candidate in candidates:
        if candidate is None:
            continue
        path = Path(candidate)
        if path.is_file() and os.access(path, os.X_OK):
            return path
    return None
