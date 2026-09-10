#!/usr/bin/env python3
"""Deterministic project scaffolding from declarative template layers.

The CLI intentionally uses only the Python standard library.  Configuration lives in
profiles and per-layer ``layer.toml`` files; rendered state is recorded in
``.omp/scaffold-answers.toml`` and ``.omp/scaffold.json``.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import sys
import tomllib
from datetime import UTC, datetime
from pathlib import Path
from string import Template
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
SKILL_ROOT = ROOT / "skills" / "agentic-scaffold"
TEMPLATES = SKILL_ROOT / "templates"
PROFILES = ROOT / "profiles"
EXIT_ERROR = 1
EXIT_DRIFT = 2
EXIT_CONFLICT = 5
MARKER_HTML = "<!-- agentic-scaffold:{kind} {block} -->"
MARKER_HASH = "# agentic-scaffold:{kind} {block}"
TRUTHY = {"1", "true", "yes", "on"}



EXIT_NEEDS_INPUT = 3
EXIT_BOUNDARY = 6


def resolved_root(path: Path) -> Path:
    """Resolve a CLI root without following a missing final component."""
    return path.expanduser().resolve()


def validate_root(root: Path, *, require_git: bool = False) -> Path:
    """Validate the project boundary before any command can mutate it."""
    root = resolved_root(root)
    home = Path.home().resolve()
    omp_home = home / ".omp"
    if root == home or omp_home == root or omp_home in root.parents:
        fail("root must not be $HOME or inside ~/.omp", EXIT_BOUNDARY)
    if require_git:
        try:
            result = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=root, capture_output=True, text=True, check=False)
        except OSError:
            result = None
        if result is None or result.returncode != 0 or resolved_root(Path(result.stdout.strip())) != root:
            fail("root must be the root of a git work tree", EXIT_BOUNDARY)
    return root


def _write_under_root(root: Path, path: Path, content: str) -> None:
    """Write only to a path whose real parent is inside the project root."""
    root = resolved_root(root)
    target = path if path.is_absolute() else root / path
    target = target.absolute()
    try:
        target.relative_to(root)
    except ValueError:
        fail(f"refusing write outside root: {target}", EXIT_BOUNDARY)
    probe = target.parent.resolve()
    try:
        probe.relative_to(root)
    except ValueError:
        fail(f"refusing write outside root: {target}", EXIT_BOUNDARY)
    target.parent.mkdir(parents=True, exist_ok=True)
    # Write beside the target and rename so a killed process never leaves a truncated file.
    tmp = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    tmp.write_text(content)
    os.replace(tmp, target)


def _rename_under_root(root: Path, source: Path, target: Path) -> None:
    root = validate_root(root)
    for path in (source, target):
        try:
            path.absolute().parent.resolve().relative_to(root)
        except ValueError:
            fail(f"refusing rename outside root: {path}", EXIT_BOUNDARY)
    source.rename(target)


def emit(payload: dict[str, Any], root: Path | None = None) -> None:
    """Emit one JSON object and always include the resolved command root."""
    value = dict(payload)
    value.setdefault("root", str(resolved_root(root or Path.cwd())))
    print(json.dumps(value, indent=2, sort_keys=True))
def fail(message: str, code: int = EXIT_ERROR) -> None:
    print(json.dumps({"error": message}), file=sys.stderr)
    raise SystemExit(code)


def load_toml(path: Path) -> dict[str, Any]:
    if not path.is_file():
        fail(f"missing configuration: {path}", 2)
    with path.open("rb") as stream:
        return tomllib.load(stream)


def layer_dir(name: str) -> Path:
    path = TEMPLATES / name
    if not path.is_dir() or not (path / "layer.toml").is_file():
        fail(f"unknown layer or missing layer.toml: {name}", 2)
    return path


def load_layer(name: str) -> dict[str, Any]:
    data = load_toml(layer_dir(name) / "layer.toml")
    data["name"] = str(data.get("name", name))
    data["_path"] = str(layer_dir(name) / "layer.toml")
    data.setdefault("after", [])
    data.setdefault("requires_tools", [])
    data.setdefault("owns", [])
    data.setdefault("blocks", [])
    data.setdefault("conflicts_with", [])
    if not isinstance(data["after"], list) or not isinstance(data["owns"], list):
        fail(f"layer {name} has invalid list fields", 2)
    return data


def load_profile(name: str) -> dict[str, Any]:
    path = PROFILES / f"{name}.toml"
    if not path.is_file():
        fail(f"unknown profile: {name}", 2)
    data = load_toml(path)
    if not isinstance(data.get("layers"), list):
        fail(f"profile {name} must declare layers", 2)
    data["name"] = str(data.get("name", name))
    data["_path"] = str(path)
    return data


def value_default(value: Any) -> str:
    if isinstance(value, dict):
        value = value.get("default", "")
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)
def build_ci_jobs(language: str, values: dict[str, str]) -> str:
    checkout = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7"
    setup_uv = "astral-sh/setup-uv@37802adc94f370d6bfd71619e3f0bf239e1f3b78 # v7.6.0"
    setup_bun = "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2"
    setup_go = "actions/setup-go@d35c59abb061a4a6fb18e82ac0862c26744d6ab5 # v5"
    rust_toolchain = "dtolnay/rust-toolchain@6c977a6ca4077a0ceb28ffbe03f59d46e9ac8772 # v1"
    if language == "python":
        job = f'''  python:
    runs-on: ubuntu-latest
    steps:
      - uses: {checkout}
        with:
          persist-credentials: false
      - name: Setup uv
        uses: {setup_uv}
      - run: uv sync
      - run: {values["commands_test"]}
      - run: {values["commands_lint"]}
      - run: {values["commands_fmt"]}
      - run: {values["commands_check"]}'''
    elif language == "ts":
        job = f'''  typescript:
    runs-on: ubuntu-latest
    steps:
      - uses: {checkout}
        with:
          persist-credentials: false
      - name: Setup Bun
        uses: {setup_bun}
      - run: bun install --frozen-lockfile
      - run: {values["commands_test"]}
      - run: {values["commands_lint"]}
      - run: {values["commands_fmt"]}
      - run: {values["commands_check"]}'''
    elif language == "rust":
        job = f'''  rust:
    runs-on: ubuntu-latest
    steps:
      - uses: {checkout}
      - name: Setup Rust
        uses: {rust_toolchain}
      - run: cargo test
      - run: cargo clippy --all-targets --all-features -- -D warnings
      - run: cargo fmt --all --check
      - run: cargo check --all-targets'''
    elif language == "go":
        job = f'''  go:
    runs-on: ubuntu-latest
    steps:
      - uses: {checkout}
      - name: Setup Go
        uses: {setup_go}
        with:
          go-version: "stable"
      - run: go test -race ./...
      - run: golangci-lint run ./...
      - run: test -z "$(gofmt -l .)"
      - run: go vet ./...'''
    elif language == "terraform":
        job = f'''  terraform:
    runs-on: ubuntu-latest
    steps:
      - uses: {checkout}
      - run: terraform fmt -check -recursive
      - run: terraform validate'''
    else:
        job = f'''  check:
    runs-on: ubuntu-latest
    steps:
      - uses: {checkout}
        with:
          persist-credentials: false
      - name: Setup uv
        uses: {setup_uv}
      - run: uvx prek run --all-files'''
    prek = f'''  prek:
    runs-on: ubuntu-latest
    steps:
      - uses: {checkout}
        with:
          persist-credentials: false
      - name: Setup uv
        uses: {setup_uv}
      - run: uvx prek run --all-files'''
    return job + "\n" + prek


def layer_defaults(layers: list[str]) -> dict[str, str]:
    values: dict[str, str] = {}
    for name in layers:
        raw = load_layer(name).get("vars", {})
        if isinstance(raw, dict):
            for key, value in raw.items():
                values[str(key)] = value_default(value)
    return values
def member_family(layer: str) -> str:
    """Return the language family for a nested member layer."""
    return layer.split("/", 1)[1] if layer.startswith("lang/") else layer.rsplit("/", 1)[-1]


def member_dir_for(name: str, layer: str, kind: str = "lib") -> str:
    family = member_family(layer)
    if family in {"python", "ts"}:
        return f"packages/{name}"
    if family == "rust":
        return f"crates/{name}"
    if family == "go":
        return f"services/{name}" if kind == "service" else f"cmd/{name}"
    return f"packages/{name}"


def answers_members(root: Path) -> list[dict[str, str]]:
    raw = read_answers(root).get("members", [])
    if not isinstance(raw, list):
        return []
    result: list[dict[str, str]] = []
    for entry in raw:
        if isinstance(entry, dict) and entry.get("name") and entry.get("layer"):
            name = str(entry["name"])
            layer = str(entry["layer"])
            kind = str(entry.get("kind", "lib"))
            result.append({"name": name, "layer": layer, "kind": kind, "dir": str(entry.get("dir") or member_dir_for(name, layer, kind))})
    return result


def workspace_members_values(members: list[dict[str, str]]) -> list[dict[str, str]]:
    return [{"name": str(item["name"]), "layer": str(item["layer"]), "kind": str(item.get("kind", "lib")), "dir": str(item.get("dir") or member_dir_for(str(item["name"]), str(item["layer"]), str(item.get("kind", "lib"))))} for item in members]


def member_values(values: dict[str, str], member: dict[str, str]) -> dict[str, str]:
    scoped = dict(values)
    name = str(member["name"])
    scoped.update({"name": name, "member": name, "member_name": name, "member_dir": str(member["dir"]), "kind": str(member.get("kind", "lib")), "layer": str(member["layer"])})
    scoped["package"] = re.sub(r"[^A-Za-z0-9]+", "_", name).strip("_").lower() or "member"
    scoped["package_kebab"] = re.sub(r"[^A-Za-z0-9]+", "-", name).strip("-").lower() or "member"
    scoped["language"] = member_family(str(member["layer"]))
    return scoped


def answers_path(root: Path) -> Path:
    return root / ".omp" / "scaffold-answers.toml"

def read_answers(root: Path) -> dict[str, Any]:
    path = answers_path(root)
    return load_toml(path) if path.is_file() else {}


def toml_key(key: str) -> str:
    """Bare keys stay bare; anything else (e.g. `finding:hook-manager`) is quoted."""
    return key if re.fullmatch(r"[A-Za-z0-9_-]+", key) else json.dumps(key)


def toml_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, list):
        return "[" + ", ".join(toml_value(item) for item in value) + "]"
    return json.dumps(str(value))


def write_answers(root: Path, profile: str, layers: list[str], values: dict[str, str], extra: dict[str, Any] | None = None) -> None:
    path = answers_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [f"profile = {toml_value(profile)}", f"layers = {toml_value(layers)}"]
    plugin_version = ""
    plugin_json = ROOT / ".omp-plugin" / "plugin.json"
    if plugin_json.is_file():
        try:
            plugin_version = str(json.loads(plugin_json.read_text()).get("version", ""))
        except (OSError, json.JSONDecodeError):
            plugin_version = ""
    lines.append(f"plugin_version = {toml_value(plugin_version)}")
    lines.extend(["", "[vars]"])
    reserved = {"name", "package", "package_kebab", "description", "profile"}
    for key in sorted(values):
        if key not in reserved:
            lines.append(f"{toml_key(key)} = {toml_value(values[key])}")
    for key in ("name", "description"):
        if key in values:
            lines.append(f"{toml_key(key)} = {toml_value(values[key])}")
    if extra:
        members = extra.get("members")
        if isinstance(members, list):
            for item in members:
                if not isinstance(item, dict):
                    continue
                lines.extend(["", "[[members]]"])
                for key in ("name", "layer", "kind", "dir"):
                    if item.get(key):
                        lines.append(f"{key} = {toml_value(item[key])}")
        for key, value in extra.items():
            if key != "members":
                lines.extend(["", f"{key} = {toml_value(value)}"])
    _write_under_root(root, path, "\n".join(lines) + "\n")


def resolve_selection(root: Path, profile_name: str | None, name: str | None, overrides: dict[str, str], extra_layers: list[str]) -> tuple[str, dict[str, Any], list[str], dict[str, str]]:
    answers = read_answers(root)
    selected_profile = profile_name or str(answers.get("profile", ""))
    if not selected_profile:
        fail("profile is required (or write .omp/scaffold-answers.toml first)", 2)
    profile = load_profile(selected_profile)
    profile_layers = [str(item) for item in profile.get("layers", [])]
    answer_layers = answers.get("layers")
    layers = [str(item) for item in answer_layers] if isinstance(answer_layers, list) and str(answers.get("profile", selected_profile)) == selected_profile else profile_layers
    layers.extend(str(item) for item in extra_layers)
    layers = list(dict.fromkeys(layers))
    values = layer_defaults(layers)
    raw_profile_vars = profile.get("vars", {})
    if isinstance(raw_profile_vars, dict):
        values.update({str(k): value_default(v) for k, v in raw_profile_vars.items()})
    answer_vars = answers.get("vars", {})
    if isinstance(answer_vars, dict):
        values.update({str(k): value_default(v) for k, v in answer_vars.items()})
    values.update({str(k): str(v) for k, v in overrides.items()})
    actual_name = name or values.get("name") or "project"
    values["name"] = str(actual_name)
    values["package"] = re.sub(r"[^A-Za-z0-9]+", "_", values["name"]).strip("_").lower() or "project"
    values["package_kebab"] = re.sub(r"[^A-Za-z0-9]+", "-", values["name"]).strip("-").lower() or "project"
    # ruff/mypy style tag: "3.13" -> "py313"; tolerate "3.13.2", "py313", or "313".
    python_digits = re.sub(r"[^0-9.]", "", str(values.get("python", "3.13"))).split(".")
    values["python_tag"] = "py" + "".join(part for part in python_digits[:2] if part) if python_digits and python_digits[0] else "py313"
    values.setdefault("description", str(profile.get("summary", "")))
    values.setdefault("python", "3.13")
    values.setdefault("node", "22")
    values.setdefault("bun_version", "latest")
    values.setdefault("year", str(datetime.now(UTC).year))
    values.setdefault("author", "")
    values.setdefault("license", "")
    license_name = str(values.get("license", ""))
    values["license_spdx"] = "Apache-2.0" if license_name.lower() in {"apache-2.0", "apache 2.0"} else license_name
    author = str(values.get("author", ""))
    values["authors"] = f"authors = [{{ name = {json.dumps(author)} }}]\n" if author else ""
    values["profile"] = selected_profile
    commands = profile.get("commands", {})
    if isinstance(commands, dict):
        for key in ("setup", "test", "lint", "fmt", "check"):
            values[f"commands_{key}"] = str(commands.get(key, ""))
    values["ci_jobs"] = build_ci_jobs(str(values.get("language", "none")), values)
    if str(values.get("web_ui", "")).lower() in TRUTHY and "web-ui" not in layers:
        layers.append("web-ui")
    for recipe in ("setup", "test", "lint", "fmt", "context"):
        command = str(values.get(f"commands_{recipe}", ""))
        if re.search(rf"(?:^|[;&|]\s*)just(?:\s+[^;&|]+)*\s+{re.escape(recipe)}(?:\s|$)", command):
            fail(f"just recipe {recipe} recursively invokes itself", EXIT_CONFLICT)
    for layer in layers:
        load_layer(layer)
    return selected_profile, profile, layers, values


def render_text(text: str, values: dict[str, str]) -> str:
    return Template(text).substitute(values)


def target_path(relative: Path, values: dict[str, str]) -> Path:
    parts: list[str] = []
    for part in relative.parts:
        part = part.replace("__name__", values["name"])
        part = part.removesuffix(".tmpl")
        parts.append(render_text(part, values))
    return Path(*parts)


def marker_pair(block: str, target: Path) -> tuple[str, str]:
    template = MARKER_HASH if target.suffix in {".yaml", ".yml", ".toml", ".gitignore", ""} else MARKER_HTML
    return template.format(kind="begin", block=block), template.format(kind="end", block=block)


def member_block_name(layer: str, values: dict[str, str]) -> str:
    member = str(values.get("member", ""))
    return f"{layer}:{member}" if member else layer


def member_scoped_body(body: str, layer: str, values: dict[str, str]) -> str:
    """Namespace recipes and commands emitted for a nested member."""
    member = str(values.get("member", ""))
    member_dir = str(values.get("member_dir", ""))
    if not member:
        return body
    result: list[str] = []
    for line in body.splitlines():
        if re.match(r"^[A-Za-z0-9_-]+-(?:test|lint|fmt|check):", line):
            line = re.sub(r"^([A-Za-z0-9_-]+)-", f"{member}-", line, count=1)
        if line.startswith("    ") and line.strip() and not line.lstrip().startswith("#"):
            command = line.strip()
            if command.startswith(("uv ", "bun ", "cargo ", "go ", "terraform ")):
                line = f"    cd {member_dir} && {command}"
        result.append(line)
    return "\n".join(result) + ("\n" if body.endswith("\n") else "")


def effective_layer_tools(config: dict[str, Any], values: dict[str, str]) -> dict[str, str]:
    """`[tools]` plus every `[conditional_tools]` entry whose `when` matches the answers."""
    tools: dict[str, str] = {}
    raw = config.get("tools", {})
    if isinstance(raw, dict):
        for key, value in raw.items():
            tools[str(key)] = str(value)
    conditional = config.get("conditional_tools", {})
    if isinstance(conditional, dict):
        for key, spec in conditional.items():
            if not isinstance(spec, dict):
                continue
            variable = str(spec.get("var", ""))
            expected = str(spec.get("equals", "true"))
            if str(values.get(variable, "")).lower() == expected.lower():
                tools[str(key)] = str(spec.get("version", "latest"))
    return tools


def collect(layers: list[str], values: dict[str, str], member_dir: str | None = None) -> tuple[dict[str, list[dict[str, Any]]], dict[str, list[dict[str, Any]]]]:
    direct: dict[str, list[dict[str, Any]]] = {}
    blocks: dict[str, list[dict[str, Any]]] = {}
    for layer in layers:
        directory = layer_dir(layer)
        config = load_layer(layer)
        tools = effective_layer_tools(config, values)
        if tools and member_dir is None:
            lines = ["[tools]"]
            for key, value in tools.items():
                resolved = render_text(str(value), values)
                key_text = str(key) if re.fullmatch(r"[A-Za-z0-9_-]+", str(key)) else json.dumps(str(key))
                lines.append(f"{key_text} = {toml_value(resolved)}")
            blocks.setdefault("mise.toml", []).append({"layer": layer, "block": member_block_name(layer, values), "source": str(directory / "layer.toml"), "target": "mise.toml", "body": "\n".join(lines) + "\n"})
        for source in sorted(directory.rglob("*")):
            if not source.is_file() or source.name in {"layer.toml", "README.md", ".DS_Store", "mise.toml.tmpl"}:
                continue
            relative = source.relative_to(directory)
            if relative.name == "LICENSE" and str(values.get("license", "")).lower() not in {"", "apache-2.0", "apache 2.0"}:
                continue
            if relative.name.endswith(".block"):
                target = target_path(Path(str(relative)[:-6]), values)
                body = render_text(source.read_text(), values)
                if member_dir:
                    body = member_scoped_body(body, layer, values)
                elif str(values.get("layout", "single")) == "monorepo" and layer == "tooling" and str(target) == "justfile":
                    body = re.sub(r"(?ms)^(?:test|lint|fmt|check):\n(?:    .*\n)+\n?", "", body)
                item = {"layer": layer, "block": member_block_name(layer, values), "source": str(source), "target": str(target), "body": body}
                blocks.setdefault(str(target), []).append(item)
            else:
                target = target_path(relative, values)
                if member_dir:
                    target = Path(member_dir) / target
                data = source.read_text()
                if source.suffix == ".tmpl":
                    data = render_text(data, values)
                direct.setdefault(str(target), []).append({"layer": layer, "source": str(source), "target": str(target), "data": data})
    return direct, blocks


def layer_tools(layers: list[str], values: dict[str, str]) -> dict[str, str]:
    tools: dict[str, str] = {}
    for layer in layers:
        for key, value in effective_layer_tools(load_layer(layer), values).items():
            tools[str(key)] = render_text(str(value), values)
    return tools


def _stored_tool_pins(root: Path) -> dict[str, str]:
    try:
        data = json.loads(metadata_path(root).read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    pins = data.get("tool_pins", {}) if isinstance(data, dict) else {}
    return {str(key): str(value) for key, value in pins.items()} if isinstance(pins, dict) else {}


def resolve_tool_pins(root: Path, layers: list[str], values: dict[str, str], *, bump: bool = False) -> dict[str, str]:
    """Resolve each layer tool once; updates reuse recorded versions by default."""
    requested = layer_tools(layers, values)
    previous = _stored_tool_pins(root)
    resolved: dict[str, str] = {}
    for tool, version in requested.items():
        if not bump and tool in previous and previous[tool] not in {"", "latest"}:
            resolved[tool] = previous[tool]
            continue
        if version not in {"", "latest"}:
            resolved[tool] = version
            continue
        try:
            result = subprocess.run(["mise", "latest", tool], cwd=root, capture_output=True, text=True, check=False)
        except OSError:
            result = None
        candidate = result.stdout.strip().splitlines()[-1].strip() if result and result.returncode == 0 and result.stdout.strip() else ""
        # A missing mise shim should not make legacy render unusable. Apply/preflight
        # report this as a missing tool; when present, latest is always exact.
        resolved[tool] = candidate or "latest"
    return resolved


def apply_tool_pins(blocks: dict[str, list[dict[str, Any]]], pins: dict[str, str]) -> None:
    for item in blocks.get("mise.toml", []):
        rewritten: list[str] = []
        for line in item["body"].splitlines():
            if "=" not in line or not line.strip() or line.lstrip().startswith("#"):
                rewritten.append(line)
                continue
            raw_key, old_value = line.split("=", 1)
            key = raw_key.strip().strip('"')
            if key in pins:
                key_text = raw_key.strip()
                rewritten.append(f"{key_text} = {toml_value(pins[key])}")
            else:
                rewritten.append(line)
        item["body"] = "\n".join(rewritten) + "\n"


def configured_ownership(layers: list[str], values: dict[str, str]) -> dict[str, list[str]]:
    owners: dict[str, list[str]] = {}
    for layer in layers:
        config = load_layer(layer)
        for raw in config.get("owns", []):
            path = target_path(Path(str(raw)), values)
            owners.setdefault(str(path), []).append(layer)
    return owners


def marker_state(text: str, block: str, target: Path) -> str:
    begin, end = marker_pair(block, target)
    starts, ends = text.count(begin), text.count(end)
    if starts == 1 and ends == 1 and text.index(begin) < text.index(end):
        return "ok"
    if starts == 0 and ends == 0:
        return "missing"
    return "broken"


def classify(root: Path, layers: list[str], values: dict[str, str], force_layer: str | None, adopts: set[str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    direct, blocks = collect(layers, values)
    ownership = configured_ownership(layers, values)
    rows: list[dict[str, Any]] = []
    conflicts: list[dict[str, Any]] = []
    for path, owners in sorted(ownership.items()):
        if len(set(owners)) > 1:
            winner = force_layer and force_layer in owners
            if not winner:
                conflicts.append({"path": path, "owners": owners, "reason": "duplicate owns"})
            rows.append({"path": path, "layer": owners, "class": "create" if winner else "conflict"})
    for path, owners in sorted(direct.items()):
        names = [item["layer"] for item in owners]
        if len(owners) > 1:
            winner = force_layer and force_layer in names
            row_class = "create" if winner else "conflict"
            if not winner:
                conflicts.append({"path": path, "owners": names, "reason": "duplicate template"})
        else:
            target = root / path
            if not target.exists():
                row_class = "create"
            elif path in adopts:
                row_class = "adopt"
            elif path in {".omp/context.py", ".omp/project-context.json"} and not metadata_path(root).exists():
                row_class = "conflict"
                conflicts.append({"path": path, "owners": names, "reason": "unowned-file; explicit --adopt required"})
            elif path == ".omp/mcp.json":
                row_class = "update-merge"
            else:
                row_class = "skip"
        rows.append({"path": path, "layer": names[0] if len(names) == 1 else names, "class": row_class})
    for path, fragments in sorted(blocks.items()):
        target = root / path
        row_class = "create" if not target.exists() else "update-block"
        if target.is_symlink():
            row_class = "conflict"
            conflicts.append({"path": path, "reason": "managed block target is a symlink"})
        elif target.exists():
            text = target.read_text()
            for block in dict.fromkeys(item.get("block", item["layer"]) for item in fragments):
                if marker_state(text, block, Path(path)) == "broken":
                    row_class = "conflict"
                    conflicts.append({"path": path, "layer": block, "reason": "managed markers damaged or duplicated"})
        rows.append({"path": path, "layer": [item["layer"] for item in fragments], "class": row_class})
    for left in layers:
        for right in load_layer(left).get("conflicts_with", []):
            if str(right) in layers and layers.index(left) < layers.index(str(right)):
                conflicts.append({"layers": [left, str(right)], "reason": "conflicts_with"})
    return rows, conflicts


def plugin_sets(layers: list[str], values: dict[str, str]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for layer in layers:
        config = load_layer(layer)
        raw = config.get("plugins", {})
        if isinstance(raw, dict):
            for marketplace, entry in raw.items():
                if not isinstance(entry, dict):
                    continue
                condition = entry.get("when")
                if isinstance(condition, dict):
                    variable = str(condition.get("var", ""))
                    expected = str(condition.get("equals", "true"))
                    if str(values.get(variable, "")).lower() != expected.lower():
                        continue
                item = result.setdefault(str(marketplace), {"source": str(entry.get("source", marketplace)), "plugins": []})
                item["source"] = str(entry.get("source", item["source"]))
                item["plugins"] = list(dict.fromkeys(item["plugins"] + [str(p) for p in entry.get("plugins", [])]))
        conditionals = config.get("conditional_plugins", {})
        if isinstance(conditionals, dict):
            for plugin, condition in conditionals.items():
                if not isinstance(condition, dict):
                    continue
                variable = str(condition.get("var", ""))
                expected = str(condition.get("equals", "true"))
                if str(values.get(variable, "")).lower() == expected.lower():
                    item = result.setdefault("srobroek-omp", {"source": "srobroek/omp-plugins", "plugins": []})
                    item["plugins"] = list(dict.fromkeys(item["plugins"] + [str(plugin)]))
    if str(values.get("speckit", "")).lower() in TRUTHY:
        item = result.setdefault("srobroek-omp", {"source": "srobroek/omp-plugins", "plugins": []})
        item["plugins"] = list(dict.fromkeys(item["plugins"] + ["speckit"]))
    return result


def plan_payload(root: Path, profile_name: str | None, name: str | None, overrides: dict[str, str], extra_layers: list[str], force_layer: str | None, adopts: set[str]) -> tuple[dict[str, Any], dict[str, Any], list[str], dict[str, str], int]:
    profile_name, profile, layers, values = resolve_selection(root, profile_name, name, overrides, extra_layers)
    rows, conflicts = classify(root, layers, values, force_layer, adopts)
    members = answers_members(root) if str(values.get("layout", "single")) == "monorepo" else []
    seen_dirs: dict[str, str] = {}
    for member in members:
        directory = str(member["dir"])
        rows.append({"path": directory, "layer": member["layer"], "member": member["name"], "class": "create" if not (root / directory).exists() else "skip"})
        if directory in seen_dirs:
            conflicts.append({"path": directory, "members": [seen_dirs[directory], member["name"]], "reason": "members claim the same directory"})
        else:
            seen_dirs[directory] = member["name"]
    payload = {"profile": profile_name, "layers": layers, "root": str(root), "files": rows, "conflicts": conflicts, "vars": values, "members": members}
    return payload, profile, layers, values, EXIT_CONFLICT if conflicts else 0


def merge_json(existing: str, generated: str) -> tuple[str, list[str]]:
    old, new = json.loads(existing), json.loads(generated)
    if not isinstance(old, dict) or not isinstance(new, dict):
        raise ValueError("JSON merge requires objects")
    added: list[str] = []
    def merge(dst: dict[str, Any], src: dict[str, Any], prefix: str = "") -> None:
        for key, value in src.items():
            full = f"{prefix}.{key}" if prefix else key
            if key not in dst:
                dst[key] = value
                added.append(full)
            elif isinstance(dst[key], dict) and isinstance(value, dict):
                merge(dst[key], value, full)
    merge(old, new)
    if not added:
        return existing, []
    return json.dumps(old, indent=2) + "\n", added


def existing_plugins(path: Path) -> dict[str, dict[str, Any]]:
    if not path.is_file():
        return {}
    try:
        data = load_toml(path)
    except (OSError, tomllib.TOMLDecodeError):
        return {}
    result: dict[str, dict[str, Any]] = {}
    for entry in data.get("marketplaces", []) if isinstance(data.get("marketplaces"), list) else []:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name", entry.get("source", "")))
        if name:
            result[name] = {"source": str(entry.get("source", name)), "plugins": [str(p) for p in entry.get("plugins", [])]}
    return result


def write_plugins(root: Path, desired: dict[str, dict[str, Any]]) -> dict[str, list[str]]:
    path = root / ".omp" / "plugins.toml"
    path.parent.mkdir(parents=True, exist_ok=True)
    merged = existing_plugins(path)
    additions: dict[str, list[str]] = {}
    for name, value in desired.items():
        item = merged.setdefault(name, {"source": value["source"], "plugins": []})
        item.setdefault("source", value["source"])
        before = list(item.get("plugins", []))
        item["plugins"] = list(dict.fromkeys(before + value.get("plugins", [])))
        additions[name] = [p for p in item["plugins"] if p not in before]
    lines: list[str] = []
    for name, value in merged.items():
        lines += ["[[marketplaces]]", f"name = {json.dumps(name)}", f"source = {json.dumps(value['source'])}", "plugins = [" + ", ".join(json.dumps(p) for p in value["plugins"]) + "]", ""]
    content = "\n".join(lines)
    if content and not content.endswith("\n"):
        content += "\n"
    if not path.exists() or path.read_text() != content:
        _write_under_root(root, path, content)
    return additions


def merge_tools_block(existing: str, generated: str, block: str, target: Path) -> str:
    # Keep an existing [tools] table valid and existing keys authoritative.  Missing
    # generated keys are appended as assignments inside the managed marker block.
    begin, end = marker_pair(block, target)
    state = marker_state(existing, block, target)
    try:
        old = tomllib.loads(existing) if existing.strip() else {}
    except tomllib.TOMLDecodeError:
        old = {}
    try:
        new = tomllib.loads(generated) if generated.strip() else {}
    except tomllib.TOMLDecodeError:
        new = {}
    old_tools = old.get("tools", {}) if isinstance(old.get("tools"), dict) else {}
    new_tools = new.get("tools", {}) if isinstance(new.get("tools"), dict) else {}
    missing = {k: v for k, v in new_tools.items() if k not in old_tools}
    if state == "ok" and not missing:
        return existing
    assignments = "\n".join(f"{(key if re.fullmatch(r'[A-Za-z0-9_-]+', str(key)) else json.dumps(str(key)))} = {toml_value(value)}" for key, value in missing.items())
    if not old_tools and new_tools:
        body = generated.rstrip("\n")
    else:
        body = assignments or "# no new tool keys"
    if state == "ok":
        start, finish = existing.index(begin), existing.index(end) + len(end)
        # Keep every assignment the block already carries; a re-render only appends keys
        # that are new to the whole [tools] table. Dropping the old body lost provider keys.
        current = existing[start + len(begin):existing.index(end)].strip("\n")
        kept = [line for line in current.splitlines() if line.strip() and not line.strip().startswith("#")]
        if not old_tools and new_tools:
            merged_body = body
        else:
            merged_body = "\n".join(kept + ([assignments] if assignments else [])) or "# no new tool keys"
        return existing[:start] + begin + "\n" + merged_body + "\n" + end + existing[finish:]
    if state == "broken":
        raise ValueError(f"managed markers conflict in {target}; expected {begin} and {end}")
    if existing and not existing.endswith("\n"):
        existing += "\n"
    return existing + begin + "\n" + body + "\n" + end + "\n"
def replace_block(existing: str, body: str, block: str, target: Path) -> str:
    begin, end = marker_pair(block, target)
    state = marker_state(existing, block, target)
    if state == "broken":
        raise ValueError(f"managed markers conflict in {target}; expected {begin} and {end}")
    if target.name == ".pre-commit-config.yaml":
        body_lines = body.splitlines()
        if body_lines and body_lines[0].strip() == "repos:":
            body_lines = body_lines[1:]
        item_match = next((re.match(r"^(\s*)-\s+repo:", line) for line in body_lines if line.strip()), None)
        generated_indent = len(item_match.group(1)) if item_match else 2
        def body_for_indent(indent: int) -> str:
            delta = indent - generated_indent
            adjusted: list[str] = []
            for line in body_lines:
                if not line.strip():
                    adjusted.append(line)
                elif delta >= 0:
                    adjusted.append(" " * delta + line)
                else:
                    adjusted.append(line[min(-delta, len(line) - len(line.lstrip())):])
            return "\n".join(adjusted).rstrip("\n")
        if state == "ok":
            start, finish = existing.index(begin), existing.index(end) + len(end)
            old_block = existing[start:finish]
            old_item = next((re.match(r"^(\s*)-\s+repo:", line) for line in old_block.splitlines() if line.strip()), None)
            desired_indent = len(old_item.group(1)) if old_item else generated_indent
            return existing[:start] + begin + "\n" + body_for_indent(desired_indent) + "\n" + end + existing[finish:]
        lines = existing.splitlines(keepends=True)
        repos_index = next((index for index, line in enumerate(lines) if re.match(r"^repos:\s*$", line.rstrip("\n"))), None)
        if repos_index is None:
            lines = ["repos:\n"] + lines
            repos_index = 0
            list_indent = 2
            insert_index = 1
        else:
            list_indent = next((len(match.group(1)) for line in lines[repos_index + 1:] if (match := re.match(r"^(\s*)-\s+repo:", line))), 2)
            insert_index = repos_index + 1
            for index in range(repos_index + 1, len(lines)):
                line = lines[index]
                if line.strip() and not line[:1].isspace() and not line.lstrip().startswith("#"):
                    insert_index = index
                    break
                insert_index = index + 1
        fragment = begin + "\n" + body_for_indent(list_indent) + "\n" + end + "\n"
        prefix = "".join(lines[:insert_index])
        if prefix and not prefix.endswith("\n"):
            prefix += "\n"
        return prefix + fragment + "".join(lines[insert_index:])
    if state == "ok":
        start, finish = existing.index(begin), existing.index(end) + len(end)
        return existing[:start] + begin + "\n" + body.rstrip("\n") + "\n" + end + existing[finish:]
    if existing and not existing.endswith("\n"):
        existing += "\n"
    return existing + begin + "\n" + body.rstrip("\n") + "\n" + end + "\n"


def metadata_path(root: Path) -> Path:
    return root / ".omp" / "scaffold.json"


def file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def render_release_members(root: Path, members: list[dict[str, str]], written: list[str]) -> None:
    if not members:
        return
    release_types = {"python": "python", "ts": "node", "rust": "rust", "go": "go"}
    packages: dict[str, dict[str, Any]] = {}
    manifest: dict[str, str] = {}
    for member in members:
        family = member_family(member["layer"])
        directory = str(member["dir"])
        packages[directory] = {"release-type": release_types.get(family, "simple"), "component": member["name"], "extra-files": [f"{directory}/pyproject.toml" if family == "python" else f"{directory}/package.json" if family == "ts" else f"{directory}/Cargo.toml" if family == "rust" else f"{directory}/go.mod"]}
        manifest[directory] = "0.1.0"
    config = {"$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json", "include-component-in-tag": True, "packages": packages}
    config_path = root / "release-please-config.json"
    manifest_path = root / ".release-please-manifest.json"
    _write_under_root(root, config_path, json.dumps(config, indent=2) + "\n")
    _write_under_root(root, manifest_path, json.dumps(manifest, indent=2) + "\n")
    written.extend(["release-please-config.json", ".release-please-manifest.json"])


def render_workspace_manifest(root: Path, members: list[dict[str, str]], values: dict[str, str], written: list[str]) -> None:
    """Render per-family workspace manifests without overwriting user files."""
    families: dict[str, list[dict[str, str]]] = {}
    for member in members:
        families.setdefault(member_family(member["layer"]), []).append(member)
    for family, family_members in families.items():
        dirs = [str(item["dir"]) for item in family_members]
        if family == "python":
            path = root / "pyproject.toml"
            text = "[tool.uv.workspace]\nmembers = [" + ", ".join(json.dumps(item) for item in dirs) + "]\n"
        elif family == "ts":
            path = root / "package.json"
            text = json.dumps({"private": True, "workspaces": dirs}, indent=2) + "\n"
        elif family == "rust":
            path = root / "Cargo.toml"
            text = "[workspace]\nmembers = [" + ", ".join(json.dumps(item) for item in dirs) + "]\n\n[workspace.lints]\n"
        elif family == "go":
            path = root / "go.work"
            text = "go 1.23\n\nuse (\n" + "\n".join(f"    ./{item}" for item in dirs) + "\n)\n"
        else:
            continue
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            _write_under_root(root, path, text)
            written.append(str(path.relative_to(root)))
        else:
            old = path.read_text()
            if family == "python" and "[tool.uv.workspace]" not in old:
                _write_under_root(root, path, old.rstrip() + "\n\n" + text)
                written.append(str(path.relative_to(root)))
            elif family == "ts":
                try:
                    data = json.loads(old)
                    if "workspaces" not in data:
                        data["workspaces"] = dirs
                        _write_under_root(root, path, json.dumps(data, indent=2) + "\n")
                        written.append(str(path.relative_to(root)))
                except json.JSONDecodeError:
                    pass
            elif family == "rust" and "[workspace]" not in old:
                _write_under_root(root, path, old.rstrip() + "\n\n" + text)
                written.append(str(path.relative_to(root)))
            elif family == "go" and "\nuse (" not in old:
                _write_under_root(root, path, old.rstrip() + "\n\n" + text.split("\n\n", 1)[1])
                written.append(str(path.relative_to(root)))


def render_workspace_aggregates(root: Path, members: list[dict[str, str]], written: list[str]) -> None:
    just = root / "justfile"
    if not just.exists():
        return
    text = just.read_text()
    begin = "# agentic-scaffold:begin workspace-members"
    end = "# agentic-scaffold:end workspace-members"
    if members:
        recipes = [begin, "test: " + " ".join(f"{item['name']}-test" for item in members), "lint: " + " ".join(f"{item['name']}-lint" for item in members), "fmt: " + " ".join(f"{item['name']}-fmt" for item in members), "check: test lint fmt", end]
    else:
        recipes = [begin, "test:", "    @echo 'no workspace members'", "lint:", "    @echo 'no workspace members'", "fmt:", "    @echo 'no workspace members'", "check: test lint fmt", end]
    fragment = "\n".join(recipes) + "\n"
    if begin in text and end in text:
        start, finish = text.index(begin), text.index(end) + len(end)
        updated = text[:start] + fragment.rstrip("\n") + text[finish:]
    else:
        updated = text.rstrip("\n") + "\n\n" + fragment
    if updated != text:
        _write_under_root(root, just, updated)
        written.append("justfile")


def render_member_layers(root: Path, members: list[dict[str, str]], values: dict[str, str], written: list[str], skipped: list[str], drifted: list[str], preserve_paths: set[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for member in members:
        layer = str(member["layer"])
        load_layer(layer)
        scoped = member_values(values, member)
        direct, blocks = collect([layer], scoped, str(member["dir"]))
        for path, owners in sorted(direct.items()):
            target = root / path
            rows.append({"path": path, "layer": layer, "member": member["name"], "class": "create" if not target.exists() else "skip"})
            if target.exists():
                skipped.append(path)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            _write_under_root(root, target, owners[-1]["data"])
            written.append(path)
        for path, fragments in sorted(blocks.items()):
            target = root / path
            current = target.read_text() if target.exists() else ""
            for block in dict.fromkeys(item.get("block", item["layer"]) for item in fragments):
                body = "\n".join(item["body"].rstrip("\n") for item in fragments if item.get("block", item["layer"]) == block)
                try:
                    current = replace_block(current, body, block, Path(path))
                except ValueError:
                    continue
            if current != (target.read_text() if target.exists() else ""):
                target.parent.mkdir(parents=True, exist_ok=True)
                _write_under_root(root, target, current)
                written.append(path)
            rows.append({"path": path, "layer": layer, "member": member["name"], "class": "update-block"})
    return rows


def render(root: Path, profile_name: str | None, name: str | None, overrides: dict[str, str], extra_layers: list[str], force_layer: str | None = None, adopts: set[str] | None = None, dry_run: bool = False, preserve_paths: set[str] | None = None, bump_tools: bool = False, refresh_paths: set[str] | None = None) -> tuple[dict[str, Any], int]:
    adopts = adopts or set()
    preserve_paths = preserve_paths or set()
    refresh_paths = refresh_paths or set()
    plan, profile, layers, values, code = plan_payload(root, profile_name, name, overrides, extra_layers, force_layer, adopts)
    if dry_run or code == EXIT_CONFLICT:
        return plan, code
    direct, blocks = collect(layers, values)
    tool_pins = resolve_tool_pins(root, layers, values, bump=bump_tools)
    apply_tool_pins(blocks, tool_pins)
    written: list[str] = []
    skipped: list[str] = []
    drifted: list[str] = []
    for path, owners in sorted(direct.items()):
        target = root / path
        if path in adopts and target.exists():
            backup = root / f"{path}.scaffold-orig"
            backup.parent.mkdir(parents=True, exist_ok=True)
            if backup.exists():
                backup = root / f"{path}.scaffold-orig-{datetime.now(UTC).strftime('%Y%m%d%H%M%S')}"
            _rename_under_root(root, target, backup)
        selected = owners[-1] if force_layer is None else next((item for item in owners if item["layer"] == force_layer), owners[-1])
        if path in preserve_paths and target.exists():
            drifted.append(path)
            skipped.append(path)
            continue
        if target.exists() and path == ".omp/mcp.json":
            merged, additions = merge_json(target.read_text(), selected["data"])
            if merged != target.read_text():
                _write_under_root(root, target, merged)
                written.append(path)
            else:
                skipped.append(path)
            continue
        if target.exists():
            # An owned file the user never touched (hash still equals the last render) is
            # refreshed when the template output changed; anything else is left alone.
            if path in refresh_paths and target.read_bytes() != selected["data"].encode():
                _write_under_root(root, target, selected["data"])
                written.append(path)
            else:
                skipped.append(path)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        _write_under_root(root, target, selected["data"])
        written.append(path)
    for path, fragments in sorted(blocks.items()):
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        current = target.read_text() if target.exists() else ""
        for block in dict.fromkeys(item.get("block", item["layer"]) for item in fragments):
            body = "\n".join(item["body"].rstrip("\n") for item in fragments if item.get("block", item["layer"]) == block)
            try:
                if target.name == "mise.toml":
                    current = merge_tools_block(current, body, block, Path(path))
                else:
                    current = replace_block(current, body, block, Path(path))
            except ValueError as exc:
                return {**plan, "error": str(exc)}, EXIT_CONFLICT
        if current != (target.read_text() if target.exists() else ""):
            _write_under_root(root, target, current)
            written.append(path)
        else:
            skipped.append(path)
    members = answers_members(root) if str(values.get("layout", "single")) == "monorepo" else []
    member_rows: list[dict[str, Any]] = []
    if members:
        member_rows = render_member_layers(root, members, values, written, skipped, drifted, preserve_paths)
        render_workspace_manifest(root, members, values, written)
        render_workspace_aggregates(root, members, written)
        render_release_members(root, members, written)
    elif str(values.get("layout", "single")) == "monorepo":
        render_workspace_aggregates(root, members, written)
    additions = write_plugins(root, plugin_sets(layers, values))
    root_meta = metadata_path(root)
    root_meta.parent.mkdir(parents=True, exist_ok=True)
    owned_hashes = {path: file_hash(root / path) for path in direct if (root / path).is_file()}
    member_meta = [{"name": item["name"], "layer": item["layer"], "kind": item["kind"], "dir": item["dir"], "owned_hashes": {str(path.relative_to(root)): file_hash(path) for path in (root / item["dir"]).rglob("*") if path.is_file()}} for item in members]
    resolved_profile = str(plan.get("profile") or profile_name or values.get("profile") or "")
    tool_values: dict[str, str] = {}
    if (root / "mise.toml").is_file():
        try:
            parsed_tools = tomllib.loads((root / "mise.toml").read_text()).get("tools", {})
            if isinstance(parsed_tools, dict):
                tool_values = {str(k): str(v) for k, v in parsed_tools.items()}
        except tomllib.TOMLDecodeError:
            tool_values = tool_pins
    else:
        tool_values = tool_pins
    # Render owns the layout fields; every other stage's state (hooks, plugins, context) is preserved.
    previous_meta: dict[str, Any] = {}
    if root_meta.is_file():
        try:
            previous_meta = json.loads(root_meta.read_text())
        except (OSError, json.JSONDecodeError):
            previous_meta = {}
    render_meta = {"profile": resolved_profile, "layers": layers, "vars": values, "layout": values.get("layout", "single"), "members": member_meta, "owned_hashes": owned_hashes, "tool_pins": tool_values, "plugin_version": read_answers(root).get("plugin_version", "")}
    _write_under_root(root, root_meta, json.dumps({**previous_meta, **render_meta}, indent=2, sort_keys=True) + "\n")
    write_answers(root, resolved_profile, layers, values, {"members": members} if members else None)
    return {**plan, "files": plan.get("files", []) + member_rows, "written": written, "skipped": skipped, "drifted": drifted, "plugin_additions": additions, "members": members}, 0


def parse_vars(raw: list[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for item in raw:
        if "=" not in item:
            fail(f"--var requires key=value: {item}", 2)
        key, value = item.split("=", 1)
        result[key] = value
    return result


def inspect(root: Path) -> dict[str, Any]:
    stacks: list[str] = []
    checks = [("python", ("pyproject.toml", "uv.lock")), ("ts", ("package.json", "bun.lock", "bun.lockb")), ("rust", ("Cargo.toml",)), ("go", ("go.mod",))]
    for stack, files in checks:
        if any((root / item).exists() for item in files):
            stacks.append(stack)
    if any(root.glob("*.tf")) or (root / "main.tf").exists():
        stacks.append("terraform")
    notes: list[str] = []
    if stacks:
        selected = stacks[0]
        if len(stacks) > 1:
            notes.append(f"multiple stacks detected; selected {selected}")
        if selected == "python":
            try:
                project = load_toml(root / "pyproject.toml")
            except SystemExit:
                project = {}
            suggested = "python-app" if isinstance(project.get("project", {}).get("scripts"), dict) and project["project"]["scripts"] else "python-lib"
        elif selected == "ts":
            package = {}
            try:
                package = json.loads((root / "package.json").read_text()) if (root / "package.json").is_file() else {}
            except json.JSONDecodeError:
                package = {}
            suggested = "ts-app" if (root / "src/index.ts").is_file() or package.get("bin") else "ts-lib"
        elif selected == "rust":
            suggested = "rust-app" if (root / "src/main.rs").is_file() else "rust-lib"
        elif selected == "go":
            suggested = "go-app" if (root / "cmd").is_dir() else "go-lib"
        else:
            suggested = "terraform"
    else:
        suggested = "agentic-repo"
    tools = {name: shutil.which(name) is not None for name in ("uv", "bun", "mise", "prek", "just", "gh", "bd", "omp")}
    hook_files = [str(p.relative_to(root)) for p in (root / ".pre-commit-config.yaml", root / "prek.toml") if p.exists()]
    hook_findings: list[dict[str, Any]] = []
    for marker in (root / ".husky", root / ".lefthook.yml", root / "lefthook.yml"):
        if marker.exists():
            hook_findings.append({"kind": "hook-manager", "path": str(marker.relative_to(root))})
    try:
        git_hooks = subprocess.run(["git", "config", "--get", "core.hooksPath"], cwd=root, capture_output=True, text=True, check=False)
        if git_hooks.returncode == 0 and git_hooks.stdout.strip():
            hook_findings.append({"kind": "hook-manager", "path": "core.hooksPath", "value": git_hooks.stdout.strip()})
    except OSError:
        pass
    for path in (root / ".omp/context.py", root / ".omp/project-context.json"):
        if path.exists() and not metadata_path(root).exists():
            hook_findings.append({"kind": "unowned-file", "path": str(path.relative_to(root))})
    return {"root": str(root), "git": (root / ".git").exists(), "stacks": stacks, "tooling": {"mise": (root / "mise.toml").exists(), "just": (root / "justfile").exists(), "prek": bool(hook_files), "omp": (root / ".omp").exists(), "agents": (root / "AGENTS.md").exists(), "beads": (root / ".beads").exists()}, "hook_manager_conflicts": hook_files if len(hook_files) > 1 else [], "findings": hook_findings, "missing_tools": [name for name, found in tools.items() if not found], "tools": tools, "suggested_profile": suggested, "suggestedProfile": suggested, "notes": notes}
def declared_hook_stages(config: str) -> list[str]:
    groups = re.findall(r"(?:default_install_hook_types|stages):\s*\[([^]]+)\]", config)
    return sorted({part.strip(" '\"") for group in groups for part in group.split(",") if part.strip()})


def _save_hook_meta(root: Path, updates: dict[str, Any]) -> None:
    meta: dict[str, Any] = {}
    if metadata_path(root).is_file():
        try:
            meta = json.loads(metadata_path(root).read_text())
        except json.JSONDecodeError:
            meta = {}
    meta.update(updates)
    metadata_path(root).parent.mkdir(parents=True, exist_ok=True)
    _write_under_root(root, metadata_path(root), json.dumps(meta, indent=2, sort_keys=True) + "\n")


def _global_hooks_path(root: Path) -> tuple[str, str]:
    """Return (path, scope) when core.hooksPath is set outside the repository.

    A repo-local setting wins and yields ("", ""): prek can install directly.
    """
    for scope in ("local", "global", "system"):
        try:
            result = subprocess.run(
                ["git", "config", f"--{scope}", "--get", "core.hooksPath"],
                cwd=root,
                capture_output=True,
                text=True,
                check=False,
            )
        except OSError:
            continue
        value = result.stdout.strip()
        if result.returncode == 0 and value:
            return ("", "") if scope == "local" else (value, scope)
    return "", ""


def _git_defender_hook_report() -> dict[str, Any]:
    return {"strategy": "git-defender", "stages": {"pre-commit": "chained", "pre-push": "git shim (container runs prek --stage pre-push)", "commit-msg": "not run", "post-commit|post-checkout|post-merge": "not run — use `just context`"}}


def hooks_install(root: Path, migrate: bool = False, force: bool = False) -> tuple[dict[str, Any], int]:
    config = root / ".pre-commit-config.yaml"
    if not config.is_file():
        return {"error": "no .pre-commit-config.yaml"}, EXIT_ERROR
    declared = declared_hook_stages(config.read_text())
    valid = {"pre-commit", "commit-msg", "pre-push", "post-commit", "post-checkout", "post-merge", "pre-rebase", "prepare-commit-msg", "post-rewrite", "pre-merge-commit"}
    stages = [stage for stage in declared if stage in valid]
    ignored = [stage for stage in declared if stage not in valid]
    hooks_path, hooks_scope = _global_hooks_path(root)
    if hooks_path and shutil.which("git-defender"):
        command = [str(shutil.which("git-defender")), "precommit-tool-setup"]
        run = subprocess.run(command, cwd=root, capture_output=True, text=True, check=False, env=_project_mise_env(root))
        report = _git_defender_hook_report()
        if run.returncode == 0:
            _save_hook_meta(root, {"hooks_installed": True, "hook_stages": ["pre-commit", "pre-push"], "declared_hook_stages": declared, "ignored_hook_stages": ignored, "hook_install_status": "installed", "hook_strategy": "git-defender", "hook_stage_report": report})
        return {"command": command, "declared": declared, "ignored": ignored, "installed": ["pre-commit", "pre-push"] if run.returncode == 0 else [], "strategy": report["strategy"], "stages": report["stages"], "stdout": run.stdout, "stderr": run.stderr, "hooksPath": hooks_path, "hooksPathScope": hooks_scope}, run.returncode
    if hooks_path and not force:
        finding = {"kind": "hook-manager", "path": "core.hooksPath", "value": hooks_path, "options": ["run prek install --force into the repository hooks directory", "move core.hooksPath to repository scope", "skip hooks"]}
        _save_hook_meta(root, {"hook_install_status": "refused", "hook_manager": finding, "declared_hook_stages": declared, "ignored_hook_stages": ignored})
        return {"finding": finding, "declared": declared, "ignored": ignored, "installed": [], "error": "global core.hooksPath is configured"}, EXIT_DRIFT
    command = ["prek", "install"]
    if force:
        command.append("--force")
    command += sum((["--hook-type", stage] for stage in stages), [])
    if migrate:
        command.append("--migrate")
    try:
        run = subprocess.run(command, cwd=root, capture_output=True, text=True, check=False)
    except OSError as exc:
        return {"command": command, "declared": declared, "ignored": ignored, "installed": [], "strategy": "prek", "stages": {stage: "prek" for stage in stages}, "error": f"tool-missing: prek ({exc})"}, EXIT_DRIFT
    report = {"strategy": "prek", "stages": {stage: "prek" for stage in stages}}
    if run.returncode == 0:
        _save_hook_meta(root, {"hooks_installed": True, "hook_stages": stages, "declared_hook_stages": declared, "ignored_hook_stages": ignored, "hook_install_status": "installed", "hook_strategy": "prek", "hook_stage_report": report})
    return {"command": command, "declared": declared, "ignored": ignored, "installed": stages if run.returncode == 0 else [], "strategy": report["strategy"], "stages": report["stages"], "stdout": run.stdout, "stderr": run.stderr}, run.returncode
def read_plugins(root: Path) -> list[dict[str, Any]]:
    return [{"name": name, **value} for name, value in existing_plugins(root / ".omp/plugins.toml").items()]

def marketplace_items(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [x for x in payload if isinstance(x, dict)]
    if isinstance(payload, dict):
        for key in ("marketplaces", "items", "results"):
            if isinstance(payload.get(key), list):
                return [x for x in payload[key] if isinstance(x, dict)]
    return []


def marketplace_text_items(text: str) -> list[dict[str, Any]]:
    """Parse OMP versions that ignore the --json option and print a table."""
    items: list[dict[str, Any]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith(("Configured Marketplaces:", "-")):
            continue
        parts = line.split()
        if len(parts) >= 2 and "/" in parts[1]:
            items.append({"name": parts[0], "source": parts[1]})
    return items

def installed_plugins(path: Path) -> set[tuple[str, str]]:
    if not path.is_file():
        return set()
    try:
        payload = json.loads(path.read_text())
    except json.JSONDecodeError:
        return set()
    found: set[tuple[str, str]] = set()
    entries = payload.get("plugins", {}) if isinstance(payload, dict) else {}
    if isinstance(entries, dict):
        for identifier, values in entries.items():
            if not isinstance(identifier, str) or "@" not in identifier:
                continue
            plugin, marketplace = identifier.split("@", 1)
            if isinstance(values, list) and any(_project_entry_present(item) for item in values):
                found.add((plugin, marketplace))
    return found


def _project_entry_present(item: object) -> bool:
    """A project entry counts only while its install path still exists.

    `omp plugin uninstall` at user scope deletes the shared cache directory that
    project entries symlink into, leaving a registry row that points nowhere.
    """
    if not isinstance(item, dict) or item.get("scope") != "project":
        return False
    install_path = item.get("installPath")
    if not isinstance(install_path, str) or not install_path:
        return True
    return Path(install_path).exists()
def plugins_sync(root: Path, check: bool) -> tuple[dict[str, Any], int]:
    desired = read_plugins(root)
    if not desired:
        return {"desired": [], "drift": []}, 0
    result = subprocess.run(["omp", "plugin", "marketplace", "list", "--json"], cwd=root, capture_output=True, text=True, check=False)
    if result.returncode:
        return {"error": result.stderr.strip() or "omp marketplace list failed"}, EXIT_ERROR
    try:
        available = marketplace_items(json.loads(result.stdout))
    except json.JSONDecodeError:
        available = marketplace_text_items(result.stdout)
    if not available and result.stdout.strip() and "Configured Marketplaces:" not in result.stdout:
        return {"error": "omp marketplace list returned invalid JSON"}, EXIT_ERROR
    names = {str(item.get("name", item.get("id", ""))) for item in available}
    sources = {str(item.get("source", "")) for item in available}
    installed = installed_plugins(root / ".omp/plugins/installed_plugins.json")
    drift: list[str] = []
    for marketplace in desired:
        name = str(marketplace.get("name", marketplace.get("source", "")))
        source = str(marketplace.get("source", name))
        if name not in names and source not in sources:
            drift.append(f"marketplace:{name}")
            if not check:
                add = subprocess.run(["omp", "plugin", "marketplace", "add", source], cwd=root, capture_output=True, text=True, check=False)
                if add.returncode:
                    return {"error": add.stderr.strip() or f"failed to add {source}"}, EXIT_ERROR
        for plugin in marketplace.get("plugins", []):
            key = (str(plugin), name)
            if key not in installed:
                drift.append(f"plugin:{plugin}@{name}")
                if not check:
                    install = subprocess.run(["omp", "plugin", "install", f"{plugin}@{name}", "--scope", "project"], cwd=root, capture_output=True, text=True, check=False)
                    if install.returncode:
                        return {"error": install.stderr.strip() or f"failed to install {plugin}@{name}"}, EXIT_ERROR
                    installed = installed_plugins(root / ".omp/plugins/installed_plugins.json")
    return {"desired": desired, "drift": drift}, EXIT_DRIFT if check and drift else 0
def member_answers_write(root: Path, members: list[dict[str, str]]) -> dict[str, Any]:
    answers = read_answers(root)
    profile_name = str(answers.get("profile", ""))
    if not profile_name:
        fail("member commands require .omp/scaffold-answers.toml", 2)
    _, _, layers, values = resolve_selection(root, profile_name, None, {}, [])
    write_answers(root, profile_name, layers, values, {"members": members})
    return {"path": str(answers_path(root)), "members": members}


def member_add(root: Path, name: str, layer: str, kind: str) -> dict[str, Any]:
    if not layer.startswith("lang/"):
        fail("member layer must be lang/<language>", 2)
    load_layer(layer)
    members = answers_members(root)
    if any(item["name"] == name for item in members):
        fail(f"member already exists: {name}", EXIT_CONFLICT)
    item = {"name": name, "layer": layer, "kind": kind, "dir": member_dir_for(name, layer, kind)}
    members.append(item)
    return {"added": item, **member_answers_write(root, members)}


def member_list(root: Path) -> dict[str, Any]:
    return {"members": answers_members(root)}


def member_remove(root: Path, name: str) -> dict[str, Any]:
    members = answers_members(root)
    selected = next((item for item in members if item["name"] == name), None)
    if selected is None:
        fail(f"member not found: {name}", 2)
    remaining = [item for item in members if item["name"] != name]
    payload = member_answers_write(root, remaining)
    payload.update({"removed": selected, "directory": selected["dir"], "deleted": False})
    return payload


def member_import(root: Path, directory: str, layer: str, kind: str) -> dict[str, Any]:
    relative = Path(directory)
    name = relative.name
    if relative.is_absolute():
        try:
            relative = relative.resolve().relative_to(root.resolve())
        except ValueError:
            fail("member directory must be inside root", 2)
    members = answers_members(root)
    if any(item["dir"] == str(relative) for item in members):
        fail(f"member already exists: {relative}", EXIT_CONFLICT)
    item = {"name": name, "layer": layer, "kind": kind, "dir": str(relative)}
    members.append(item)
    return {"imported": item, **member_answers_write(root, members)}






def tools_install(root: Path, yes: bool) -> tuple[dict[str, Any], int]:
    if not yes:
        return {"error": "refusing tool installation without --yes"}, EXIT_ERROR
    commands = [["mise", "--cd", str(root), "install"]]
    if (root / "pyproject.toml").exists() or (root / "uv.lock").exists():
        commands.append(["uv", "sync"])
    if (root / "package.json").exists():
        commands.append(["bun", "install"])
    output: list[dict[str, Any]] = []
    for command in commands:
        run = subprocess.run(command, cwd=root, capture_output=True, text=True, check=False)
        output.append({"command": command, "returncode": run.returncode, "stdout": run.stdout, "stderr": run.stderr})
        if run.returncode:
            return {"commands": output}, run.returncode
    return {"commands": output}, 0


def context_refresh(root: Path) -> tuple[dict[str, Any], int]:
    script = root / ".omp/context.py"
    if not script.is_file():
        return {"error": "no .omp/context.py"}, EXIT_ERROR
    missing = [tool for tool in ("graphify", "repomix") if not _tool_available(root, tool)]
    if not _graphify_mcp_available(root):
        missing.append("graphify-mcp")
    if missing:
        return {"error": "context tools missing after tools-install", "missing": missing, "next": "tools-install"}, EXIT_ERROR
    runner = ["mise", "exec", "--", "python3", str(script), "refresh"] if (root / "mise.toml").exists() and shutil.which("mise") else [sys.executable, str(script), "refresh"]
    run = subprocess.run(runner, cwd=root, capture_output=True, text=True, check=False, env=_project_mise_env(root))
    return {"stdout": run.stdout, "stderr": run.stderr}, run.returncode


def _mise_has(root: Path, tool: str) -> bool:
    if not (root / "mise.toml").exists() or not shutil.which("mise"):
        return False
    probe = subprocess.run(["mise", "which", _tool_command(tool)], cwd=root, capture_output=True, text=True, check=False, env=_project_mise_env(root))
    return probe.returncode == 0


def profiles_list() -> dict[str, Any]:
    result = []
    for path in sorted(PROFILES.glob("*.toml")):
        data = load_toml(path)
        result.append({"name": path.stem, "summary": data.get("summary", ""), "layers": data.get("layers", []), "vars": data.get("vars", {})})
    return {"profiles": result}


def layers_list() -> dict[str, Any]:
    result = []
    for path in sorted(TEMPLATES.glob("**/layer.toml")):
        name = str(path.parent.relative_to(TEMPLATES))
        data = load_layer(name)
        result.append({"name": name, "summary": data.get("summary", ""), "after": data.get("after", []), "requires_tools": data.get("requires_tools", []), "owns": data.get("owns", []), "blocks": data.get("blocks", []), "conflicts_with": data.get("conflicts_with", []), "plugins": data.get("plugins", {})})
    return {"layers": result}


def layers_show(name: str) -> dict[str, Any]:
    data = load_layer(name)
    return {key: value for key, value in data.items() if not key.startswith("_")}


def doctor(root: Path) -> tuple[dict[str, Any], int]:
    answers = read_answers(root)
    meta: dict[str, Any] = {}
    if metadata_path(root).is_file():
        try:
            meta = json.loads(metadata_path(root).read_text())
        except json.JSONDecodeError:
            return {"drift": ["invalid scaffold metadata"]}, EXIT_DRIFT
    profile_name = str(meta.get("profile", answers.get("profile", "")))
    if not profile_name:
        return {"drift": ["missing answers or scaffold metadata"]}, EXIT_DRIFT
    try:
        _, _, layers, values = resolve_selection(root, profile_name, None, {}, [])
    except SystemExit:
        return {"drift": ["cannot resolve rendered profile"]}, EXIT_DRIFT
    drift: list[str] = []
    errors: list[str] = []
    answers_present = answers_path(root).is_file()
    if not answers_present:
        drift.append("answers file missing")
    required_tools = {str(tool) for layer in layers for tool in load_layer(layer).get("requires_tools", [])}
    declared_tools = _mise_tools(root)
    tool_status: dict[str, bool] = {}
    for tool in sorted(required_tools | set(declared_tools)):
        command = _tool_command(tool)
        present = shutil.which(command) is not None
        tool_status[tool] = present
        if not present:
            drift.append(f"missing tool:{tool}")
    config_path = root / ".pre-commit-config.yaml"
    declared_hooks = declared_hook_stages(config_path.read_text()) if config_path.is_file() else []
    valid_stages = {"pre-commit", "commit-msg", "pre-push", "post-commit", "post-checkout", "post-merge", "pre-rebase", "prepare-commit-msg", "post-rewrite", "pre-merge-commit"}
    effective_hooks = [stage for stage in declared_hooks if stage in valid_stages]
    hook_strategy = str(meta.get("hook_strategy", "prek"))
    hook_report = meta.get("hook_stage_report")
    if hook_strategy == "git-defender":
        installed_hooks = ["pre-commit", "pre-push"] if meta.get("hooks_installed") else []
        hook_status = "installed" if meta.get("hooks_installed") else "not-installed"
    else:
        installed_hooks = [str(item) for item in meta.get("hook_stages", [])] if meta.get("hooks_installed") else []
        hook_status = "installed" if effective_hooks and set(effective_hooks) <= set(installed_hooks) else ("not-installed" if declared_hooks else "not-declared")
        hook_report = hook_report if isinstance(hook_report, dict) else {"strategy": hook_strategy, "stages": {stage: hook_strategy for stage in installed_hooks}}
    if declared_hooks and not meta.get("hooks_installed"):
        drift.append("hooks declared but not installed")
    if meta.get("hook_install_status") == "refused":
        drift.append("hook-manager refusal requires resolution")
        hook_status = "refused"
    if meta.get("hooks_installed") and hook_strategy != "git-defender":
        for stage in effective_hooks:
            if stage not in installed_hooks:
                drift.append(f"hook stage missing:{stage}")
            elif (root / ".git/hooks" / stage).parent.exists() and not (root / ".git/hooks" / stage).exists() and hook_strategy != "git-defender":
                drift.append(f"hook missing:{stage}")
    registry = root / ".omp/plugins/installed_plugins.json"
    if registry.is_file():
        try:
            entries = json.loads(registry.read_text()).get("plugins", {})
            for identifier, rows in entries.items() if isinstance(entries, dict) else []:
                for row in rows if isinstance(rows, list) else []:
                    if isinstance(row, dict) and row.get("scope") == "project" and (not row.get("installPath") or not Path(str(row["installPath"])).exists()):
                        drift.append(f"plugin installPath missing:{identifier}")
        except json.JSONDecodeError:
            drift.append("plugin registry invalid")
    if shutil.which("omp") and (root / ".omp/plugins.toml").is_file():
        plugin_result, plugin_code = plugins_sync(root, True)
        if plugin_code == EXIT_DRIFT:
            drift.extend(str(item) for item in plugin_result.get("drift", []))
        elif plugin_code:
            errors.append(str(plugin_result.get("error", "plugin check failed")))
    elif (root / ".omp/plugins.toml").is_file():
        drift.append("missing tool:omp")
        plugin_result = {"desired": read_plugins(root), "drift": []}
    else:
        plugin_result = {"desired": [], "drift": []}
    context_status = "not-applicable"
    if "agentic" in layers:
        context = root / ".omp/project-context.json"
        if context.is_file():
            try:
                data = json.loads(context.read_text())
                context_status = str(data.get("status", "CURRENT"))
                if context_status not in {"CURRENT", ""}:
                    drift.append("context STALE" if context_status == "STALE" else "context status is not CURRENT")
            except json.JSONDecodeError:
                context_status = "INVALID"
                drift.append("project-context.json invalid")
        else:
            context_status = "MISSING"
            drift.append("project-context.json missing")
    direct, blocks = collect(layers, values)
    marker_ok = True
    for path, fragments in blocks.items():
        target = root / path
        if not target.is_file():
            marker_ok = False
            drift.append(f"managed file missing:{path}")
            continue
        text = target.read_text()
        for block in dict.fromkeys(item.get("block", item["layer"]) for item in fragments):
            if marker_state(text, block, Path(path)) != "ok":
                marker_ok = False
                drift.append(f"managed markers damaged:{path}:{block}")
    payload = {"profile": profile_name, "layers": layers, "checks": {"answers": answers_present, "tools": tool_status, "plugins": plugin_result, "hooks": {"declared": declared_hooks, "installed": installed_hooks, "status": hook_status, "strategy": hook_strategy, "stages": hook_report.get("stages", {}) if isinstance(hook_report, dict) else {}}, "context": context_status, "markers": marker_ok}, "drift": sorted(set(drift)), "errors": errors}
    return payload, EXIT_ERROR if errors else (EXIT_DRIFT if drift else 0)


def update(root: Path, overrides: dict[str, str], extra_layers: list[str], force_layer: str | None, adopts: set[str], bump_tools: bool = False) -> tuple[dict[str, Any], int]:
    answers = read_answers(root)
    if not answers:
        return {"error": "missing .omp/scaffold-answers.toml"}, 2
    profile = str(answers.get("profile", ""))
    meta: dict[str, Any] = {}
    if metadata_path(root).is_file():
        try:
            meta = json.loads(metadata_path(root).read_text())
        except json.JSONDecodeError:
            pass
    _, _, layers, values = resolve_selection(root, profile, None, overrides, extra_layers)
    direct, _ = collect(layers, values)
    preserve: set[str] = set()
    drifted: list[str] = []
    known = meta.get("owned_hashes", {}) if isinstance(meta.get("owned_hashes"), dict) else {}
    refresh: set[str] = set()
    for path in direct:
        target = root / path
        if target.is_file() and path in known:
            if file_hash(target) != str(known[path]):
                preserve.add(path)
                drifted.append(path)
            else:
                refresh.add(path)
    payload, code = render(root, profile, None, overrides, extra_layers, force_layer, adopts, False, preserve, bump_tools, refresh)
    if drifted and metadata_path(root).is_file():
        try:
            updated_meta = json.loads(metadata_path(root).read_text())
            hashes = updated_meta.setdefault("owned_hashes", {})
            for path in drifted:
                if path in known:
                    hashes[path] = known[path]
            _write_under_root(root, metadata_path(root), json.dumps(updated_meta, indent=2, sort_keys=True) + "\n")
        except (OSError, json.JSONDecodeError):
            pass
    payload["drifted"] = sorted(set(drifted))
    return payload, code


def _command_version(command: str) -> str:
    try:
        result = subprocess.run([command, "--version"], capture_output=True, text=True, check=False)
    except OSError:
        return ""
    return result.stdout.strip() or result.stderr.strip()


def _version_at_least(raw: str, minimum: tuple[int, ...]) -> bool:
    match = re.search(r"(\d+)(?:\.(\d+))?(?:\.(\d+))?", raw)
    if not match:
        return False
    got = tuple(int(part or 0) for part in match.groups())
    return got >= minimum


def _mise_tools(root: Path) -> dict[str, str]:
    path = root / "mise.toml"
    if not path.is_file():
        return {}
    try:
        data = tomllib.loads(path.read_text())
    except tomllib.TOMLDecodeError:
        return {}
    values = data.get("tools", {})
    return {str(key): str(value) for key, value in values.items()} if isinstance(values, dict) else {}


def _project_mise_env(root: Path) -> dict[str, str]:
    """Run mise against the project's own config only: the scaffold never installs global tools."""
    env = dict(os.environ)
    empty = Path(tempfile.gettempdir()) / "agentic-scaffold-empty-mise.toml"
    if not empty.exists():
        empty.write_text("")
    env["MISE_GLOBAL_CONFIG_FILE"] = str(empty)
    env["MISE_CONFIG_DIR"] = str(empty.parent / "agentic-scaffold-empty-mise-config")
    Path(env["MISE_CONFIG_DIR"]).mkdir(exist_ok=True)
    env.pop("MISE_ENV", None)
    return env


