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


def answers_path(root: Path) -> Path:
    return root / ".omp" / "scaffold-answers.toml"


def read_answers(root: Path) -> dict[str, Any]:
    path = answers_path(root)
    return load_toml(path) if path.is_file() else {}


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
    lines.append("")
    lines.append("[vars]")
    reserved = {"name", "package", "package_kebab", "description", "profile"}
    for key in sorted(values):
        if key not in reserved:
            lines.append(f"{key} = {toml_value(values[key])}")
    for key in ("name", "description"):
        if key in values:
            lines.append(f"{key} = {toml_value(values[key])}")
    if extra:
        lines.append("")
        for key, value in extra.items():
            lines.append(f"{key} = {toml_value(value)}")
    path.write_text("\n".join(lines) + "\n")


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


def collect(layers: list[str], values: dict[str, str]) -> tuple[dict[str, list[dict[str, Any]]], dict[str, list[dict[str, Any]]]]:
    direct: dict[str, list[dict[str, Any]]] = {}
    blocks: dict[str, list[dict[str, Any]]] = {}
    for layer in layers:
        directory = layer_dir(layer)
        config = load_layer(layer)
        tools = config.get("tools", {})
        if isinstance(tools, dict) and tools:
            lines = ["[tools]"]
            for key, value in tools.items():
                resolved = render_text(str(value), values)
                lines.append(f"{key} = {toml_value(resolved)}")
            blocks.setdefault("mise.toml", []).append({"layer": layer, "source": str(directory / "layer.toml"), "target": "mise.toml", "body": "\n".join(lines) + "\n"})
        for source in sorted(directory.rglob("*")):
            if not source.is_file() or source.name in {"layer.toml", "README.md", ".DS_Store", "mise.toml.tmpl"}:
                continue
            relative = source.relative_to(directory)
            if relative.name == "LICENSE" and str(values.get("license", "")).lower() not in {"", "apache-2.0", "apache 2.0"}:
                continue
            if relative.name.endswith(".block"):
                target = target_path(Path(str(relative)[:-6]), values)
                body = render_text(source.read_text(), values)
                blocks.setdefault(str(target), []).append({"layer": layer, "source": str(source), "target": str(target), "body": body})
            else:
                target = target_path(relative, values)
                data = source.read_text()
                if source.suffix == ".tmpl":
                    data = render_text(data, values)
                direct.setdefault(str(target), []).append({"layer": layer, "source": str(source), "target": str(target), "data": data})
    return direct, blocks


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
            for layer in dict.fromkeys(item["layer"] for item in fragments):
                if marker_state(text, layer, Path(path)) == "broken":
                    row_class = "conflict"
                    conflicts.append({"path": path, "layer": layer, "reason": "managed markers damaged or duplicated"})
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
    payload = {"profile": profile_name, "layers": layers, "root": str(root), "files": rows, "conflicts": conflicts, "vars": values}
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
        path.write_text(content)
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
    if not old_tools and new_tools:
        body = generated.rstrip("\n")
    else:
        assignments = "\n".join(f"{key} = {toml_value(value)}" for key, value in missing.items())
        body = assignments or "# no new tool keys"
    if state == "ok":
        start, finish = existing.index(begin), existing.index(end) + len(end)
        return existing[:start] + begin + "\n" + body + "\n" + end + existing[finish:]
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


def render(root: Path, profile_name: str | None, name: str | None, overrides: dict[str, str], extra_layers: list[str], force_layer: str | None = None, adopts: set[str] | None = None, dry_run: bool = False, preserve_paths: set[str] | None = None) -> tuple[dict[str, Any], int]:
    adopts = adopts or set()
    preserve_paths = preserve_paths or set()
    plan, profile, layers, values, code = plan_payload(root, profile_name, name, overrides, extra_layers, force_layer, adopts)
    if dry_run or code == EXIT_CONFLICT:
        return plan, code
    direct, blocks = collect(layers, values)
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
            target.rename(backup)
        selected = owners[-1] if force_layer is None else next((item for item in owners if item["layer"] == force_layer), owners[-1])
        if path in preserve_paths and target.exists():
            drifted.append(path)
            skipped.append(path)
            continue
        if target.exists() and path == ".omp/mcp.json":
            merged, additions = merge_json(target.read_text(), selected["data"])
            if merged != target.read_text():
                target.write_text(merged)
                written.append(path)
            else:
                skipped.append(path)
            continue
        if target.exists():
            skipped.append(path)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(selected["data"])
        written.append(path)
    for path, fragments in sorted(blocks.items()):
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        current = target.read_text() if target.exists() else ""
        for layer in dict.fromkeys(item["layer"] for item in fragments):
            body = "\n".join(item["body"].rstrip("\n") for item in fragments if item["layer"] == layer)
            try:
                if target.name == "mise.toml":
                    current = merge_tools_block(current, body, layer, Path(path))
                else:
                    current = replace_block(current, body, layer, Path(path))
            except ValueError as exc:
                return {**plan, "error": str(exc)}, EXIT_CONFLICT
        if current != (target.read_text() if target.exists() else ""):
            target.write_text(current)
            written.append(path)
        else:
            skipped.append(path)
    additions = write_plugins(root, plugin_sets(layers, values))
    root_meta = metadata_path(root)
    root_meta.parent.mkdir(parents=True, exist_ok=True)
    owned_hashes = {path: file_hash(root / path) for path in direct if (root / path).is_file()}
    root_meta.write_text(json.dumps({"profile": profile_name, "layers": layers, "vars": values, "owned_hashes": owned_hashes, "plugin_version": read_answers(root).get("plugin_version", "")}, indent=2, sort_keys=True) + "\n")
    write_answers(root, profile_name or "", layers, values)
    return {**plan, "written": written, "skipped": skipped, "drifted": drifted, "plugin_additions": additions}, 0


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
    metadata_path(root).write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n")


