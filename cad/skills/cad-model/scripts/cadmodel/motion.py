"""The cad-motion kinematics, pair policy, pair measurer, mesh bounds and incremental selection, loaded from its sibling skill; cad-model never re-implements posing or measuring."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any

SCRIPTS = Path(__file__).resolve().parents[3] / "cad-motion" / "scripts"


def _load(module: str, path: Path) -> Any:
    if module in sys.modules:
        return sys.modules[module]
    spec = importlib.util.spec_from_file_location(module, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cad-motion {path.name} not found at {path}")
    loaded = importlib.util.module_from_spec(spec)
    sys.modules[module] = loaded
    spec.loader.exec_module(loaded)
    return loaded


def load_pose() -> Any:
    """The `pose` module (Rigid, Assembly, Chain, load_assembly, assembly_chain, write_assembly_step, ...)."""
    return _load("cad_motion_pose", SCRIPTS / "pose.py")


def load_pair_policy() -> Any:
    """The `pair_policy` module: declared press fits and heat-set inserts resolved to occurrence pairs."""
    return _load("cad_motion_pair_policy", SCRIPTS / "pair_policy.py")


def load_pair_measure() -> Any:
    """The `pair_measure` module: PairMeasurer, Request, the outcome records, RuleVersion, PairCache."""
    load_pose()  # pair_measure measures with this very pose module
    return _load("cad_motion_pair_measure", SCRIPTS / "pair_measure.py")


def load_mesh_bound() -> Any:
    """The `mesh_bound` module (MeshBounds); ImportError without numpy or python-fcl."""
    load_pose()
    try:
        return _load("cad_motion_mesh_bound", SCRIPTS / "mesh_bound.py")
    except ImportError:
        sys.modules.pop("cad_motion_mesh_bound", None)
        raise


def load_incremental() -> Any:
    """The `incremental` module: version states, changed-pair selection and smoke samples."""
    load_pose()
    return _load("cad_motion_incremental", SCRIPTS / "incremental.py")
