"""The cad-motion kinematics, loaded from its sibling skill; cad-model never re-implements posing."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

POSE_PATH = Path(__file__).resolve().parents[3] / "cad-motion" / "scripts" / "pose.py"
MODULE = "cad_motion_pose"


def load_pose():
    """The `pose` module (Rigid, Part, load_assembly, build_chain, load_parts, write_step, ...)."""
    if MODULE in sys.modules:
        return sys.modules[MODULE]
    spec = importlib.util.spec_from_file_location(MODULE, POSE_PATH)
    if spec is None or spec.loader is None:
        raise ImportError(f"cad-motion pose.py not found at {POSE_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[MODULE] = module
    spec.loader.exec_module(module)
    return module
