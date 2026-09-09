#!/usr/bin/env python3
"""Deterministic project scaffolding from plain template layers.

The command intentionally has no prompts and uses only the Python standard library.  A
profile chooses an ordered set of template directories; each directory may be supplied by
another plugin checkout as long as it follows the layer contract.
"""
from __future__ import annotations

import argparse
import json
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
MARKER_HTML = "<!-- agentic-scaffold:{kind} {block} -->"
MARKER_HASH = "# agentic-scaffold:{kind} {block}"
EXIT_CONFLICT = 5

WEB_UI_PLUGINS = {
    "srobroek-omp": {
        "source": "srobroek/omp-plugins",
        "plugins": [
            "browser-tools", "design", "diagram", "styleseed", "ui-skills",
            "platform-design-skills", "web-quality-skills", "ui-ux-pro-max",
            "modern-web-guidance", "effective-html", "frontend-slides",
            "web-asset-generator",
        ],
    },
    "impeccable": {"source": "pbakaus/impeccable", "plugins": ["impeccable"]},
    "interface-design": {"source": "Dammyjay93/interface-design", "plugins": ["interface-design"]},
}


def fail(message: str, code: int = 1) -> None:
    print(json.dumps({"error": message}), file=sys.stderr)
    raise SystemExit(code)


def load_profile(name: str) -> dict[str, Any]:
    path = PROFILES / f"{name}.toml"
    if not path.is_file():
        fail(f"unknown profile: {name}", 2)
    with path.open("rb") as stream:
        profile = tomllib.load(stream)
    if not isinstance(profile.get("layers"), list):
        fail(f"profile {name} must declare layers", 2)
    profile["_path"] = str(path)
    return profile


def profile_plugins(profile: dict[str, Any], variables: dict[str, str]) -> dict[str, dict[str, Any]]:
    raw = profile.get("plugins", {})
    result: dict[str, dict[str, Any]] = {}
    if isinstance(raw, dict):
        for marketplace, value in raw.items():
            if not isinstance(value, dict):
                continue
            result[str(marketplace)] = {
                "source": str(value.get("source", marketplace)),
                "plugins": [str(item) for item in value.get("plugins", [])],
            }
    truthy = {"1", "true", "yes", "on"}
    if str(variables.get("web_ui", "")).lower() in truthy:
        for marketplace, value in WEB_UI_PLUGINS.items():
            result.setdefault(marketplace, {"source": value["source"], "plugins": []})
            result[marketplace]["source"] = value["source"]
            result[marketplace]["plugins"] = list(dict.fromkeys(result[marketplace]["plugins"] + value["plugins"]))
    if str(variables.get("speckit", "")).lower() in truthy:
        entry = result.setdefault("srobroek-omp", {"source": "srobroek/omp-plugins", "plugins": []})
        entry["plugins"] = list(dict.fromkeys(entry["plugins"] + ["speckit"]))
    return result


def package_vars(profile: dict[str, Any], name: str | None, overrides: dict[str, str]) -> dict[str, str]:
    defaults = profile.get("vars", {})
    values = {str(k): str(v) for k, v in defaults.items()} if isinstance(defaults, dict) else {}
    values.update(overrides)
    actual_name = name or values.get("name") or profile.get("name") or "project"
    actual_name = str(actual_name)
    package = re.sub(r"[^A-Za-z0-9]+", "_", actual_name).strip("_").lower() or "project"
    package_kebab = re.sub(r"[^A-Za-z0-9]+", "-", actual_name).strip("-").lower() or "project"
    values.update({
        "name": actual_name,
        "package": package,
        "package_kebab": package_kebab,
        "description": values.get("description", str(profile.get("summary", ""))),
        "python": values.get("python", values.get("python_version", "3.13")),
        "node": values.get("node", values.get("node_version", "22")),
        "bun_version": values.get("bun_version", values.get("bun", "latest")),
        "year": values.get("year", str(datetime.now(UTC).year)),
        "author": values.get("author", ""),
        "license": values.get("license", ""),
        "profile": str(profile.get("name", "")),
    })
    commands = profile.get("commands", {})
    if isinstance(commands, dict):
        for key in ("setup", "test", "lint", "fmt", "check"):
            values[f"commands_{key}"] = str(commands.get(key, ""))
    return values


def render_text(text: str, values: dict[str, str]) -> str:
    return Template(text).substitute(values)


def layer_dir(layer: str) -> Path:
    path = TEMPLATES / layer
    if not path.is_dir():
        fail(f"layer does not exist: {layer}", 2)
    return path