def _tool_command(tool: str) -> str:
    if tool.startswith("pipx:"):
        value = tool.split(":", 1)[1].split("[", 1)[0].split("@", 1)[0]
        return "graphify" if value == "graphifyy" else value
    if tool.startswith("npm:"):
        return tool.split(":", 1)[1].split("@", 1)[0]
    if tool.startswith(("ubi:", "aqua:", "github:")):
        value = tool.split(":", 1)[1].split("@", 1)[0]
        return "bd" if value.endswith("/beads") else value.split("/", 1)[-1]
    return {"python": "python3", "node": "node", "rust": "cargo"}.get(tool, tool)


def _bd_environment(root: Path) -> dict[str, str]:
    env = os.environ.copy()
    env["BEADS_DIR"] = str((root / ".beads").resolve())
    env["BEADS_ACTOR"] = f"agentic-scaffold/{env.get('OMP_SESSION_ID', 'local')}"
    return env


def _scaffold_state_path(rel: str) -> bool:
    """Scaffold state under .omp/ never counts as user dirt: the interview writes it before apply."""
    rel = rel.strip().strip('"')
    return rel.startswith(".omp/scaffold") or rel.startswith(".omp/plugins") or rel == ".omp/"


def _scaffold_owned_paths(root: Path) -> set[str]:
    """Paths the scaffold owns or manages: owned files plus every managed-block target of the recorded layers."""
    owned: set[str] = {".omp/scaffold-answers.toml", ".omp/scaffold.json", ".omp/scaffold-run.json", ".omp/plugins.toml", "mise.toml",
                       "uv.lock", "bun.lock", "bun.lockb", "package-lock.json", "Cargo.lock", "go.sum", "graphify-out/", "repomix.xml"}
    try:
        meta = json.loads(metadata_path(root).read_text())
    except (OSError, json.JSONDecodeError):
        return owned
    owned.update(str(path) for path in meta.get("owned_hashes", {}) or {})
    for member in meta.get("members", []) or []:
        owned.update(str(path) for path in (member.get("owned_hashes") or {}))
    for layer in meta.get("layers", []) or []:
        try:
            owned.update(str(target) for target in load_layer(str(layer)).get("blocks", []))
        except Exception:
            continue
    return owned


