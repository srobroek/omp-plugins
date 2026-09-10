from __future__ import annotations

import json
from pathlib import Path

from conftest import scaffold


def run(root: Path, *args: str):
    return scaffold(*args, "--root", str(root))


def test_monorepo_member_lifecycle(tmp_path: Path) -> None:
    answers = run(tmp_path, "answers", "write", "--profile", "monorepo", "--name", "demo", "--defaults-for", "purpose,kind,language,license,beads")
    assert answers.returncode == 0, answers.stderr
    assert run(tmp_path, "member", "add", "--name", "api", "--layer", "lang/python", "--kind", "app").returncode == 0
    assert run(tmp_path, "member", "add", "--name", "web", "--layer", "lang/ts", "--kind", "lib").returncode == 0

    rendered = run(tmp_path, "render")
    assert rendered.returncode == 0, rendered.stderr
    assert (tmp_path / "packages/api/pyproject.toml").is_file()
    assert (tmp_path / "packages/web/package.json").is_file()
    release = json.loads((tmp_path / "release-please-config.json").read_text())
    assert set(release["packages"]) == {"packages/api", "packages/web"}

    removed = run(tmp_path, "member", "remove", "--name", "web")
    assert removed.returncode == 0, removed.stderr
    assert json.loads(removed.stdout)["deleted"] is False
    assert (tmp_path / "packages/web/package.json").is_file()


def test_member_directory_collision_is_reported(tmp_path: Path) -> None:
    assert run(tmp_path, "answers", "write", "--profile", "monorepo", "--name", "demo", "--defaults-for", "purpose,kind,language,license,beads").returncode == 0
    assert run(tmp_path, "member", "import", "--dir", "packages/api", "--layer", "lang/python").returncode == 0
    assert run(tmp_path, "member", "import", "--dir", "packages/api", "--layer", "lang/python").returncode == 5


def test_optional_layers_are_listed() -> None:
    result = scaffold("layers", "list")
    assert result.returncode == 0
    payload = json.loads(result.stdout)
    names = {item["name"] for item in payload["layers"]}
    assert {"workspace", "moon", "worktrunk"} <= names


def test_monorepo_just_aggregates_call_members(tmp_path: Path) -> None:
    assert run(tmp_path, "answers", "write", "--profile", "monorepo", "--name", "demo", "--defaults-for", "purpose,kind,language,license,beads").returncode == 0
    assert run(tmp_path, "member", "add", "--name", "api", "--layer", "lang/python", "--kind", "app").returncode == 0
    assert run(tmp_path, "member", "add", "--name", "web", "--layer", "lang/ts", "--kind", "lib").returncode == 0
    assert run(tmp_path, "render").returncode == 0
    justfile = (tmp_path / "justfile").read_text()
    assert "test: api-test web-test" in justfile
    assert "lint: api-lint web-lint" in justfile
    assert "fmt: api-fmt web-fmt" in justfile
    assert "check: test lint fmt" in justfile
    assert "just test" not in justfile
    assert "just lint" not in justfile
    assert "just fmt" not in justfile
