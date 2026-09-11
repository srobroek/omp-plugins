from __future__ import annotations

import json
from pathlib import Path

from conftest import scaffold


def run(root: Path, *args: str):
    return scaffold(*args, "--root", str(root))


def render(root: Path, profile: str, language: str, kind: str, *extra: str) -> None:
    args = ["answers", "write", "--profile", profile, "--name", "demo", "--set", f"language={language}", "--set", f"kind={kind}", "--set", "purpose=test"]
    for item in extra:
        args.extend(["--set", item])
    args.extend(["--defaults-for", "purpose,license,beads,docs_flavour"])
    result = run(root, *args)
    assert result.returncode == 0, result.stderr
    result = run(root, "apply", "--stage", "render")
    assert result.returncode == 0, result.stderr


def test_rust_kinds(tmp_path: Path) -> None:
    for kind, present, absent in [("crate", ["src/lib.rs", "tests/smoke.rs"], ["src/main.rs"]), ("tool", ["src/main.rs"], ["src/lib.rs"]), ("hybrid", ["src/lib.rs", "src/main.rs"], [])]:
        root = tmp_path / kind
        render(root, "rust-lib", "rust", kind)
        for path in present: assert (root / path).is_file()
        for path in absent: assert not (root / path).exists()


def test_python_kinds(tmp_path: Path) -> None:
    root = tmp_path / "library"; render(root, "python-lib", "python", "library")
    assert (root / "src/demo/py.typed").is_file(); assert "hatchling" in (root / "pyproject.toml").read_text(); assert not (root / "src/demo/cli.py").exists()
    root = tmp_path / "tool"; render(root, "python-app", "python", "tool")
    assert (root / "src/demo/cli.py").is_file(); assert "[project.scripts]" in (root / "pyproject.toml").read_text()


def test_ts_plugin_and_go_tool(tmp_path: Path) -> None:
    root = tmp_path / "plugin"; render(root, "omp-plugin", "ts", "omp-plugin")
    assert (root / ".omp-plugin/plugin.json").is_file()
    for name in ("extensions", "skills", "rules", "agents", "formulas"): assert (root / name).is_dir()
    root = tmp_path / "go"; render(root, "go-app", "go", "tool")
    assert (root / "cmd/demo/main.go").is_file()


def test_inspect_kind_proposals(tmp_path: Path) -> None:
    fixtures = [("py", "pyproject.toml", "[project]\n[project.scripts]\ndemo='demo:main'\n", "tool"), ("ts", "package.json", '{"bin":{"demo":"bin.js"}}', "app"), ("rust", "Cargo.toml", "[package]\nname='x'\n[lib]\npath='src/lib.rs'\n[[bin]]\nname='x'\npath='src/main.rs'\n", "hybrid"), ("go", "go.mod", "module example.com/demo\n", "tool")]
    for name, manifest, content, expected in fixtures:
        root = tmp_path / name; root.mkdir(); (root / manifest).write_text(content)
        if name == "go": (root / "cmd").mkdir()
        result = run(root, "inspect"); assert result.returncode == 0; assert json.loads(result.stdout)["kind"] == expected


def test_member_kind_persists(tmp_path: Path) -> None:
    assert run(tmp_path, "answers", "write", "--profile", "monorepo", "--name", "demo", "--defaults-for", "purpose,kind,language,license,beads").returncode == 0
    assert run(tmp_path, "member", "add", "--name", "core", "--layer", "lang/rust", "--kind", "hybrid").returncode == 0
    assert 'kind = "hybrid"' in (tmp_path / ".omp/scaffold-answers.toml").read_text()


def test_docs_flavours(tmp_path: Path) -> None:
    for flavour, present, absent in [("splash", "site/astro.config.mjs", "mkdocs.yml"), ("site", "mkdocs.yml", "site/astro.config.mjs"), ("none", "docs/architecture.md", "mkdocs.yml")]:
        root = tmp_path / flavour; render(root, "static-site", "none", "library", f"docs_flavour={flavour}")
        assert (root / present).is_file(); assert not (root / absent).exists(); assert json.loads((root / ".omp/docs.json").read_text())["docs_flavour"] == flavour
