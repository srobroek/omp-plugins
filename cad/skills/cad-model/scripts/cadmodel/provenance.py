"""What produced a cached output besides its inputs: the interpreter and installed distributions of the
process, and the Python files it loaded from the plugin or the project.

Standard library only: the kernel runners and the orchestrator both use it, outside and inside a kernel.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import platform
import sys
from pathlib import Path
from typing import Any, Iterable, Mapping

SKILLS = Path(__file__).resolve().parents[3]  # cad/skills: every plugin module a process can load lives below it


def runtime(tools: Mapping[str, str]) -> dict[str, Any]:
    """The process's runtime identity: `tools` (the versions a manifest reports), the exact interpreter,
    the platform, and every installed distribution, so a changed transitive dependency counts too."""
    return {"tools": dict(tools), "python": sys.version, "implementation": sys.implementation.name,
            "platform": sys.platform, "machine": platform.machine(),
            "distributions": sorted({f"{d.metadata['Name']}=={d.version}" for d in importlib.metadata.distributions()
                                     if d.metadata["Name"]})}


def sources(roots: Iterable[Path], skip_prefix: str | None = None) -> dict[str, str]:
    """sha256 of every Python file this process has loaded from below one of `roots`, keyed by its
    absolute path; modules whose name starts with `skip_prefix` are left out. Installed packages and
    the standard library are not below a root: `runtime` identifies them by version."""
    bases = [Path(root).resolve() for root in roots]
    found: dict[str, str] = {}
    for name, module in list(sys.modules.items()):
        file = getattr(module, "__file__", None)
        if not file or (skip_prefix and name.startswith(skip_prefix)):
            continue
        path = Path(file).resolve()
        if path.suffix == ".py" and str(path) not in found and any(path.is_relative_to(base) for base in bases):
            found[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
    return found


def folder_inputs(folder: Path) -> dict[str, str]:
    """sha256 of every file of a part folder its build can read, keyed by its POSIX path below the
    folder: model.py and sources/**. part.yaml is left out (the runner gets its build fields in the
    request), as are hidden names and __pycache__."""
    folder = Path(folder)
    inputs = {}
    for path in sorted(folder.rglob("*")):
        rel = path.relative_to(folder)
        if (rel.as_posix() != "part.yaml" and path.is_file()
                and not any(name.startswith(".") or name == "__pycache__" for name in rel.parts)):
            inputs[rel.as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return inputs