def _global_hooks_path(root: Path) -> tuple[str, str]:
    try:
        local = subprocess.run(["git", "config", "--local", "--get", "core.hooksPath"], cwd=root, capture_output=True, text=True, check=False)
    except OSError:
        local = None
    if local is not None and local.returncode == 0 and local.stdout.strip():
        return "", ""
    for scope in ("global", "system"):
        try:
            result = subprocess.run(["git", "config", f"--{scope}", "--get", "core.hooksPath"], cwd=root, capture_output=True, text=True, check=False)
        except OSError:
            continue
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip(), scope
    return "", ""


def _git_defender_hook_report() -> dict[str, Any]:
    return {"strategy": "git-defender", "stages": {"pre-commit": "chained", "pre-push": "git shim (container runs prek --stage pre-push)", "commit-msg": "not run", "post-commit|post-checkout|post-merge": "not run — use `just context`"}}


def hooks_install(root: Path, migrate: bool = False, force: bool = False) -> tuple[dict[str, Any], int]:
    config = root / ".pre-commit-config.yaml"
    if not config.is_file():
        return {"error": "no .pre-commit-config.yaml"}, EXIT_ERROR
    stages = declared_hook_stages(config.read_text())
    hooks_path, hooks_scope = _global_hooks_path(root)
    if hooks_path and shutil.which("git-defender"):
        command = [str(shutil.which("git-defender")), "precommit-tool-setup"]
        run = subprocess.run(command, cwd=root, capture_output=True, text=True, check=False)
        report = _git_defender_hook_report()
        if run.returncode == 0:
            _save_hook_meta(root, {"hooks_installed": True, "hook_stages": ["pre-commit", "pre-push"], "declared_hook_stages": stages, "hook_install_status": "installed", "hook_strategy": "git-defender", "hook_stage_report": report})
        return {"command": command, "declared": stages, "installed": ["pre-commit", "pre-push"] if run.returncode == 0 else [], "strategy": report["strategy"], "stages": report["stages"], "stdout": run.stdout, "stderr": run.stderr, "hooksPath": hooks_path, "hooksPathScope": hooks_scope}, run.returncode
    if hooks_path and not force:
        finding = {"kind": "hook-manager", "path": "core.hooksPath", "value": hooks_path, "options": ["run prek install --force into the repository hooks directory", "move core.hooksPath to repository scope", "skip hooks"]}
        _save_hook_meta(root, {"hook_install_status": "refused", "hook_manager": finding, "declared_hook_stages": stages})
        return {"finding": finding, "declared": stages, "installed": [], "error": "global core.hooksPath is configured"}, EXIT_DRIFT
    command = ["prek", "install"]
    if force:
        command.append("--force")
    command += sum((["--hook-type", stage] for stage in stages), [])
    if migrate:
        command.append("--migrate")
    run = subprocess.run(command, cwd=root, capture_output=True, text=True, check=False)
    report = {"strategy": "prek", "stages": {stage: "prek" for stage in stages}}
    if run.returncode == 0:
        _save_hook_meta(root, {"hooks_installed": True, "hook_stages": stages, "declared_hook_stages": stages, "hook_install_status": "installed", "hook_strategy": "prek", "hook_stage_report": report})
    return {"command": command, "declared": stages, "installed": stages if run.returncode == 0 else [], "strategy": report["strategy"], "stages": report["stages"], "stdout": run.stdout, "stderr": run.stderr}, run.returncode
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
            if isinstance(values, list) and any(isinstance(item, dict) and item.get("scope") == "project" for item in values):
                found.add((plugin, marketplace))
    return found
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




