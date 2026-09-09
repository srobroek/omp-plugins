from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parents[1]
CLI = ROOT / "skills/agentic-scaffold/scripts/scaffold.py"


def run(*args: str, cwd: Path | None = None, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, str(CLI), *args], cwd=cwd, env=env, text=True, capture_output=True, check=False)


def test_plan_render_classes_and_managed_idempotency(tmp_path: Path) -> None:
    result = run("plan", "--root", str(tmp_path), "--profile", "agentic-repo", "--name", "hello-world")
    assert result.returncode == 0, result.stderr
    plan = json.loads(result.stdout)
    classes = {row["path"]: row["class"] for row in plan["files"]}
    assert classes["README.md"] == "create"
    assert classes["AGENTS.md"] == "create"
    assert ".gitignore" in classes
    rendered = run("render", "--root", str(tmp_path), "--profile", "agentic-repo", "--name", "hello-world")
    assert rendered.returncode == 0, rendered.stderr
    agents = tmp_path / "AGENTS.md"
    agents.write_text(agents.read_text() + "\nHuman instructions stay here.\n")
    rendered = run("render", "--root", str(tmp_path), "--profile", "agentic-repo", "--name", "hello-world")
    assert rendered.returncode == 0, rendered.stderr
    assert "Human instructions stay here." in agents.read_text()
    assert agents.read_text().endswith("\n")
    snapshot = {p: p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}
    rendered = run("render", "--root", str(tmp_path), "--profile", "agentic-repo", "--name", "hello-world")
    assert rendered.returncode == 0, rendered.stderr
    assert snapshot == {p: p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}


def test_template_name_and_plugin_switches(tmp_path: Path) -> None:
    result = run("render", "--root", str(tmp_path), "--profile", "agentic-repo", "--name", "my-app", "--var", "web_ui=true", "--var", "speckit=true")
    assert result.returncode == 0, result.stderr
    text = (tmp_path / ".omp/plugins.toml").read_text()
    assert 'name = "srobroek-omp"' in text
    assert '"browser-tools"' in text and '"speckit"' in text
    assert (tmp_path / "README.md").read_text().startswith("# my-app\n")


def test_plan_foreign_agents_block_is_update_block(tmp_path: Path) -> None:
    (tmp_path / "AGENTS.md").write_text("<!-- BEGIN BEADS INTEGRATION -->\nbeads\n<!-- END BEADS INTEGRATION -->\n")
    result = run("plan", "--root", str(tmp_path), "--profile", "agentic-repo")
    assert result.returncode == 0
    rows = {row["path"]: row["class"] for row in json.loads(result.stdout)["files"]}
    assert rows["AGENTS.md"] == "update-block"

def test_plan_marks_existing_managed_block_as_update_block(tmp_path: Path) -> None:
    rendered = run("render", "--root", str(tmp_path), "--profile", "agentic-repo", "--name", "demo")
    assert rendered.returncode == 0, rendered.stderr
    result = run("plan", "--root", str(tmp_path), "--profile", "agentic-repo", "--name", "demo")
    assert result.returncode == 0, result.stderr
    classes = {row["path"]: row["class"] for row in json.loads(result.stdout)["files"]}
    assert classes["AGENTS.md"] == "update-block"
