from pathlib import Path
import json
import string
import tomllib

ROOT = Path(__file__).parents[1]
VARS = {"name": "Example", "package": "example", "package_kebab": "example", "description": "Example project", "python": "3.13", "python_tag": "py313", "node": "22", "bun_version": "latest", "year": "2026", "author": "Example Author", "authors": 'authors = [{ name = "Example Author" }]\n', "license": "Apache-2.0", "license_spdx": "Apache-2.0", "profile": "python-app", "language": "python", "commands_setup": "uv sync", "commands_test": "pytest", "commands_lint": "ruff check .", "commands_fmt": "ruff format --check .", "commands_check": "ty check", "ci_jobs": "", "release_jobs": "", "publish": "pypi"}
BLOCK_TARGETS = {".gitignore", "justfile", ".pre-commit-config.yaml", "AGENTS.md", "WATCHDOG.md"}


def render(path: Path) -> str:
    return string.Template(path.read_text()).substitute(VARS)


def test_templates_substitute_and_block_layers_are_fragments():
    for path in (ROOT / "skills/agentic-scaffold/templates").rglob("*"):
        if path.is_file() and path.name.endswith(".tmpl"):
            render(path)
        if path.is_file() and path.name.endswith(".block"):
            assert path.name.removesuffix(".block") not in BLOCK_TARGETS or path.name.endswith(".block")
    for layer in (ROOT / "skills/agentic-scaffold/templates").iterdir():
        if not layer.is_dir(): continue
        for path in layer.rglob("*"):
            if path.is_file() and path.name.removesuffix(".block") in BLOCK_TARGETS:
                assert path.name.endswith(".block")


def test_rendered_manifests_are_structurally_valid():
    py = render(ROOT / "skills/agentic-scaffold/templates/lang/python/pyproject.toml.tmpl")
    tomllib.loads(py)
    package = json.loads(render(ROOT / "skills/agentic-scaffold/templates/lang/ts/package.json.tmpl"))
    assert package["name"] == "example"
    cargo = render(ROOT / "skills/agentic-scaffold/templates/lang/rust/Cargo.toml.tmpl")
    assert '[package]' in cargo and 'edition = "2024"' in cargo
    gomod = render(ROOT / "skills/agentic-scaffold/templates/lang/go/go.mod.tmpl")
    assert gomod.startswith("module example\n") and "go 1.23" in gomod


def test_conditional_files_follow_the_answer(tmp_path: Path, monkeypatch) -> None:
    import importlib
    import sys

    sys.path.insert(0, str(ROOT / "skills" / "agentic-scaffold" / "scripts"))
    scaffold = importlib.import_module("scaffold")
    layer = tmp_path / "templates" / "probe"
    (layer / "src").mkdir(parents=True)
    (layer / "layer.toml").write_text(
        'summary = "probe"\n[conditional_files]\n"src/main.rs" = { var = "kind", any = ["tool", "hybrid"] }\n"src/lib.rs" = { var = "kind", any = ["crate", "hybrid"] }\n"bogus.txt" = "not a table"\n'
    )
    for name in ("src/main.rs", "src/lib.rs", "bogus.txt", "always.txt"):
        (layer / name).write_text(name)
    monkeypatch.setattr(scaffold, "TEMPLATES", tmp_path / "templates")
    monkeypatch.setattr(scaffold, "layer_dir", lambda layer_name: tmp_path / "templates" / layer_name)
    for kind, expected in (("tool", {"src/main.rs", "always.txt"}), ("crate", {"src/lib.rs", "always.txt"}), ("hybrid", {"src/main.rs", "src/lib.rs", "always.txt"})):
        direct, _ = scaffold.collect(["probe"], {"kind": kind, "name": "demo"})
        assert set(direct) == expected, kind  # the malformed entry never includes its file