def tools_install(root: Path, yes: bool) -> tuple[dict[str, Any], int]:
    if not yes:
        return {"error": "refusing tool installation without --yes"}, EXIT_ERROR
    commands = [["mise", "install"]]
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
    run = subprocess.run([sys.executable, str(script), "refresh"], cwd=root, capture_output=True, text=True, check=False)
    return {"stdout": run.stdout, "stderr": run.stderr}, run.returncode


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
    if not answers_path(root).is_file():
        drift.append("answers file missing")
    for layer in layers:
        for tool in load_layer(layer).get("requires_tools", []):
            if shutil.which(str(tool)) is None:
                drift.append(f"missing tool:{tool}")
    config_path = root / ".pre-commit-config.yaml"
    declared_hooks = declared_hook_stages(config_path.read_text()) if config_path.is_file() else []
    hook_strategy = str(meta.get("hook_strategy", "prek"))
    hook_report = meta.get("hook_stage_report")
    if hook_strategy == "git-defender":
        installed_hooks = ["pre-commit", "pre-push"] if meta.get("hooks_installed") else []
        hook_status = "installed" if meta.get("hooks_installed") else "not-installed"
    else:
        installed_hooks = [str(item) for item in meta.get("hook_stages", [])] if meta.get("hooks_installed") else []
        hook_status = "installed" if declared_hooks and set(declared_hooks) <= set(installed_hooks) else ("not-installed" if declared_hooks else "not-declared")
        hook_report = hook_report if isinstance(hook_report, dict) else {"strategy": hook_strategy, "stages": {stage: hook_strategy for stage in installed_hooks}}
    if meta.get("hook_install_status") == "refused":
        drift.append("hook-manager refusal requires resolution")
        hook_status = "refused"
    if meta.get("hooks_installed") and hook_strategy != "git-defender":
        for stage in declared_hooks:
            if stage not in installed_hooks:
                drift.append(f"hook stage missing:{stage}")
            elif (root / ".git/hooks" / stage).parent.exists() and not (root / ".git/hooks" / stage).exists():
                drift.append(f"hook missing:{stage}")
    plugin_result, plugin_code = plugins_sync(root, True)
    if plugin_code == EXIT_DRIFT:
        drift.extend(str(item) for item in plugin_result.get("drift", []))
    elif plugin_code:
        errors.append(str(plugin_result.get("error", "plugin check failed")))
    if "agentic" in layers:
        context = root / ".omp/project-context.json"
        if context.is_file():
            try:
                data = json.loads(context.read_text())
                if data.get("status") not in (None, "CURRENT"):
                    drift.append("context status is not CURRENT")
            except json.JSONDecodeError:
                drift.append("project-context.json invalid")
        else:
            drift.append("project-context.json missing")
    direct, blocks = collect(layers, values)
    for path, fragments in blocks.items():
        target = root / path
        if not target.is_file():
            drift.append(f"managed file missing:{path}")
            continue
        text = target.read_text()
        for layer in dict.fromkeys(item["layer"] for item in fragments):
            if marker_state(text, layer, Path(path)) != "ok":
                drift.append(f"managed markers damaged:{path}:{layer}")
    payload = {"profile": profile_name, "layers": layers, "checks": {"answers": answers_path(root).is_file(), "tools": True, "plugins": plugin_result, "hooks": {"declared": declared_hooks, "installed": installed_hooks, "status": hook_status, "strategy": hook_strategy, "stages": hook_report.get("stages", {}) if isinstance(hook_report, dict) else {}}, "context": "CURRENT" if "agentic" in layers else "not-applicable", "markers": True}, "drift": sorted(set(drift)), "errors": errors}
    return payload, EXIT_ERROR if errors else (EXIT_DRIFT if drift else 0)


