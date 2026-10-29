"""Resolve the TechDraw lettering font used for deterministic model text."""

from __future__ import annotations

import functools
import hashlib
import os
import sys
from pathlib import Path

OSIFONT_SHA256 = "f681b2419818198a8421b9db01602862367dbc3338c0e8e963fda73f545262b8"
OSIFONT_RELATIVE_PATH = Path("Mod/TechDraw/Resources/fonts/osifont-lgpl3fe.ttf")


def _freecadcmd() -> Path | None:
    """Use CAD preflight's selected FreeCAD command without running its other checks."""
    preflight = Path(__file__).resolve().parents[4] / "skills" / "cad-flow" / "scripts"
    if str(preflight) not in sys.path:
        sys.path.insert(0, str(preflight))
    import preflight as cad_preflight

    return cad_preflight.find_freecadcmd(os.environ)


def _osifont_for(command: Path) -> str:
    font = command.resolve().parent.parent / "share" / OSIFONT_RELATIVE_PATH
    if not font.is_file():
        raise FileNotFoundError(f"FreeCAD's TechDraw Osifont is missing: {font}")
    digest = hashlib.sha256(font.read_bytes()).hexdigest()
    if digest != OSIFONT_SHA256:
        raise RuntimeError(f"unsupported TechDraw Osifont at {font}: SHA-256 {digest}, "
                           f"expected {OSIFONT_SHA256}")
    return str(font.resolve())


@functools.cache
def osifont_path() -> str:
    """Return the preflight-selected FreeCAD TechDraw Osifont, verifying its pinned bytes."""
    command = _freecadcmd()
    if command is None or not command.is_file() or not os.access(command, os.X_OK):
        raise FileNotFoundError("cannot find the preflight-selected FreeCAD freecadcmd; "
                                "install FreeCAD 1.1.4 or set FREECADCMD")
    return _osifont_for(command)