def _owned_status_line(line: str, owned: set[str]) -> bool:
    rel = line[3:].strip().strip('"')
    if rel.endswith("/"):
        return any(path.startswith(rel) for path in owned)
    return rel in owned or any(rel.startswith(path.rstrip("/") + "/") for path in owned if path.endswith("/"))


def _tool_available(root: Path, tool: str) -> bool:
    """Project pins win: with a mise.toml the tool must resolve through the isolated project env; otherwise PATH decides."""
    if (root / "mise.toml").exists() and shutil.which("mise") and tool not in ("omp", "mise", "git"):
        return _mise_has(root, tool)
    return shutil.which(_tool_command(tool)) is not None


def _graphify_mcp_available(root: Path) -> bool:
    """graphify-mcp resolves through the project mise pins when present, else through PATH."""
    if (root / "mise.toml").exists() and shutil.which("mise"):
        probe = subprocess.run(["mise", "exec", "--", "graphify-mcp", "--help"], cwd=root, capture_output=True, text=True, check=False, env=_project_mise_env(root))
        if probe.returncode == 0:
            return True
    return shutil.which("graphify-mcp") is not None


def preflight(root: Path, profile_name: str | None, *, strict: bool = False, allow_dirty: bool = False) -> tuple[dict[str, Any], int]:
    root = validate_root(root, require_git=True)
    hard: list[str] = []
    soft: list[str] = []
    info = inspect(root)
    if not allow_dirty:
        status = subprocess.run(["git", "status", "--porcelain"], cwd=root, capture_output=True, text=True, check=False)
        owned = _scaffold_owned_paths(root)
        dirty = [line for line in status.stdout.splitlines() if line.strip() and not _scaffold_state_path(line[3:].strip()) and not _owned_status_line(line, owned)]
        if dirty:
            hard.append("git work tree is dirty (use --allow-dirty after review)")
    profile = profile_name or str(info.get("suggested_profile", "agentic-repo"))
    try:
        _, _, layers, values = resolve_selection(root, profile, None, {}, [])
    except SystemExit as exc:
        return {"ok": False, "profile": profile, "hard": [f"invalid profile: {profile}"], "soft": [], "layers": []}, int(exc.code or EXIT_ERROR)
    required = {"omp", "mise"}
    required.update(str(tool) for layer in layers for tool in load_layer(layer).get("requires_tools", []))
    if "agentic" in layers:
        required.update({"graphify", "repomix"})
    missing = sorted(tool for tool in required if not _tool_available(root, tool))
    if "omp" in required and shutil.which("omp") and not _version_at_least(_command_version("omp"), (18, 1)):
        hard.append("omp version must be >= 18.1")
    if strict:
        hard.extend(f"missing tool:{tool}" for tool in missing)
    else:
        soft.extend(f"missing tool:{tool}" for tool in missing)
    if "agentic" in layers and not _graphify_mcp_available(root):
        (hard if strict else soft).append("missing tool:graphify-mcp")
    hooks_path, hooks_scope = _global_hooks_path(root)
    if hooks_path and shutil.which("git-defender"):
        hook_strategy = "git-defender"
    elif hooks_path:
        hook_strategy = "needs-choice"
        soft.append("global core.hooksPath requires a hook strategy")
    else:
        hook_strategy = "prek"
    if (root / ".beads").exists() and not Path(os.environ.get("BEADS_DIR", "")).is_absolute():
        soft.append("BEADS_DIR must be absolute")
    plugins = plugins_sync(root, True) if (root / ".omp/plugins.toml").is_file() and shutil.which("omp") else ({"desired": [], "drift": []}, 0)
    if isinstance(plugins, tuple) and plugins[1] == EXIT_DRIFT:
        soft.extend(str(item) for item in plugins[0].get("drift", []))
    payload = {"ok": not hard, "profile": profile, "layers": layers, "vars": values, "hard": hard, "soft": soft, "missing_tools": missing, "hook_strategy": hook_strategy, "hooksPath": hooks_path, "hooksPathScope": hooks_scope, "checks": {"git": True, "omp": "omp" not in missing, "mise": "mise" not in missing, "tools": {tool: tool not in missing for tool in sorted(required)}, "plugins": plugins[0] if isinstance(plugins, tuple) else plugins}}
    return payload, EXIT_ERROR if hard else 0


