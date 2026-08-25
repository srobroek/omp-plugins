"""Tests for the agent-steered example module.

Verifies:
  - manifest parses as valid (one python step + one agent step with steering)
  - agent step declares the correct steering path
  - steering file exists on disk
  - no default_enabled (example module, non-bundled)
  - --step scaffold (python step) runs correctly
  - --step draft-readme (agent step) is NOT handled by module.py (exit != 0)

The agent step is NOT executed end-to-end here — it is dispatched by the
runner's Tier-2 subsystem, not by uv run module.py. These tests validate the
manifest shape and steering file presence only.

Run: uv run --with pytest pytest -q examples/agent-steered/test_agent_steered.py
  or from the package root:
     uv run --with pytest pytest -q packages/project-setup/skills/project-setup/examples/agent-steered/test_agent_steered.py
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

_EXAMPLE_DIR = Path(__file__).resolve().parent
_SKILL_ROOT = _EXAMPLE_DIR.parents[1]   # examples/../ = project-setup/
_RUNNER = _SKILL_ROOT / "runner"
_MODULE_REL = "examples/agent-steered"


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, _RUNNER / f"{name}.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def _frozen_plan(tmp: Path, project_type: str = "library", description: str = "") -> Path:
    plan = {
        "schema_version": 1,
        "mode": "init",
        "order": ["agent-steered"],
        "modules": {
            "agent-steered": {
                "id": "agent-steered",
                "version": "1.0.0",
                "reconcile": False,
                "module_rel_root": _MODULE_REL,
                "answers": {
                    "project_type": project_type,
                    "description": description,
                },
                "steps": [
                    {"id": "scaffold", "kind": "python"},
                    {"id": "draft-readme", "kind": "agent", "steering": "steering/decide.md"},
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
    assert mani.id == "agent-steered"
    # Example modules must NOT set default_enabled
    assert mani.default_enabled is None, (
        "Example modules must not set default_enabled (FR-035 forbids it on non-bundled modules)"
    )
    # Two steps: python + agent
    assert len(mani.steps) == 2


def test_manifest_declares_python_step():
    manifest = _load("manifest")
    mani = manifest.parse_manifest(_EXAMPLE_DIR / "module.toml")
    python_steps = [s for s in mani.steps if s.kind == "python"]
    assert len(python_steps) == 1
    assert python_steps[0].id == "scaffold"


def test_manifest_declares_agent_step_with_steering():
    """The agent step must declare kind=agent and a steering path."""
    manifest = _load("manifest")
    mani = manifest.parse_manifest(_EXAMPLE_DIR / "module.toml")
    agent_steps = [s for s in mani.steps if s.kind == "agent"]
    assert len(agent_steps) == 1, f"Expected 1 agent step, got: {[s.id for s in mani.steps]}"
    agent_step = agent_steps[0]
    assert agent_step.id == "draft-readme"
    assert agent_step.steering == "steering/decide.md", (
        f"Expected steering='steering/decide.md', got: {agent_step.steering!r}"
    )


def test_steering_file_exists_on_disk():
    """The steering doc referenced by the agent step must exist."""
    steering_path = _EXAMPLE_DIR / "steering" / "decide.md"
    assert steering_path.is_file(), f"Steering file missing: {steering_path}"
    content = steering_path.read_text(encoding="utf-8")
    assert len(content) > 50, "Steering file looks empty"


def test_manifest_input_keys():
    manifest = _load("manifest")
    mani = manifest.parse_manifest(_EXAMPLE_DIR / "module.toml")
    input_keys = {inp.key for inp in mani.inputs}
    assert "project_type" in input_keys
    assert "description" in input_keys


# ── python step (scaffold) ───────────────────────────────────────────────────── #

def test_scaffold_step_runs(tmp_path):
    project = tmp_path / "proj"
    project.mkdir()
    plan = _frozen_plan(tmp_path, project_type="service")
    proc = _run(project, plan, "scaffold")
    assert proc.returncode == 0, proc.stderr
    result = json.loads(proc.stdout)
    assert result["status"] == "ok"
    assert result["step_id"] == "scaffold"


def test_scaffold_step_creates_docs_gitkeep(tmp_path):
    project = tmp_path / "proj"
    project.mkdir()
    plan = _frozen_plan(tmp_path)
    _run(project, plan, "scaffold")
    assert (project / "docs" / ".gitkeep").exists()


def test_scaffold_inspect_writes_nothing(tmp_path):
    project = tmp_path / "proj"
    project.mkdir()
    plan = _frozen_plan(tmp_path)
    proc = _run(project, plan, "scaffold", inspect=True)
    assert proc.returncode == 0, proc.stderr
    assert not (project / "docs").exists()


# ── agent step is NOT handled by module.py ──────────────────────────────────── #

def test_agent_step_not_handled_by_module_py(tmp_path):
    """module.py must NOT handle the agent step — it exits with a non-zero code.

    The agent step is dispatched by the runner's Tier-2 subsystem, not by
    uv run module.py --step draft-readme. Confirming that module.py returns
    non-zero prevents accidental silent success.
    """
    project = tmp_path / "proj"
    project.mkdir()
    plan = _frozen_plan(tmp_path)
    proc = _run(project, plan, "draft-readme")
    assert proc.returncode != 0, (
        "module.py should NOT handle the agent step 'draft-readme'; "
        "it should exit non-zero so the runner knows to delegate to Tier-2."
    )