def update(root: Path, overrides: dict[str, str], extra_layers: list[str], force_layer: str | None, adopts: set[str]) -> tuple[dict[str, Any], int]:
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
    for path in direct:
        target = root / path
        if target.is_file() and path in known and file_hash(target) != str(known[path]):
            preserve.add(path)
            drifted.append(path)
    payload, code = render(root, profile, None, overrides, extra_layers, force_layer, adopts, False, preserve)
    if drifted and metadata_path(root).is_file():
        try:
            updated_meta = json.loads(metadata_path(root).read_text())
            hashes = updated_meta.setdefault("owned_hashes", {})
            for path in drifted:
                if path in known:
                    hashes[path] = known[path]
            metadata_path(root).write_text(json.dumps(updated_meta, indent=2, sort_keys=True) + "\n")
        except (OSError, json.JSONDecodeError):
            pass
    payload["drifted"] = sorted(set(drifted))
    return payload, code


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    profiles = sub.add_parser("profiles").add_subparsers(dest="profiles_command", required=True)
    profiles.add_parser("list")
    layers = sub.add_parser("layers").add_subparsers(dest="layers_command", required=True)
    layers.add_parser("list")
    show = layers.add_parser("show"); show.add_argument("layer")
    inspect_parser = sub.add_parser("inspect"); inspect_parser.add_argument("--root", default=".")
    for action in ("plan", "render"):
        command = sub.add_parser(action)
        command.add_argument("--root", default=".")
        command.add_argument("--profile")
        command.add_argument("--name")
        command.add_argument("--var", action="append", default=[])
        command.add_argument("--layer", action="append", default=[])
        command.add_argument("--force-layer")
        command.add_argument("--adopt", action="append", default=[])
        if action == "render": command.add_argument("--dry-run", action="store_true")
    answers = sub.add_parser("answers").add_subparsers(dest="answers_command", required=True).add_parser("write")
    answers.add_argument("--root", default="."); answers.add_argument("--profile"); answers.add_argument("--name"); answers.add_argument("--var", action="append", default=[]); answers.add_argument("--layer", action="append", default=[]); answers.add_argument("--set", action="append", default=[])
    doctor_parser = sub.add_parser("doctor"); doctor_parser.add_argument("--root", default=".")
    update_parser = sub.add_parser("update"); update_parser.add_argument("--root", default="."); update_parser.add_argument("--var", action="append", default=[]); update_parser.add_argument("--layer", action="append", default=[]); update_parser.add_argument("--force-layer"); update_parser.add_argument("--adopt", action="append", default=[])
    plugins = sub.add_parser("plugins").add_subparsers(dest="plugins_command", required=True).add_parser("sync"); plugins.add_argument("--root", default="."); plugins.add_argument("--check", action="store_true")
    hooks = sub.add_parser("hooks").add_subparsers(dest="hooks_command", required=True).add_parser("install"); hooks.add_argument("--root", default="."); hooks.add_argument("--migrate", action="store_true"); hooks.add_argument("--force", action="store_true")
    context = sub.add_parser("context").add_subparsers(dest="context_command", required=True).add_parser("refresh"); context.add_argument("--root", default=".")
    tools = sub.add_parser("tools").add_subparsers(dest="tools_command", required=True).add_parser("install"); tools.add_argument("--root", default="."); tools.add_argument("--yes", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "profiles": print(json.dumps(profiles_list(), indent=2, sort_keys=True)); return 0
    if args.command == "layers":
        payload = layers_list() if args.layers_command == "list" else layers_show(args.layer)
        print(json.dumps(payload, indent=2, sort_keys=True)); return 0
    root = Path(args.root).expanduser().resolve() if hasattr(args, "root") else Path(".").resolve()
    if args.command == "inspect": print(json.dumps(inspect(root), indent=2, sort_keys=True)); return 0
    if args.command in {"plan", "render"}:
        overrides = parse_vars(args.var)
        if args.command == "plan": payload, _, _, _, code = plan_payload(root, args.profile, args.name, overrides, args.layer, args.force_layer, set(args.adopt))
        else: payload, code = render(root, args.profile, args.name, overrides, args.layer, args.force_layer, set(args.adopt), args.dry_run)
        print(json.dumps(payload, indent=2, sort_keys=True)); return code
    if args.command == "answers":
        sets = parse_vars(args.set)
        overrides = parse_vars(args.var); overrides.update(sets)
        profile, _, layers, values = resolve_selection(root, args.profile, args.name, overrides, args.layer)
        write_answers(root, profile, layers, values)
        print(json.dumps({"path": str(answers_path(root)), "profile": profile, "layers": layers, "vars": values}, indent=2, sort_keys=True)); return 0
    if args.command == "doctor": payload, code = doctor(root); print(json.dumps(payload, indent=2, sort_keys=True)); return code
    if args.command == "update": payload, code = update(root, parse_vars(args.var), args.layer, args.force_layer, set(args.adopt)); print(json.dumps(payload, indent=2, sort_keys=True)); return code
    if args.command == "plugins": payload, code = plugins_sync(root, args.check); print(json.dumps(payload, indent=2, sort_keys=True)); return code
    if args.command == "hooks": payload, code = hooks_install(root, args.migrate, args.force); print(json.dumps(payload, indent=2, sort_keys=True)); return code
    if args.command == "context": payload, code = context_refresh(root); print(json.dumps(payload, indent=2, sort_keys=True)); return code
    if args.command == "tools": payload, code = tools_install(root, args.yes); print(json.dumps(payload, indent=2, sort_keys=True)); return code
    return 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, subprocess.SubprocessError, tomllib.TOMLDecodeError, ValueError, KeyError) as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        raise SystemExit(EXIT_ERROR)