def interview_questions(root: Path, profile_name: str | None = None) -> dict[str, Any]:
    info = inspect(root)
    brownfield = bool(info.get("git") and any(path for path in root.iterdir() if path.name != ".git"))
    suggested = profile_name or str(info.get("suggested_profile", "agentic-repo"))
    questions: list[dict[str, Any]] = []
    if brownfield:
        questions.append({"id": "profile", "prompt": f"Confirm the detected profile ({suggested})", "required": True, "default": suggested, "allowed": sorted(path.stem for path in PROFILES.glob("*.toml")), "source": "fixed"})
        questions.append({"id": "layers", "prompt": "Which layers should be adopted?", "required": True, "default": "agentic,hooks,tooling", "source": "fixed"})
        for finding in info.get("findings", []):
            kind = str(finding.get("kind", "unknown"))
            if kind == "hook-manager" and finding.get("path") == "core.hooksPath" and shutil.which("git-defender"):
                # preflight already decided the git-defender strategy; nothing for the human to choose
                continue
            options = finding.get("options")
            if kind == "hook-manager" and not options:
                options = ["prek install --force into the repository hooks directory", "move core.hooksPath to repository scope", "skip hooks"]
            prompt = f"Resolve finding {kind} at {finding.get('path', '?')}"
            if finding.get("value"):
                prompt += f" ({finding['value']})"
            if options:
                prompt += ". Choose one of: " + "; ".join(str(o) for o in options)
            questions.append({"id": f"finding:{kind}", "prompt": prompt, "required": True, "default": "", "allowed": options or None, "source": f"finding:{kind}"})
    else:
        fixed = [("name", "Project name", True, ""), ("purpose", "One-line project purpose", True, ""), ("kind", "Project kind", True, "lib"), ("language", "Project language", True, "none"), ("license", "License", True, "apache-2.0"), ("beads", "Use beads?", True, "false"), ("remote", "Create a remote now?", False, "no"), ("visibility", "Remote visibility", False, "private"), ("web_ui", "Include web UI tooling?", False, "false"), ("speckit", "Include SpecKit?", False, "false")]
        allowed = {"kind": ["lib", "app", "service", "cli"], "language": ["python", "ts", "rust", "go", "terraform", "none"], "beads": ["true", "false"]}
        for key, prompt, required, default in fixed:
            row: dict[str, Any] = {"id": key, "prompt": prompt, "required": required, "default": default, "source": "fixed"}
            if key in allowed:
                row["allowed"] = allowed[key]
            questions.append(row)
    layers = [str(item) for item in load_profile(suggested).get("layers", [])] if (PROFILES / f"{suggested}.toml").is_file() else []
    for layer in layers:
        raw = load_layer(layer).get("vars", {})
        if isinstance(raw, dict):
            for key, value in raw.items():
                if isinstance(value, dict) and value.get("ask") is True and not any(row["id"] == key for row in questions):
                    questions.append({"id": str(key), "prompt": str(value.get("prompt", key)), "required": bool(value.get("required", False)), "default": value_default(value), "source": f"layer:{layer}"})
    return {"questions": questions, "profile": suggested, "mode": "brownfield" if brownfield else "greenfield"}


