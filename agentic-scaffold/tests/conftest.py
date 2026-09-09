"""Shared pytest markers and helpers for the agentic-scaffold CLI tests."""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCAFFOLD = REPO_ROOT / "skills" / "agentic-scaffold" / "scripts" / "scaffold.py"
SKIP_SLOW = os.environ.get("SCAFFOLD_SKIP_SLOW") == "1"


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers", "slow: shells out to a toolchain that installs, compiles, or builds an image"
    )


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if not SKIP_SLOW:
        return
    skip = pytest.mark.skip(reason="SCAFFOLD_SKIP_SLOW=1")
    for item in items:
        if "slow" in item.keywords:
            item.add_marker(skip)


def scaffold(*args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    """Run one scaffold CLI invocation with both streams captured."""
    return subprocess.run(
        [sys.executable, str(SCAFFOLD), *args],
        capture_output=True,
        text=True,
        check=False,
        env=env,
    )


def load_scaffold():
    """Load the CLI as a fresh module for tests that inspect its tables."""
    spec = importlib.util.spec_from_file_location("scaffold_under_test", SCAFFOLD)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {SCAFFOLD}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
