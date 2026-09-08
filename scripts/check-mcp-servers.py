#!/usr/bin/env python3
"""Validate MCP transports and preserve the expected package server inventory."""

import json
from pathlib import Path
from urllib.parse import urlsplit

REPO = Path(__file__).resolve().parent.parent

EXPECTED = {
    "design": ["accessibility-scanner", "storybook", "wire-dsl"],
    "browser-tools": ["chrome-devtools", "playwright-cross-engine"],
    "diagram": ["excalidraw"],
}


def validate_config(config: object) -> list[str]:
    if not isinstance(config, dict):
        return ["config must be an object"]
    problems = []
    if ("command" in config) == ("url" in config):
        problems.append("needs exactly one command or HTTP(S) url")
    if "command" in config:
        command = config["command"]
        if not isinstance(command, str) or not command.strip():
            problems.append("command must be a non-empty string")
    if "url" in config:
        url = config["url"]
        try:
            parsed = urlsplit(url) if isinstance(url, str) else None
            if parsed is None or parsed.scheme not in {"http", "https"} or not parsed.hostname or any(c.isspace() for c in url):
                raise ValueError("invalid HTTP URL")
            parsed.port
        except ValueError:
            problems.append("url must be an absolute HTTP(S) URL with a valid host and port")
    if "args" in config and (
        not isinstance(config["args"], list) or any(not isinstance(arg, str) for arg in config["args"])
    ):
        problems.append("args must be a list of strings")
    if "env" in config and (
        not isinstance(config["env"], dict)
        or any(not key.strip() or not isinstance(value, str) for key, value in config["env"].items())
    ):
        problems.append("env must be an object with non-empty names and string values")
    return problems


def main() -> int:
    failures = []
    paths = {p.parent.parent.name: p for p in REPO.glob("*/.omp-plugin/plugin.json")}
    for name in sorted(set(paths) | set(EXPECTED)):
        path = paths.get(name, REPO / name / ".omp-plugin" / "plugin.json")
        try:
            manifest = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(manifest, dict):
                raise ValueError("manifest must be an object")
            servers = manifest.get("mcpServers", {})
            if not isinstance(servers, dict):
                raise ValueError("mcpServers must be an object")
        except (ValueError, OSError) as err:
            failures.append(f"{path}: {err}")
            continue
        if name in EXPECTED and sorted(servers) != sorted(EXPECTED[name]):
            failures.append(f"{name}: expected {sorted(EXPECTED[name])}, got {sorted(servers)}")
        for server, config in servers.items():
            if not server.strip():
                failures.append(f"{name}: server name must be non-empty")
            failures.extend(f"{name}/{server}: {problem}" for problem in validate_config(config))
    if failures:
        for line in failures:
            print(f"FAIL {line}")
        return 1
    print("PASS: every declared MCP server has a valid transport and expected servers survived regeneration")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
