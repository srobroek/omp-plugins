"""Resolve the TechDraw lettering font used for deterministic model text."""

from __future__ import annotations

import functools
import hashlib
import os
import shutil
from pathlib import Path


OSIFONT_SHA256 = "f681b2419818198a8421b9db01602862367dbc3338c0e8e963fda73f545262b8"
OSIFONT_RELATIVE_PATH = Path("Mod/TechDraw/Resources/fonts/osifont-lgpl3fe.ttf")
MACOS_FREECADCMD = Path("/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd")


def _freecadcmds() -> list[Path]:
    candidates = [os.environ.get("FREECADCMD"), shutil.which("freecadcmd"), shutil.which("FreeCADCmd"),
                  str(MACOS_FREECADCMD)]
    found: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        if candidate is None or candidate in seen:
            continue
        seen.add(candidate)
        path = Path(candidate)
        if path.is_file():
            found.append(path)
    return found


@functools.cache
def osifont_path() -> str:
    """Return FreeCAD's checked TechDraw Osifont path, or fail rather than use a host fallback."""
    for command in _freecadcmds():
        resource_dir = command.resolve().parent.parent / "share"
        font = resource_dir / OSIFONT_RELATIVE_PATH
        if not font.is_file():
            continue
        digest = hashlib.sha256(font.read_bytes()).hexdigest()
        if digest != OSIFONT_SHA256:
            raise RuntimeError(f"unsupported TechDraw Osifont at {font}: SHA-256 {digest}, "
                               f"expected {OSIFONT_SHA256}")
        return str(font.resolve())
    raise FileNotFoundError("cannot find FreeCAD's TechDraw Osifont; install FreeCAD 1.1.4 or set FREECADCMD "
                            "to its bundled freecadcmd executable")
