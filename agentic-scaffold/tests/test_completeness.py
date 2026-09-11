from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
import tomllib

from conftest import git_root

ROOT = Path(__file__).parents[1]
CLI = ROOT / "skills/agentic-scaffold/scripts/scaffold.py"

def run(*args: str, cwd: Path | None = None, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    argv = list(args)
    if "--root" in argv:
        i = argv.index("--root")
        if i + 1 < len(argv): argv[i + 1] = str(git_root(Path(argv[i + 1])))
    return subprocess.run([sys.executable, str(CLI), *argv], cwd=cwd, env=env, text=True, capture_output=True, check=False)

def render(root: Path, *args: str) -> None:
    result = run("render", "--root", str(root), "--profile", "agentic-repo", "--name", "demo", *args)
    assert result.returncode == 0, result.stderr


def test_layers_show_and_answer_precedence(tmp_path: Path) -> None:
    shown = run("layers", "show", "lang/python")
    assert shown.returncode == 0
    assert tomllib.loads((ROOT / "skills/agentic-scaffold/templates/lang/python/layer.toml").read_text())["name"] == json.loads(shown.stdout)["name"]
    answer = run("answers", "write", "--root", str(tmp_path), "--profile", "python-lib", "--set", "python=3.11", "--set", "name=answer-demo", "--defaults-for", "purpose,kind,language,license,beads")
    assert answer.returncode == 0, answer.stderr
    rendered = run("render", "--root", str(tmp_path), "--profile", "python-lib", "--var", "python=3.10")
    assert rendered.returncode == 0, rendered.stderr
    assert 'requires-python = ">=3.12"' in (tmp_path / "pyproject.toml").read_text()
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
    assert set(tools) >= {"python", "prek", "just"}


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

def test_speckit_boolean_controls_plugin(tmp_path: Path) -> None:
    false_result = run("render", "--root", str(tmp_path / "false"), "--profile", "agentic-repo", "--var", "speckit=false")
    assert false_result.returncode == 0, false_result.stderr
    assert '"speckit"' not in (tmp_path / "false/.omp/plugins.toml").read_text()
    true_result = run("render", "--root", str(tmp_path / "true"), "--profile", "agentic-repo", "--var", "speckit=true")
    assert true_result.returncode == 0, true_result.stderr
    assert '"speckit"' in (tmp_path / "true/.omp/plugins.toml").read_text()


def test_precommit_has_one_repos_header(tmp_path: Path) -> None:
    result = run("render", "--root", str(tmp_path), "--profile", "python-app")
    assert result.returncode == 0, result.stderr
    lines = (tmp_path / ".pre-commit-config.yaml").read_text().splitlines()
    assert sum(line == "repos:" for line in lines) == 1
    assert sum(line.strip().startswith("- repo:") for line in lines) == 6  # prek-hooks, ruff, ty->pyright swap, gitleaks, typos


def test_layer_owned_tools_do_not_cross_stacks(tmp_path: Path) -> None:
    python_result = run("render", "--root", str(tmp_path / "python"), "--profile", "python-app")
    assert python_result.returncode == 0, python_result.stderr
    python_tools = tomllib.loads((tmp_path / "python/mise.toml").read_text())["tools"]
    assert {"python", "uv", "prek", "just"} <= python_tools.keys()
    # the agentic layer pins node for npm-backed repomix; bun stays a TypeScript-only tool
    assert "bun" not in python_tools and "node" in python_tools
    ts_result = run("render", "--root", str(tmp_path / "ts"), "--profile", "ts-lib")
    assert ts_result.returncode == 0, ts_result.stderr
    ts_tools = tomllib.loads((tmp_path / "ts/mise.toml").read_text())["tools"]
    assert {"node", "bun", "prek", "just"} <= ts_tools.keys()
    assert "python" not in ts_tools


def test_python_uses_pyright_spdx_and_omits_empty_authors(tmp_path: Path) -> None:
    result = run("render", "--root", str(tmp_path), "--profile", "python-app")
    assert result.returncode == 0, result.stderr
    text = (tmp_path / "pyproject.toml").read_text()
    assert 'license = "Apache-2.0"' in text
    assert "authors" not in text
    assert "pyright" in text and "[tool.ty]" not in text and '"ty' not in text  # pyright standard is the estate norm


def test_ci_is_runnable_and_sha_pinned(tmp_path: Path) -> None:
    result = run("render", "--root", str(tmp_path), "--profile", "python-app")
    assert result.returncode == 0, result.stderr
    workflow = (tmp_path / ".github/workflows/ci.yml").read_text()
    assert "jdx/mise-action@" in workflow and "uv sync" in workflow and "prek run --all-files" in workflow
    assert "matrix.stack" not in workflow and "setup-python" not in workflow and "mise install" not in workflow
    assert all(len(line.split("@")[1].split(" ", 1)[0]) == 40 for line in workflow.splitlines() if " uses: " in line)


def test_hooks_install_reports_global_hook_manager(tmp_path: Path) -> None:
    render_result = run("render", "--root", str(tmp_path), "--profile", "agentic-repo")
    assert render_result.returncode == 0, render_result.stderr
    config = tmp_path / "global.gitconfig"
    config.write_text("[core]\n\thooksPath = /global/hooks\n")
    environment = os.environ.copy()
    environment["GIT_CONFIG_GLOBAL"] = str(config)
    environment["PATH"] = "/usr/bin:/bin"
    result = run("hooks", "install", "--root", str(tmp_path), env=environment)
    assert result.returncode == 2
    payload = json.loads(result.stdout)
    assert payload["finding"]["kind"] == "hook-manager"
    assert len(payload["finding"]["options"]) == 3


def test_hooks_install_uses_git_defender_for_global_hooks_path(tmp_path: Path) -> None:
    rendered = run("render", "--root", str(tmp_path), "--profile", "agentic-repo")
    assert rendered.returncode == 0, rendered.stderr
    config = tmp_path / "global.gitconfig"
    config.write_text("[core]\n\thooksPath = /global/hooks\n")
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    defender = fake_bin / "git-defender"
    defender.write_text("#!/bin/sh\nmkdir -p .git/hooks\nprintf '#!/bin/sh\\nexit 0\\n' > .git/hooks/pre-commit\nchmod +x .git/hooks/pre-commit\n")
    defender.chmod(0o755)
    environment = os.environ.copy()
    environment["GIT_CONFIG_GLOBAL"] = str(config)
    environment["PATH"] = str(fake_bin) + os.pathsep + environment.get("PATH", "")
    result = run("hooks", "install", "--root", str(tmp_path), env=environment)
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["strategy"] == "git-defender"
    assert payload["stages"]["pre-commit"] == "chained"
    assert (tmp_path / ".git/hooks/pre-commit").is_file()
    doctor = run("doctor", "--root", str(tmp_path), env=environment)
    payload = json.loads(doctor.stdout)
    assert doctor.returncode in (0, 2), doctor.stderr
    assert all(item.startswith("missing tool:") for item in payload["drift"]), payload["drift"]
    hooks = payload["checks"]["hooks"]
    assert hooks["strategy"] == "git-defender"
    assert hooks["stages"]["pre-push"].startswith("git shim")

def test_doctor_reports_hook_status(tmp_path: Path) -> None:
    result = run("render", "--root", str(tmp_path), "--profile", "agentic-repo")
    assert result.returncode == 0, result.stderr
    doctor = run("doctor", "--root", str(tmp_path))
    payload = json.loads(doctor.stdout)
    assert doctor.returncode in (0, 2), doctor.stderr
    assert "hooks declared but not installed" in payload["drift"]
    hooks = payload["checks"]["hooks"]
    assert hooks["declared"] and hooks["installed"] == [] and hooks["status"] == "not-installed"


def test_foreign_agents_block_is_update_block(tmp_path: Path) -> None:
    (tmp_path / "AGENTS.md").write_text("<!-- BEGIN BEADS INTEGRATION -->\nbeads\n<!-- END BEADS INTEGRATION -->\n")
    result = run("plan", "--root", str(tmp_path), "--profile", "agentic-repo")
    assert result.returncode == 0, result.stderr
    rows = {row["path"]: row["class"] for row in json.loads(result.stdout)["files"]}
    assert rows["AGENTS.md"] == "update-block"


def test_inspect_derives_profiles(tmp_path: Path) -> None:
    cases = {
        "python": ("pyproject.toml", "[project]\n[project.scripts]\ndemo = 'demo:main'\n", "python-app"),
        "ts": ("package.json", '{"bin": {"demo": "src/index.ts"}}\n', "ts-app"),
        "rust": ("Cargo.toml", "[package]\nname='demo'\n", "rust-lib"),
        "go": ("go.mod", "module example\n", "go-lib"),
        "terraform": ("main.tf", "terraform {}\n", "terraform"),
    }
    for directory, (filename, content, expected) in cases.items():
        root = tmp_path / directory
        root.mkdir()
        (root / filename).write_text(content)
        if directory == "rust":
            (root / "src").mkdir()
            (root / "src/main.rs").write_text("fn main() {}\n")
            expected = "rust-app"
        if directory == "go":
            (root / "cmd").mkdir()
            expected = "go-app"
        result = run("inspect", "--root", str(root))
        assert result.returncode == 0, result.stderr
        payload = json.loads(result.stdout)
        assert payload["suggestedProfile"] == expected

def test_symlink_managed_target_is_conflict(tmp_path: Path) -> None:
    target = tmp_path / "AGENTS.md"
    target.symlink_to(tmp_path / "missing-agents.md")
    result = run("plan", "--root", str(tmp_path), "--profile", "agentic-repo")
    assert result.returncode == 5
    assert any(item.get("reason") == "managed block target is a symlink" for item in json.loads(result.stdout)["conflicts"])
