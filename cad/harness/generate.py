#!/usr/bin/env python3
"""Render CAD reviewer agents for supported coding harnesses.

Source: canonical OMP agent Markdown in cad/agents/.
Harness formats: Claude Code subagents, Kiro custom agents, and OpenCode agents.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
AGENTS = ROOT / "agents"
OUTPUTS = {
    "claude": ROOT / "harness" / "claude" / "agents",
    "kiro": ROOT / "harness" / "kiro" / "agents",
    "opencode": ROOT / "harness" / "opencode" / "agents",
}
AGENT_NAMES = ("cad-mech-reviewer", "cad-dfm-reviewer")
TOOL_MAP = {"read": "Read", "grep": "Grep", "glob": "Glob"}


def parse_agent(path: Path) -> tuple[dict[str, str], str]:
    text = path.read_text(encoding="utf-8")
    match = re.match(r"\A---\n(.*?)\n---\n(.*)\Z", text, re.DOTALL)
    if not match:
        raise ValueError(f"{path}: expected YAML frontmatter followed by a Markdown prompt")
    fields: dict[str, str] = {}
    for line in match.group(1).splitlines():
        key, separator, value = line.partition(":")
        if not separator or key in fields:
            raise ValueError(f"{path}: malformed or duplicate frontmatter field {line!r}")
        fields[key.strip()] = value.strip().strip('"').strip("'")
    for required in ("name", "description", "model", "tools"):
        if not fields.get(required):
            raise ValueError(f"{path}: missing frontmatter field {required}")
    if fields["model"] != "@reviewer":
        raise ValueError(f"{path}: model must be @reviewer")
    return fields, match.group(2).strip()


def tool_names(fields: dict[str, str]) -> list[str]:
    source = [tool.strip() for tool in fields["tools"].split(",")]
    if not source or any(not tool for tool in source):
        raise ValueError(f"{fields['name']}: tools must be a non-empty comma-separated list")
    try:
        tools = [TOOL_MAP[tool] for tool in source]
    except KeyError as error:
        raise ValueError(f"{fields['name']}: no Claude tool mapping for {error.args[0]!r}") from error
    if len(set(source)) != len(source):
        raise ValueError(f"{fields['name']}: duplicate OMP tool")
    return tools


def render(agent: str, harness: str) -> str:
    source = AGENTS / f"{agent}.md"
    fields, prompt = parse_agent(source)
    name = fields["name"]
    tools = tool_names(fields)
    if fields["tools"] != "read, grep, glob":
        raise ValueError(f"{source}: reviewers must expose only read, grep, and glob")
    skill = "cad-review-mech" if name == "cad-mech-reviewer" else "cad-review-dfm"
    if harness == "claude":
        # Format: https://code.claude.com/docs/en/sub-agents#write-subagent-files
        return (
            "---\n"
            f"name: {name}\n"
            f"description: {fields['description']}\n"
            f"tools: {', '.join(tools)}\n"
            f"skills: [{skill}]\n"
            "model: inherit\n"
            "---\n\n"
            f"{prompt}\n"
        )
    if harness == "kiro":
        # Format: https://kiro.dev/docs/custom-agents/configuration-reference/
        value = {
            "name": name,
            "description": fields["description"],
            "prompt": prompt,
            "tools": ["read"],
            "permissions": {"rules": [
                {"capability": "fs_read", "match": ["**/*"], "effect": "allow"},
                {"capability": "fs_write", "match": ["**/*"], "effect": "deny"},
                {"capability": "shell", "match": ["*"], "effect": "deny"},
                {"capability": "subagent", "match": ["*"], "effect": "deny"},
            ]},
            "resources": [f"skill://cad/skills/{skill}/SKILL.md"],
        }
        return json.dumps(value, indent=2, ensure_ascii=False) + "\n"
    if harness == "opencode":
        return (
            "---\n"
            f"description: {fields['description']}\n"
            "mode: subagent\n"
            "permission:\n"
            "  '*': deny\n"
            "  read: allow\n"
            "  glob: allow\n"
            "  grep: allow\n"
            "  skill: allow\n"
            "  edit: deny\n"
            "  bash: deny\n"
            "  task: deny\n"
            "---\n\n"
            f"{prompt}\n"
        )
    raise ValueError(f"unknown harness {harness!r}")


def generated() -> dict[Path, str]:
    return {
        directory / f"{agent}.{'json' if harness == 'kiro' else 'md'}": render(agent, harness)
        for harness, directory in OUTPUTS.items()
        for agent in AGENT_NAMES
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if generated files are missing or stale")
    args = parser.parse_args()
    try:
        outputs = generated()
    except (OSError, ValueError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1

    drift: list[str] = []
    for path, expected in outputs.items():
        if args.check:
            if not path.is_file():
                drift.append(f"missing {path.relative_to(ROOT)}")
            else:
                if path.read_text(encoding="utf-8") != expected:
                    drift.append(f"stale {path.relative_to(ROOT)}")
                if path.stat().st_mode & 0o222:
                    drift.append(f"writable generated file {path.relative_to(ROOT)}")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.exists():
                path.chmod(0o644)
            path.write_text(expected, encoding="utf-8")
            path.chmod(0o444)
            print(f"generated {path.relative_to(ROOT)}")
    if drift:
        print("FAIL: generated CAD agents differ from canonical OMP files:", file=sys.stderr)
        for path in drift:
            print(f"  {path}", file=sys.stderr)
        print("Run python3 cad/harness/generate.py", file=sys.stderr)
        return 1
    if args.check:
        print(f"PASS: {len(outputs)} harness agents current and read-only")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
