from pathlib import Path
import json
import string
import tomllib

ROOT = Path(__file__).parents[1]
VARS = {"name": "Example", "package": "example", "package_kebab": "example", "description": "Example project", "python": "3.13", "python_tag": "py313", "node": "22", "bun_version": "latest", "year": "2026", "author": "Example Author", "authors": 'authors = [{ name = "Example Author" }]\n', "license": "Apache-2.0", "license_spdx": "Apache-2.0", "profile": "python-app", "language": "python", "commands_setup": "uv sync", "commands_test": "pytest", "commands_lint": "ruff check .", "commands_fmt": "ruff format --check .", "commands_check": "ty check", "ci_jobs": ""}
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