def target_path(relative: Path, values: dict[str, str]) -> Path:
    parts = []
    for part in relative.parts:
        part = part.replace("__name__", values["name"])
        part = part.removesuffix(".tmpl")
        parts.append(render_text(part, values))
    return Path(*parts)


def is_fragment(path: Path) -> bool:
    return path.name.endswith(".block")


def fragment_target(relative: Path, values: dict[str, str]) -> tuple[Path, str]:
    target = Path(*relative.parts)
    target = Path(str(target)[:-6])  # .block
    block = target.parent.name if target.parent != Path(".") else "default"
    # A block fragment's basename identifies the managed target; layer supplies the block.
    # Target files are named <target>.block, so the block name is supplied by the caller.
    return target_path(target, values), block


def marker(block: str, target: Path, kind: str) -> str:
    return MARKER_HASH.format(kind=kind, block=block) if target.suffix in {".yaml", ".yml", ".toml", ".gitignore", ""} else MARKER_HTML.format(kind=kind, block=block)


def marker_pair(block: str, target: Path) -> tuple[str, str]:
    # HTML markers are the documented format for prose and gitignore/justfile files. YAML
    # and TOML use comments so generated configs remain parseable.
    if target.suffix in {".yaml", ".yml", ".toml"}:
        return MARKER_HASH.format(kind="begin", block=block), MARKER_HASH.format(kind="end", block=block)
    return MARKER_HTML.format(kind="begin", block=block), MARKER_HTML.format(kind="end", block=block)


def replace_block(existing: str, block: str, body: str, target: Path) -> str:
    begin, end = marker_pair(block, target)
    start = existing.find(begin)
    finish = existing.find(end)
    if start >= 0 and finish >= 0:
        if finish < start:
            raise ValueError(f"reversed managed markers in {target}")
        finish += len(end)
        replacement = begin + "\n" + body.rstrip("\n") + "\n" + end
        return existing[:start] + replacement + existing[finish:]
    if start >= 0 or finish >= 0:
        raise ValueError(f"ambiguous managed markers in {target}")
    if existing and not existing.endswith("\n"):
        existing += "\n"
    return existing + begin + "\n" + body.rstrip("\n") + "\n" + end + "\n"


def collect(profile: dict[str, Any], values: dict[str, str]) -> tuple[dict[str, list[dict[str, Any]]], dict[str, list[dict[str, Any]]]]:
    direct: dict[str, list[dict[str, Any]]] = {}
    blocks: dict[str, list[dict[str, Any]]] = {}
    for layer in profile["layers"]:
        directory = layer_dir(str(layer))
        for source in sorted(directory.rglob("*")):
            if not source.is_file() or source.name.startswith(".") and source.name == ".DS_Store":
                continue
            relative = source.relative_to(directory)
            if str(relative) == "LICENSE" and str(values.get("license", "")).lower() != "apache-2.0":
                continue
            if is_fragment(relative):
                target = Path(str(relative)[:-6])
                target = target_path(target, values)
                data = render_text(source.read_text(), values)
                item = {"layer": str(layer), "source": str(source), "target": str(target), "body": data}
                blocks.setdefault(str(target), []).append(item)
            else:
                target = target_path(relative, values)
                data = source.read_text()
                if source.suffix == ".tmpl":
                    data = render_text(data, values)
                item = {"layer": str(layer), "source": str(source), "target": str(target), "data": data}
                direct.setdefault(str(target), []).append(item)
    return direct, blocks


def classify(root: Path, profile: dict[str, Any], values: dict[str, str], force_layer: str | None = None) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    direct, blocks = collect(profile, values)
    rows: list[dict[str, Any]] = []
    conflicts: list[dict[str, Any]] = []
    for path, owners in sorted(direct.items()):
        owner_names = [item["layer"] for item in owners]
        if len(owners) > 1:
            row_class = "create" if force_layer and force_layer in owner_names else "conflict"
            if row_class == "conflict":
                conflicts.append({"path": path, "owners": owner_names})
        else:
            row_class = "create" if not (root / path).exists() else "skip"
        rows.append({"path": path, "layer": owner_names[0] if len(owner_names) == 1 else owner_names, "class": row_class})
    for path, fragments in sorted(blocks.items()):
        owners = [item["layer"] for item in fragments]
        target = root / path
        if not target.exists():
            row_class = "create"
        else:
            text = target.read_text()
            row_class = "update-block"
            for layer in dict.fromkeys(owners):
                begin, end = marker_pair(layer, Path(path))
                if begin not in text or end not in text:
                    row_class = "conflict"
                    break
        if row_class == "conflict":
            conflicts.append({"path": path, "owners": owners})
        rows.append({"path": path, "layer": owners, "class": row_class})
    return rows, conflicts


