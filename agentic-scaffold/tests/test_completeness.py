from __future__ import annotations

import json
import os
import subprocess
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).parents[1]
CLI = ROOT / "skills/agentic-scaffold/scripts/scaffold.py"


def run(*args: str, cwd: Path | None = None, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, str(CLI), *args], cwd=cwd, env=env, text=True, capture_output=True, check=False)


def render(root: Path, *args: str) -> None:
    result = run("render", "--root", str(root), "--profile", "agentic-repo", "--name", "demo", *args)
    assert result.returncode == 0, result.stderr


def test_layers_show_and_answer_precedence(tmp_path: Path) -> None:
    shown = run("layers", "show", "lang/python")
    assert shown.returncode == 0
    assert tomllib.loads((ROOT / "skills/agentic-scaffold/templates/lang/python/layer.toml").read_text())["name"] == json.loads(shown.stdout)["name"]
    answer = run("answers", "write", "--root", str(tmp_path), "--profile", "python-lib", "--set", "python=3.11", "--set", "name=answer-demo")
    assert answer.returncode == 0, answer.stderr
    rendered = run("render", "--root", str(tmp_path), "--profile", "python-lib", "--var", "python=3.10")
    assert rendered.returncode == 0, rendered.stderr
    assert 'requires-python = ">=3.10"' in (tmp_path / "pyproject.toml").read_text()
    assert 'python = "3.10"' in (tmp_path / "mise.toml").read_text()


def test_update_reports_drifted_owned_file_and_refreshes_blocks(tmp_path: Path) -> None:
    render(tmp_path)
    readme = tmp_path / "README.md"
    readme.write_text("user-owned replacement\n")
    result = run("update", "--root", str(tmp_path))
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert "README.md" in payload["drifted"]
    assert readme.read_text() == "user-owned replacement\n"


def test_mcp_merge_plugins_union_and_tools_dedupe(tmp_path: Path) -> None:
    (tmp_path / ".omp").mkdir()
    (tmp_path / ".omp/mcp.json").write_text(json.dumps({"mcpServers": {"graphify": {"command": "user-command"}, "custom": {"command": "custom"}}}))
    (tmp_path / ".omp/plugins.toml").write_text('[[marketplaces]]\nname = "custom"\nsource = "custom/source"\nplugins = ["existing"]\n')
    (tmp_path / "mise.toml").write_text('[tools]\npython = "3.12"\n')
    render(tmp_path, "--layer", "web-ui")
    mcp = json.loads((tmp_path / ".omp/mcp.json").read_text())
    assert mcp["mcpServers"]["graphify"]["command"] == "user-command"
    assert "custom" in mcp["mcpServers"]
    plugins = tomllib.loads((tmp_path / ".omp/plugins.toml").read_text())
    by_name = {item["name"]: item for item in plugins["marketplaces"]}
    assert "existing" in by_name["custom"]["plugins"]
    tools = tomllib.loads((tmp_path / "mise.toml").read_text())["tools"]
    assert tools["python"] == "3.12"
    assert set(tools) >= {"python", "uv", "prek", "just", "node", "bun"}


def test_adopt_moves_existing_owned_file(tmp_path: Path) -> None:
    (tmp_path / "README.md").write_text("old\n")
    result = run("render", "--root", str(tmp_path), "--profile", "agentic-repo", "--name", "demo", "--adopt", "README.md")
    assert result.returncode == 0, result.stderr
    assert (tmp_path / "README.md.scaffold-orig").read_text() == "old\n"
    assert (tmp_path / "README.md").read_text().startswith("# demo")


def test_web_ui_appends_plugin_set(tmp_path: Path) -> None:
    render(tmp_path, "--layer", "web-ui")
    text = (tmp_path / ".omp/plugins.toml").read_text()
    assert '"browser-tools"' in text and '"impeccable"' in text and '"interface-design"' in text


def test_doctor_detects_broken_marker(tmp_path: Path) -> None:
    render(tmp_path)
    agents = tmp_path / "AGENTS.md"
    agents.write_text(agents.read_text().replace("agentic-scaffold:end agentic", "agentic-scaffold:end damaged"))
    result = run("doctor", "--root", str(tmp_path))
    assert result.returncode == 2
    assert any("markers damaged" in item for item in json.loads(result.stdout)["drift"])
