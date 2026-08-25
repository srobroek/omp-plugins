"""Tests for the multi-step-python example module.

Verifies:
  - manifest parses as valid (two python steps, no default_enabled)
  - --step scaffold writes README.md with the project name
  - --step configure writes .project-name with project_name + enable_ci
  - each step runs its own handler (STEP_HANDLERS dispatch)
  - --inspect writes nothing for each step
  - unknown --step returns exit code 1

Run: uv run --with pytest pytest -q examples/multi-step-python/test_multi_step_python.py
  or from the package root:
     uv run --with pytest pytest -q packages/project-setup/skills/project-setup/examples/multi-step-python/test_multi_step_python.py
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

# examples/multi-step-python/ is the module dir; its parent is examples/,
# grandparent is the skill root (project-setup/), great-grandparent is packages/.
_EXAMPLE_DIR = Path(__file__).resolve().parent
_SKILL_ROOT = _EXAMPLE_DIR.parents[1]   # examples/../ = project-setup/
_RUNNER = _SKILL_ROOT / "runner"
_MODULE_REL = "examples/multi-step-python"


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, _RUNNER / f"{name}.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def _frozen_plan(
    tmp: Path,
    project_name: str = "demo-project",
    enable_ci: bool = False,
) -> Path:
    plan = {
        "schema_version": 1,
        "mode": "init",
        "order": ["multi-step-python"],
        "modules": {
            "multi-step-python": {
                "id": "multi-step-python",
                "version": "1.0.0",
                "reconcile": True,
                "module_rel_root": _MODULE_REL,
                "answers": {
                    "project_name": project_name,
                    "enable_ci": enable_ci,
                },
                "steps": [
                    {"id": "scaffold", "kind": "python"},
                    {"id": "configure", "kind": "python"},
                ],
            }
        },
    }
    p = tmp / "plan.json"
    p.write_text(json.dumps(plan))
    return p


def _run(project: Path, plan: Path, step: str, *, inspect: bool = False) -> subprocess.CompletedProcess:
    module_py = _EXAMPLE_DIR / "module.py"
    cmd = ["uv", "run", str(module_py), "--plan", str(plan), "--step", step]
    if inspect:
        cmd.append("--inspect")
    env = {**os.environ, "PLUGIN_ROOT": str(_SKILL_ROOT), "PROJECT_DIR": str(project)}
    return subprocess.run(cmd, capture_output=True, text=True, env=env, cwd=str(project))


# ── manifest ────────────────────────────────────────────────────────────────── #

def test_manifest_parses_as_valid():
    manifest = _load("manifest")
    mani = manifest.parse_manifest(_EXAMPLE_DIR / "module.toml")
    assert not mani.errors, mani.errors
    assert mani.id == "multi-step-python"
    # Example modules must NOT set default_enabled
    assert mani.default_enabled is None, (
        "Example modules must not set default_enabled (FR-035 forbids it on non-bundled modules)"
    )
    # Two python steps declared in order
    step_ids = [s.id for s in mani.steps]
    assert step_ids == ["scaffold", "configure"]
    assert all(s.kind == "python" for s in mani.steps)


# ── scaffold step ────────────────────────────────────────────────────────────── #

def test_scaffold_step_writes_readme(tmp_path):
    project = tmp_path / "proj"
    project.mkdir()
    plan = _frozen_plan(tmp_path, project_name="test-app")
    proc = _run(project, plan, "scaffold")
    assert proc.returncode == 0, proc.stderr
    result = json.loads(proc.stdout)
    assert result["status"] == "ok"
    assert result["step_id"] == "scaffold"
    assert "README.md" in result["files_written"]

    readme = (project / "README.md").read_text()
    assert "test-app" in readme


def test_scaffold_step_does_not_write_project_name_file(tmp_path):
    """scaffold step writes only README.md; .project-name is configure's job."""
    project = tmp_path / "proj"
    project.mkdir()
    plan = _frozen_plan(tmp_path)
    _run(project, plan, "scaffold")
    assert not (project / ".project-name").exists()


# ── configure step ───────────────────────────────────────────────────────────── #

def test_configure_step_writes_project_name_file(tmp_path):
    project = tmp_path / "proj"
    project.mkdir()
    plan = _frozen_plan(tmp_path, project_name="configured-app", enable_ci=True)
    proc = _run(project, plan, "configure")
    assert proc.returncode == 0, proc.stderr
    result = json.loads(proc.stdout)
    assert result["status"] == "ok"
    assert result["step_id"] == "configure"
    assert ".project-name" in result["files_written"]

    sentinel = (project / ".project-name").read_text()
    assert "project_name=configured-app" in sentinel
    assert "enable_ci=true" in sentinel


def test_configure_step_does_not_write_readme(tmp_path):
    """configure step writes only .project-name; README.md is scaffold's job."""
    project = tmp_path / "proj"
    project.mkdir()
    plan = _frozen_plan(tmp_path)
    _run(project, plan, "configure")
    assert not (project / "README.md").exists()


# ── step independence ────────────────────────────────────────────────────────── #

def test_both_steps_run_independently_in_order(tmp_path):
    """Running scaffold then configure produces both files."""
    project = tmp_path / "proj"
    project.mkdir()
    plan = _frozen_plan(tmp_path, project_name="full-app", enable_ci=False)
    proc1 = _run(project, plan, "scaffold")
    proc2 = _run(project, plan, "configure")
    assert proc1.returncode == 0, proc1.stderr
    assert proc2.returncode == 0, proc2.stderr
    assert (project / "README.md").exists()
    assert (project / ".project-name").exists()


# ── inspect ──────────────────────────────────────────────────────────────────── #

def test_inspect_scaffold_writes_nothing(tmp_path):
    project = tmp_path / "proj"
    project.mkdir()
    plan = _frozen_plan(tmp_path)
    proc = _run(project, plan, "scaffold", inspect=True)
    assert proc.returncode == 0, proc.stderr
    result = json.loads(proc.stdout)
    assert result["diffs"][0]["kind"] == "create"
    assert not (project / "README.md").exists()


def test_inspect_configure_writes_nothing(tmp_path):
    project = tmp_path / "proj"
    project.mkdir()
    plan = _frozen_plan(tmp_path)
    proc = _run(project, plan, "configure", inspect=True)
    assert proc.returncode == 0, proc.stderr
    assert not (project / ".project-name").exists()


# ── unknown step ─────────────────────────────────────────────────────────────── #

def test_unknown_step_returns_nonzero(tmp_path):
    project = tmp_path / "proj"
    project.mkdir()
    plan = _frozen_plan(tmp_path)
    proc = _run(project, plan, "nonexistent-step")
    assert proc.returncode != 0