def run_plan(root: Path, profile_name: str, name: str | None, overrides: dict[str, str], force_layer: str | None = None) -> tuple[dict[str, Any], dict[str, Any], int]:
    profile = load_profile(profile_name)
    values = package_vars(profile, name, overrides)
    rows, conflicts = classify(root, profile, values, force_layer)
    return {"profile": profile_name, "root": str(root), "files": rows, "conflicts": conflicts}, profile, EXIT_CONFLICT if conflicts else 0


def write_plugins(root: Path, plugins: dict[str, dict[str, Any]]) -> None:
    path = root / ".omp" / "plugins.toml"
    path.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    for marketplace, value in plugins.items():
        lines.extend(["[[marketplaces]]", f'name = {json.dumps(marketplace)}', f'source = {json.dumps(value["source"])}', "plugins = [" + ", ".join(json.dumps(p) for p in value["plugins"]) + "]", ""])
    content = "\n".join(lines)
    if content and not content.endswith("\n"):
        content += "\n"
    if not path.exists() or path.read_text() != content:
        path.write_text(content)


def render(root: Path, profile_name: str, name: str | None, overrides: dict[str, str], force_layer: str | None = None) -> tuple[dict[str, Any], int]:
    plan, profile, code = run_plan(root, profile_name, name, overrides, force_layer)
    if code == EXIT_CONFLICT:
        return plan, code
    values = package_vars(profile, name, overrides)
    direct, blocks = collect(profile, values)
    written: list[str] = []
    skipped: list[str] = []
    for path, owners in sorted(direct.items()):
        selected = owners[-1] if force_layer is None else next((item for item in owners if item["layer"] == force_layer), owners[-1])
        target = root / path
        if target.exists():
            if path == ".omp/mcp.json":
                try:
                    existing_mcp = json.loads(target.read_text())
                    generated_mcp = json.loads(selected["data"])
                    existing_servers = existing_mcp.setdefault("mcpServers", {})
                    for server_name, server in generated_mcp.get("mcpServers", {}).items():
                        existing_servers.setdefault(server_name, server)
                    merged = json.dumps(existing_mcp, indent=2) + "\n"
                    if merged != target.read_text():
                        target.write_text(merged)
                        written.append(path)
                    else:
                        skipped.append(path)
                except (json.JSONDecodeError, TypeError):
                    skipped.append(path)
            else:
                skipped.append(path)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(selected["data"])
        written.append(path)
    for path, fragments in sorted(blocks.items()):
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        existing = target.read_text() if target.exists() else ""
        current = existing
        for layer in dict.fromkeys(item["layer"] for item in fragments):
            body = "\n".join(item["body"].rstrip("\n") for item in fragments if item["layer"] == layer)
            try:
                current = replace_block(current, layer, body, Path(path))
            except ValueError:
                return {**plan, "error": f"managed markers conflict in {path}"}, EXIT_CONFLICT
        if current != existing:
            target.write_text(current)
            written.append(path)
        else:
            skipped.append(path)
    write_plugins(root, profile_plugins(profile, values))
    # Record the profile for commands invoked after the render without affecting user files.
    metadata = root / ".omp" / "scaffold.json"
    metadata.parent.mkdir(parents=True, exist_ok=True)
    metadata.write_text(json.dumps({"profile": profile_name, "vars": values}, indent=2, sort_keys=True) + "\n")
    return {**plan, "written": written, "skipped": skipped}, 0


def parse_vars(raw: list[str]) -> dict[str, str]:
    values: dict[str, str] = {}
    for item in raw:
        if "=" not in item:
            fail(f"--var requires key=value: {item}", 2)
        key, value = item.split("=", 1)
        values[key] = value
    return values