def answers_write_interview(root: Path, profile_name: str | None, name: str | None, overrides: dict[str, str], defaults_for: list[str], extra_layers: list[str]) -> tuple[dict[str, Any], int]:
    profile = profile_name or str(read_answers(root).get("profile", "")) or None
    questions = interview_questions(root, profile)
    supplied = dict(overrides)
    if name:
        supplied["name"] = name
    missing = [str(row["id"]) for row in questions["questions"] if row.get("required") and not supplied.get(str(row["id"])) and str(row["id"]) not in defaults_for]
    if missing:
        return {"ok": False, "missing": missing, "questions": questions["questions"]}, EXIT_NEEDS_INPUT
    for row in questions["questions"]:
        key = str(row["id"])
        if key not in supplied and key in defaults_for and row.get("default") not in (None, ""):
            supplied[key] = str(row["default"])
    selected = profile or supplied.get("profile") or str(questions.get("profile", ""))
    if not selected:
        return {"ok": False, "missing": ["profile"]}, EXIT_NEEDS_INPUT
    values_profile, _, layers, values = resolve_selection(root, selected, supplied.get("name"), supplied, extra_layers)
    write_answers(root, values_profile, layers, values, {"defaults_for": defaults_for, "interviewed_at": datetime.now(UTC).isoformat(), "members": answers_members(root) if answers_members(root) else None})
    marker = root / ".omp/scaffold-run.json"
    _write_under_root(root, marker, json.dumps({"root": str(root), "started": datetime.now(UTC).isoformat(), "session": os.environ.get("OMP_SESSION_ID"), "profile": values_profile, "stages": []}, indent=2, sort_keys=True) + "\n")
    return {"ok": True, "path": str(answers_path(root)), "profile": values_profile, "layers": layers, "defaults_for": defaults_for, "vars": values}, 0


