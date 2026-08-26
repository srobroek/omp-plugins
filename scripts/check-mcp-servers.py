#!/usr/bin/env python3
"""Assert every package that declares MCP servers still declares them after a sync run."""

import json
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

EXPECTED = {
    "design": ["accessibility-scanner", "storybook", "wire-dsl"],
    "browser-tools": ["chrome-devtools", "playwright-cross-engine"],
    "diagram": ["excalidraw"],
}

failures = []
for name, servers in EXPECTED.items():
    path = REPO / name / ".omp-plugin" / "plugin.json"
    if not path.is_file():
        failures.append(f"{name}: missing {path}")
        continue
    manifest = json.loads(path.read_text(encoding="utf-8"))
    got = sorted(manifest.get("mcpServers", {}))
    if got != sorted(servers):
        failures.append(f"{name}: expected {sorted(servers)}, got {got}")
        continue
    for server, config in manifest["mcpServers"].items():
        if "command" not in config and "url" not in config:
            failures.append(f"{name}/{server}: needs `command` or `url`; OMP warns and skips otherwise")
    print(f"OK {name}: {got}")

if failures:
    for line in failures:
        print(f"FAIL {line}")
    raise SystemExit(1)
print("PASS: every declared MCP server survived regeneration")