def inspect(root: Path) -> dict[str, Any]:
    stacks: list[str] = []
    checks = [("python", ("pyproject.toml", "uv.lock")), ("typescript", ("package.json", "bun.lock")), ("rust", ("Cargo.toml",)), ("go", ("go.mod",))]
    for stack, files in checks:
        if any((root / item).exists() for item in files):
            stacks.append(stack)
    if any(root.glob("*.tf")):
        stacks.append("terraform")
    tools = {name: shutil.which(name) is not None for name in ("uv", "bun", "mise", "prek", "just", "gh", "bd", "omp")}
    hook_files = [str(p.relative_to(root)) for p in (root / ".pre-commit-config.yaml", root / "prek.toml") if p.exists()]
    return {"root": str(root), "git": (root / ".git").exists(), "stacks": stacks, "tooling": {"mise": (root / "mise.toml").exists(), "just": (root / "justfile").exists(), "prek": bool(hook_files), "omp": (root / ".omp").exists(), "agents": (root / "AGENTS.md").exists(), "beads": (root / ".beads").exists()}, "hook_manager_conflicts": hook_files if len(hook_files) > 1 else [], "missing_tools": [name for name, found in tools.items() if not found], "tools": tools, "suggested_profile": "agentic-repo" if not stacks else f"{stacks[0]}-lib"}


def read_plugins(root: Path) -> list[dict[str, Any]]:
    path = root / ".omp/plugins.toml"
    if not path.is_file():
        return []
    with path.open("rb") as stream:
        data = tomllib.load(stream)
    return [dict(item) if item.get("name") else {**item, "name": str(item.get("source", ""))} for item in data.get("marketplaces", []) if isinstance(item, dict)] if isinstance(data.get("marketplaces"), list) else []