def _run_stage(root: Path, name: str, profile: str, *, allow_dirty: bool = False, bump_tools: bool = False) -> tuple[dict[str, Any], int]:
    if name == "preflight": return preflight(root, profile, strict=False, allow_dirty=allow_dirty)
    if name == "plan":
        result = plan_payload(root, profile, None, {}, [], None, set())
        return result[0], result[4]
    if name == "render": return render(root, profile, None, {}, [], None, set(), False, set(), bump_tools)
    if name == "tools-install": return tools_install(root, True)
    if name == "hooks-install": return hooks_install(root)
    if name == "plugins-sync": return plugins_sync(root, False)
    if name == "context-refresh": return context_refresh(root)
    if name == "doctor": return doctor(root)
    return {"error": f"unknown apply stage: {name}"}, EXIT_ERROR


APPLY_STAGES = ("preflight", "plan", "render", "tools-install", "hooks-install", "plugins-sync", "context-refresh", "doctor")


def apply_pipeline(root: Path, profile: str | None, *, dry_run: bool = False, stage: str | None = None, allow_dirty: bool = False, bump_tools: bool = False) -> tuple[dict[str, Any], int]:
    root = validate_root(root, require_git=True)
    answers = read_answers(root)
    selected = profile or str(answers.get("profile", ""))
    if not selected:
        return {"ok": False, "stages": [], "next": "answers write"}, EXIT_NEEDS_INPUT
    requested = [stage] if stage else list(APPLY_STAGES)
    if stage and stage not in APPLY_STAGES:
        return {"ok": False, "stages": [], "next": "unknown stage"}, EXIT_ERROR
    if dry_run:
        pf, pc = preflight(root, selected, strict=False, allow_dirty=allow_dirty)
        plan, _, _, _, plan_code = plan_payload(root, selected, None, {}, [], None, set())
        return {"ok": pc == 0 and plan_code == 0, "stages": [{"name": "preflight", "status": "ok" if pc == 0 else "failed", "seconds": 0, "summary": pf}, {"name": "plan", "status": "ok" if plan_code == 0 else "failed", "seconds": 0, "summary": plan}]}, pc or plan_code
    marker_path = root / ".omp/scaffold-run.json"
    try:
        marker = json.loads(marker_path.read_text()) if marker_path.is_file() else {"root": str(root), "started": datetime.now(UTC).isoformat(), "profile": selected, "stages": []}
    except json.JSONDecodeError:
        marker = {"root": str(root), "started": datetime.now(UTC).isoformat(), "profile": selected, "stages": []}
    # Every stage is idempotent, so a re-run always executes the whole requested list;
    # the marker keeps the last outcome per stage for the report, never as a skip list.
    rows: list[dict[str, Any]] = []
    for name in requested:
        started = datetime.now(UTC)
        summary, code = _run_stage(root, name, selected, allow_dirty=allow_dirty, bump_tools=bump_tools)
        status = "ok" if code == 0 else "failed"
        row = {"name": name, "status": status, "seconds": round((datetime.now(UTC) - started).total_seconds(), 3), "summary": summary}
        rows.append(row)
        marker["stages"] = [item for item in marker.get("stages", []) if item.get("name") != name] + [row]
        _write_under_root(root, marker_path, json.dumps(marker, indent=2, sort_keys=True) + "\n")
        if code:
            return {"ok": False, "stages": rows, "next": name}, code
    return {"ok": True, "stages": rows}, 0


