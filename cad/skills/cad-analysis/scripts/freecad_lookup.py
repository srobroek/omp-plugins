"""Shared lookup for the FreeCAD command-line executable."""

from __future__ import annotations

import os
import importlib.util
import sys
from pathlib import Path


def find_freecad(explicit: Path | None = None) -> Path | None:
    """Find FreeCAD through cad-flow's authoritative lookup.

    Explicit commands retain their highest priority, including an invalid explicit command,
    so callers can report a bad configured path instead of silently selecting another tool.
    """
    flow_scripts = Path(__file__).resolve().parents[2] / "cad-flow" / "scripts"
    if str(flow_scripts) not in sys.path:
        sys.path.insert(0, str(flow_scripts))
    spec = importlib.util.spec_from_file_location("cad_flow_preflight", flow_scripts / "preflight.py")
    if spec is None or spec.loader is None:
        raise ImportError(f"{flow_scripts / 'preflight.py'} not found")
    preflight = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = preflight
    spec.loader.exec_module(preflight)
    return preflight._find_freecadcmd({**os.environ, **({"FREECADCMD": str(explicit)} if explicit else {})})