def marketplace_items(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [x for x in payload if isinstance(x, dict)]
    if isinstance(payload, dict):
        for key in ("marketplaces", "items", "results"):
            if isinstance(payload.get(key), list):
                return [x for x in payload[key] if isinstance(x, dict)]
    return []


def marketplace_text_items(text: str) -> list[dict[str, Any]]:
    """Parse the table printed by omp versions that ignore ``--json``."""
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
    """Read OMP v2 registry entries keyed by ``plugin@marketplace``."""
    if not path.is_file():
        return set()
    try:
        payload = json.loads(path.read_text())
    except json.JSONDecodeError:
        return set()
    found: set[tuple[str, str]] = set()
    plugins = payload.get("plugins", {}) if isinstance(payload, dict) else {}
    if isinstance(plugins, dict):
        for identifier, entries in plugins.items():
            if not isinstance(identifier, str) or "@" not in identifier:
                continue
            plugin, marketplace = identifier.split("@", 1)
            if isinstance(entries, list) and any(isinstance(item, dict) and item.get("scope") == "project" for item in entries):
                found.add((plugin, marketplace))
    return found


def plugins_sync(root: Path, check: bool) -> tuple[dict[str, Any], int]:
    desired = read_plugins(root)
    if not desired:
        return {"desired": [], "drift": []}, 0
    result = subprocess.run(["omp", "plugin", "marketplace", "list", "--json"], cwd=root, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        return {"error": result.stderr.strip() or "omp marketplace list failed"}, 1
    try:
        available = marketplace_items(json.loads(result.stdout))
    except json.JSONDecodeError:
        available = marketplace_text_items(result.stdout)
    if not available and result.stdout.strip() and "Configured Marketplaces:" not in result.stdout:
        return {"error": "omp marketplace list returned invalid JSON"}, 1
    names = {str(item.get("name", item.get("id", ""))) for item in available}
    sources = {str(item.get("source", "")) for item in available}
    installed = installed_plugins(root / ".omp/plugins/installed_plugins.json")
    drift: list[str] = []
    for marketplace in desired:
        name = str(marketplace["name"])
        source = str(marketplace.get("source", name))
        if name not in names and source not in sources:
            drift.append(f"marketplace:{name}")
            if not check:
                add = subprocess.run(["omp", "plugin", "marketplace", "add", source], cwd=root, capture_output=True, text=True, check=False)
                if add.returncode != 0:
                    return {"error": add.stderr.strip() or f"failed to add {source}"}, 1
        for plugin in marketplace.get("plugins", []):
            if (str(plugin), name) not in installed:
                drift.append(f"plugin:{plugin}@{name}")
                if not check:
                    install = subprocess.run(["omp", "plugin", "install", f"{plugin}@{name}", "--scope", "project"], cwd=root, capture_output=True, text=True, check=False)
                    if install.returncode != 0:
                        return {"error": install.stderr.strip() or f"failed to install {plugin}@{name}"}, 1
    return {"desired": desired, "drift": drift}, 1 if check and drift else 0


def hooks_install(root: Path) -> tuple[dict[str, Any], int]:
    config = root / ".pre-commit-config.yaml"
    if not config.is_file():
        return {"error": "no .pre-commit-config.yaml"}, 1
    stages = set(re.findall(r"(?:default_install_hook_types|stages):\s*\[([^]]+)\]", config.read_text()))
    hook_types = sorted({part.strip(" '\"") for group in stages for part in group.split(",") if part.strip()})
    command = ["prek", "install"]
    for stage in hook_types:
        command.extend(["--hook-type", stage])
    run = subprocess.run(command, cwd=root, capture_output=True, text=True, check=False)
    return {"command": command, "stdout": run.stdout, "stderr": run.stderr}, run.returncode


def tools_install(root: Path, yes: bool) -> tuple[dict[str, Any], int]:
    if not yes:
        return {"error": "refusing tool installation without --yes"}, 1
    commands = [["mise", "install"]]
    if (root / "pyproject.toml").exists() or (root / "uv.lock").exists():
        commands.append(["uv", "sync"])
    if (root / "package.json").exists():
        commands.append(["bun", "install"])
    output = []
    for command in commands:
        run = subprocess.run(command, cwd=root, capture_output=True, text=True, check=False)
        output.append({"command": command, "returncode": run.returncode, "stdout": run.stdout, "stderr": run.stderr})
        if run.returncode:
            return {"commands": output}, run.returncode
    return {"commands": output}, 0


def context_refresh(root: Path) -> tuple[dict[str, Any], int]:
    script = root / ".omp/context.py"
    if not script.is_file():
        return {"error": "no .omp/context.py"}, 1
    run = subprocess.run([sys.executable, str(script), "refresh"], cwd=root, capture_output=True, text=True, check=False)
    return {"stdout": run.stdout, "stderr": run.stderr}, run.returncode


def profiles_list() -> dict[str, Any]:
    profiles = []
    for path in sorted(PROFILES.glob("*.toml")):
        with path.open("rb") as stream:
            data = tomllib.load(stream)
        profiles.append({"name": path.stem, "summary": data.get("summary", ""), "layers": data.get("layers", []), "plugins": profile_plugins(data, data.get("vars", {}))})
    return {"profiles": profiles}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("profiles").add_subparsers(dest="profiles_command", required=True).add_parser("list")
    for action in ("inspect",):
        command = sub.add_parser(action)
        command.add_argument("--root", default=".")
    for action in ("plan", "render"):
        command = sub.add_parser(action)
        command.add_argument("--root", default=".")
        command.add_argument("--profile", required=True)
        command.add_argument("--name")
        command.add_argument("--var", action="append", default=[])
        command.add_argument("--force-layer")
    plugins = sub.add_parser("plugins").add_subparsers(dest="plugins_command", required=True).add_parser("sync")
    plugins.add_argument("--root", default=".")
    plugins.add_argument("--check", action="store_true")
    hooks = sub.add_parser("hooks").add_subparsers(dest="hooks_command", required=True).add_parser("install")
    hooks.add_argument("--root", default=".")
    context = sub.add_parser("context").add_subparsers(dest="context_command", required=True).add_parser("refresh")
    context.add_argument("--root", default=".")
    tools = sub.add_parser("tools").add_subparsers(dest="tools_command", required=True).add_parser("install")
    tools.add_argument("--root", default=".")
    tools.add_argument("--yes", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "profiles":
        print(json.dumps(profiles_list(), indent=2, sort_keys=True)); return 0
    root = Path(args.root).expanduser().resolve()
    if args.command == "inspect":
        print(json.dumps(inspect(root), indent=2, sort_keys=True)); return 0
    if args.command in {"plan", "render"}:
        overrides = parse_vars(args.var)
        if args.command == "plan":
            payload, _, code = run_plan(root, args.profile, args.name, overrides, args.force_layer)
        else:
            payload, code = render(root, args.profile, args.name, overrides, args.force_layer)
        print(json.dumps(payload, indent=2, sort_keys=True)); return code
    if args.command == "plugins":
        payload, code = plugins_sync(root, args.check); print(json.dumps(payload, indent=2, sort_keys=True)); return code
    if args.command == "hooks":
        payload, code = hooks_install(root); print(json.dumps(payload, indent=2, sort_keys=True)); return code
    if args.command == "context":
        payload, code = context_refresh(root); print(json.dumps(payload, indent=2, sort_keys=True)); return code
    if args.command == "tools":
        payload, code = tools_install(root, args.yes); print(json.dumps(payload, indent=2, sort_keys=True)); return code
    return 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, subprocess.SubprocessError, tomllib.TOMLDecodeError, ValueError, KeyError) as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        raise SystemExit(1)