def finish(root: Path) -> tuple[dict[str, Any], int]:
    root = validate_root(root, require_git=True)
    blockers: list[str] = []
    doctor_payload, doctor_code = doctor(root)
    if doctor_code:
        blockers.append(f"doctor drift (exit {doctor_code})")
    if (root / ".beads").exists() and shutil.which("bd"):
        try:
            open_rows = subprocess.run(["bd", "list", "--status", "open", "--json"], cwd=root, env=_bd_environment(root), capture_output=True, text=True, check=False)
            if open_rows.returncode == 0 and open_rows.stdout.strip():
                data = json.loads(open_rows.stdout)
                if isinstance(data, list) and data:
                    blockers.append("beads molecule has open children or gates")
        except (OSError, json.JSONDecodeError):
            blockers.append("unable to inspect beads molecule")
    status = subprocess.run(["git", "status", "--porcelain"], cwd=root, capture_output=True, text=True, check=False)
    meta = {}
    try:
        meta = json.loads(metadata_path(root).read_text())
    except (OSError, json.JSONDecodeError):
        pass
    owned = set(str(path) for path in meta.get("owned_hashes", {})) | {".omp/scaffold-answers.toml", ".omp/scaffold.json", ".omp/plugins.toml", "mise.toml"}
    try:
        recorded_layers = [str(item) for item in meta.get("layers", [])]
        recorded_values = meta.get("vars", {}) if isinstance(meta.get("vars", {}), dict) else {}
        generated_direct, generated_blocks = collect(recorded_layers, {str(k): str(v) for k, v in recorded_values.items()})
        owned |= set(generated_direct) | set(generated_blocks)
    except (OSError, KeyError, SystemExit):
        pass
    # Stage state files are rewritten by later stages (hooks, plugins) and never block finish; the
    # commit command stages them together with everything else.
    state_files = {".omp/scaffold.json", ".omp/scaffold-run.json"}
    dirty_owned = [line[3:].strip() for line in status.stdout.splitlines() if len(line) >= 4 and line[3:].strip().split(" -> ")[-1] in owned - state_files]
    if dirty_owned:
        blockers.append("scaffold-owned paths are uncommitted: " + ", ".join(sorted(dirty_owned)))
    only_uncommitted = bool(blockers) and all(b.startswith("scaffold-owned paths are uncommitted") for b in blockers)
    state = "finished" if not blockers else ("ready-for-commit" if only_uncommitted else "blocked")
    payload = {"ok": not blockers, "state": state, "commitCommand": "git add -A && git commit -m 'chore: scaffold project'", "blockers": blockers, "doctor": doctor_payload}
    if blockers:
        return payload, EXIT_DRIFT
    marker = root / ".omp/scaffold-run.json"
    if marker.exists():
        marker.unlink()
    return payload, 0


def abort(root: Path) -> tuple[dict[str, Any], int]:
    """Close a run without finishing it: drop the marker (which lifts the hard boundary) and report what it left behind."""
    root = validate_root(root, require_git=True)
    marker = root / ".omp/scaffold-run.json"
    run: dict[str, Any] = {}
    had_run = marker.exists()
    if had_run:
        try:
            loaded = json.loads(marker.read_text())
            run = loaded if isinstance(loaded, dict) else {}
        except (OSError, json.JSONDecodeError):
            run = {}
        marker.unlink()
    status = subprocess.run(["git", "status", "--porcelain"], cwd=root, capture_output=True, text=True, check=False)
    meta: dict[str, Any] = {}
    try:
        meta = json.loads(metadata_path(root).read_text())
    except (OSError, json.JSONDecodeError):
        pass
    owned = set(str(path) for path in meta.get("owned_hashes", {})) | {".omp/scaffold-answers.toml", ".omp/scaffold.json", ".omp/plugins.toml", "mise.toml"}
    dirty = [line[3:].strip().split(" -> ")[-1] for line in status.stdout.splitlines() if len(line) >= 4]
    stages = [row.get("name") for row in run.get("stages", []) if isinstance(row, dict)]
    return {"ok": True, "hadRun": had_run, "stagesCompleted": stages, "dirtyOwned": sorted(p for p in dirty if p in owned), "dirtyOther": sorted(p for p in dirty if p not in owned),
            "resetCommand": "git checkout -- . && git ls-files --others --exclude-standard -z | xargs -0 rm -rf"}, 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    profiles_parent = sub.add_parser("profiles"); profiles_parent.add_argument("--root", default="."); profiles = profiles_parent.add_subparsers(dest="profiles_command", required=True); profiles.add_parser("list")
    layers_parent = sub.add_parser("layers"); layers_parent.add_argument("--root", default="."); layers = layers_parent.add_subparsers(dest="layers_command", required=True); layers.add_parser("list"); show = layers.add_parser("show"); show.add_argument("layer")
    inspect_parser = sub.add_parser("inspect"); inspect_parser.add_argument("--root", default=".")
    preflight_parser = sub.add_parser("preflight"); preflight_parser.add_argument("--root", default="."); preflight_parser.add_argument("--profile"); preflight_parser.add_argument("--strict", action="store_true"); preflight_parser.add_argument("--allow-dirty", action="store_true")
    interview_parent = sub.add_parser("interview"); interview_parent.add_argument("--root", default="."); interview = interview_parent.add_subparsers(dest="interview_command", required=True).add_parser("questions"); interview.add_argument("--root", default=argparse.SUPPRESS); interview.add_argument("--profile")
    for action in ("plan", "render"):
        command = sub.add_parser(action); command.add_argument("--root", default="."); command.add_argument("--profile"); command.add_argument("--name"); command.add_argument("--var", action="append", default=[]); command.add_argument("--layer", action="append", default=[]); command.add_argument("--force-layer"); command.add_argument("--adopt", action="append", default=[])
        if action == "render": command.add_argument("--dry-run", action="store_true"); command.add_argument("--bump-tools", action="store_true")
    answers_parent = sub.add_parser("answers"); answers_parent.add_argument("--root", default="."); answers = answers_parent.add_subparsers(dest="answers_command", required=True).add_parser("write"); answers.add_argument("--root", default=argparse.SUPPRESS); answers.add_argument("--profile"); answers.add_argument("--name"); answers.add_argument("--var", action="append", default=[]); answers.add_argument("--set", action="append", default=[]); answers.add_argument("--layer", action="append", default=[]); answers.add_argument("--defaults-for", default="")
    apply_parser = sub.add_parser("apply"); apply_parser.add_argument("--root", default="."); apply_parser.add_argument("--profile"); apply_parser.add_argument("--dry-run", action="store_true"); apply_parser.add_argument("--stage"); apply_parser.add_argument("--allow-dirty", action="store_true"); apply_parser.add_argument("--bump-tools", action="store_true")
    finish_parser = sub.add_parser("finish"); finish_parser.add_argument("--root", default=".")
    abort_parser = sub.add_parser("abort"); abort_parser.add_argument("--root", default=".")
    member_parent = sub.add_parser("member"); member_parent.add_argument("--root", default="."); member = member_parent.add_subparsers(dest="member_command", required=True)
    member_list_parser = member.add_parser("list"); member_list_parser.add_argument("--root", default=argparse.SUPPRESS)
    member_add_parser = member.add_parser("add"); member_add_parser.add_argument("--root", default=argparse.SUPPRESS); member_add_parser.add_argument("--name", required=True); member_add_parser.add_argument("--layer", required=True); member_add_parser.add_argument("--kind", choices=("lib", "app", "service", "cli"), default="lib")
    member_remove_parser = member.add_parser("remove"); member_remove_parser.add_argument("--root", default=argparse.SUPPRESS); member_remove_parser.add_argument("--name", required=True)
    member_import_parser = member.add_parser("import"); member_import_parser.add_argument("--root", default=argparse.SUPPRESS); member_import_parser.add_argument("--dir", required=True); member_import_parser.add_argument("--layer", required=True); member_import_parser.add_argument("--kind", choices=("lib", "app", "service", "cli"), default="lib")
    doctor_parser = sub.add_parser("doctor"); doctor_parser.add_argument("--root", default=".")
    update_parser = sub.add_parser("update"); update_parser.add_argument("--root", default="."); update_parser.add_argument("--var", action="append", default=[]); update_parser.add_argument("--layer", action="append", default=[]); update_parser.add_argument("--force-layer"); update_parser.add_argument("--adopt", action="append", default=[]); update_parser.add_argument("--bump-tools", action="store_true")
    plugins_parent = sub.add_parser("plugins"); plugins_parent.add_argument("--root", default="."); plugins = plugins_parent.add_subparsers(dest="plugins_command", required=True).add_parser("sync"); plugins.add_argument("--root", default=argparse.SUPPRESS); plugins.add_argument("--check", action="store_true")
    hooks_parent = sub.add_parser("hooks"); hooks_parent.add_argument("--root", default="."); hooks = hooks_parent.add_subparsers(dest="hooks_command", required=True).add_parser("install"); hooks.add_argument("--root", default=argparse.SUPPRESS); hooks.add_argument("--migrate", action="store_true"); hooks.add_argument("--force", action="store_true")
    context_parent = sub.add_parser("context"); context_parent.add_argument("--root", default="."); context = context_parent.add_subparsers(dest="context_command", required=True).add_parser("refresh"); context.add_argument("--root", default=argparse.SUPPRESS)
    tools_parent = sub.add_parser("tools"); tools_parent.add_argument("--root", default="."); tools = tools_parent.add_subparsers(dest="tools_command", required=True).add_parser("install"); tools.add_argument("--root", default=argparse.SUPPRESS); tools.add_argument("--yes", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    command_root = resolved_root(Path(getattr(args, "root", Path.cwd())))
    if args.command == "profiles":
        emit(profiles_list(), command_root); return 0
    if args.command == "layers":
        payload = layers_list() if args.layers_command == "list" else layers_show(args.layer)
        emit(payload, command_root); return 0
    root = command_root
    if args.command == "inspect":
        emit(inspect(root), root); return 0
    if args.command == "preflight":
        payload, code = preflight(root, args.profile, strict=args.strict, allow_dirty=args.allow_dirty); emit(payload, root); return code
    if args.command == "interview":
        emit(interview_questions(root, args.profile), root); return 0
    if args.command in {"plan", "render"}:
        overrides = parse_vars(args.var)
        if args.command == "plan":
            payload, _, _, _, code = plan_payload(root, args.profile, args.name, overrides, args.layer, args.force_layer, set(args.adopt))
        else:
            validate_root(root, require_git=True)
            payload, code = render(root, args.profile, args.name, overrides, args.layer, args.force_layer, set(args.adopt), args.dry_run, bump_tools=args.bump_tools)
        emit(payload, root); return code
    if args.command == "answers":
        validate_root(root, require_git=True)
        sets = parse_vars(args.set); overrides = parse_vars(args.var); overrides.update(sets)
        defaults_for = [item for item in args.defaults_for.split(",") if item]
        payload, code = answers_write_interview(root, args.profile, args.name, overrides, defaults_for, args.layer)
        emit(payload, root); return code
    if args.command == "apply":
        payload, code = apply_pipeline(root, args.profile, dry_run=args.dry_run, stage=args.stage, allow_dirty=args.allow_dirty, bump_tools=args.bump_tools); emit(payload, root); return code
    if args.command == "finish":
        payload, code = finish(root); emit(payload, root); return code
    if args.command == "abort":
        payload, code = abort(root); emit(payload, root); return code
    if args.command == "member":
        if args.member_command == "list":
            emit(member_list(root), root); return 0
        validate_root(root, require_git=True)
        if args.member_command == "add": payload, code = member_add(root, args.name, args.layer, args.kind), 0
        elif args.member_command == "remove": payload, code = member_remove(root, args.name), 0
        else: payload, code = member_import(root, args.dir, args.layer, args.kind), 0
        emit(payload, root); return code
    if args.command == "doctor":
        payload, code = doctor(root); emit(payload, root); return code
    if args.command == "update":
        validate_root(root, require_git=True)
        payload, code = update(root, parse_vars(args.var), args.layer, args.force_layer, set(args.adopt), args.bump_tools); emit(payload, root); return code
    if args.command == "plugins":
        if not args.check: validate_root(root, require_git=True)
        payload, code = plugins_sync(root, args.check); emit(payload, root); return code
    if args.command == "hooks":
        validate_root(root, require_git=True)
        payload, code = hooks_install(root, args.migrate, args.force); emit(payload, root); return code
    if args.command == "context":
        validate_root(root, require_git=True)
        payload, code = context_refresh(root); emit(payload, root); return code
    if args.command == "tools":
        validate_root(root, require_git=True)
        payload, code = tools_install(root, args.yes); emit(payload, root); return code
    return EXIT_DRIFT


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, subprocess.SubprocessError, tomllib.TOMLDecodeError, ValueError, KeyError) as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        raise SystemExit(EXIT_ERROR)
