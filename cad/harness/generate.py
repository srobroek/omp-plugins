#!/usr/bin/env python3
"""Render the CAD agents for supported coding harnesses.

Source: canonical OMP agent Markdown in cad/agents/, one file per agent.
Harness formats: Claude Code subagents, Kiro custom agents, and OpenCode agents.
Also renders cad/.claude-plugin/plugin.json, which points Claude Code at the
generated subagents instead of the OMP-format files in cad/agents/, and the
OpenCode /cad-flow command.

Permissions follow each agent's OMP `tools`. A read-only agent gets no write,
shell, or subagent access. An agent with `edit` or `write` may write files only
under the worker scratch root `.cad-work/` (the lead's records change only
through `scratch.py deliver`); one with `bash` may run only `uv` commands; one
with `web_search` may search and fetch the web. `autoloadSkills` become each
harness's preloaded skills.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
AGENTS = ROOT / "agents"
SKILLS = ROOT / "skills"
OUTPUTS = {
    "claude": ROOT / "harness" / "claude" / "agents",
    "kiro": ROOT / "harness" / "kiro" / "agents",
    "opencode": ROOT / "harness" / "opencode" / "agents",
}
OPENCODE_COMMAND = ROOT / "harness" / "opencode" / "commands" / "cad-flow.md"
CLAUDE_MANIFEST = ROOT / ".claude-plugin" / "plugin.json"
OMP_MANIFEST = ROOT / ".omp-plugin" / "plugin.json"
# OMP tool -> Claude Code tools. OMP `read` also fetches URLs; Claude Code needs WebFetch for that.
CLAUDE_TOOLS = {
    "read": ("Read",), "grep": ("Grep",), "glob": ("Glob",),
    "edit": ("Edit",), "write": ("Write",), "bash": ("Bash",),
    "web_search": ("WebSearch", "WebFetch"),
}
WORK_DIR = ".cad-work"  # the scratch root of cad/skills/cad-flow/scripts/scratch.py
SHELL = "uv *"  # workers run only `uv run --script` tools


@dataclass(frozen=True)
class Agent:
    name: str
    description: str
    prompt: str
    tools: tuple[str, ...]
    skills: tuple[str, ...]

    @property
    def writes(self) -> bool:
        return "edit" in self.tools or "write" in self.tools

    @property
    def shell(self) -> bool:
        return "bash" in self.tools

    @property
    def web(self) -> bool:
        return "web_search" in self.tools


def csv(value: str) -> tuple[str, ...]:
    return tuple(item.strip() for item in value.split(",")) if value else ()


def parse_agent(path: Path) -> Agent:
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
    if fields["name"] != path.stem:
        raise ValueError(f"{path}: name {fields['name']!r} must match the file name")
    tools = csv(fields["tools"])
    unknown = [tool for tool in tools if tool not in CLAUDE_TOOLS]
    if not tools or unknown or len(set(tools)) != len(tools):
        raise ValueError(f"{path}: tools must be distinct names from {sorted(CLAUDE_TOOLS)}; got {fields['tools']!r}")
    skills = csv(fields.get("autoloadSkills", ""))
    missing = [skill for skill in skills if not (SKILLS / skill / "SKILL.md").is_file()]
    if missing:
        raise ValueError(f"{path}: autoloadSkills names skills cad does not ship: {missing}")
    return Agent(fields["name"], fields["description"], match.group(2).strip(), tools, skills)


def agents() -> list[Agent]:
    found = [parse_agent(path) for path in sorted(AGENTS.glob("*.md"))]
    if not found:
        raise ValueError(f"no agents in {AGENTS}")
    return found


def kiro_rules(agent: Agent) -> list[dict]:
    def rule(capability: str, match: str, effect: str) -> dict:
        return {"capability": capability, "match": [match], "effect": effect}

    rules = [
        rule("fs_read", "**/*", "allow"),
        rule("fs_write", f"{WORK_DIR}/**", "allow") if agent.writes else rule("fs_write", "**/*", "deny"),
        rule("shell", SHELL, "allow") if agent.shell else rule("shell", "*", "deny"),
    ]
    if agent.web:
        rules += [rule("web_fetch", "*", "allow"), rule("web_search", "*", "allow")]
    return [*rules, rule("subagent", "*", "deny")]


def opencode_permission(agent: Agent) -> str:
    lines = ["permission:", "  '*': deny", "  read: allow", "  glob: allow", "  grep: allow", "  skill: allow"]
    lines += ["  edit:", "    '*': deny", f"    '*{WORK_DIR}/*': allow"] if agent.writes else ["  edit: deny"]
    lines += ["  bash:", "    '*': deny", f"    '{SHELL}': allow"] if agent.shell else ["  bash: deny"]
    if agent.web:
        lines += ["  webfetch: allow", "  websearch: allow"]
    return "\n".join([*lines, "  task: deny"])


def render(agent: Agent, harness: str) -> str:
    if harness == "claude":
        # Format: https://code.claude.com/docs/en/sub-agents#write-subagent-files
        tools = [name for tool in agent.tools for name in CLAUDE_TOOLS[tool]]
        return (
            "---\n"
            f"name: {agent.name}\n"
            f"description: {json.dumps(agent.description)}\n"
            f"tools: {', '.join(tools)}\n"
            f"skills: [{', '.join(agent.skills)}]\n"
            "model: inherit\n"
            "---\n\n"
            f"{agent.prompt}\n"
        )
    if harness == "kiro":
        # Format: https://kiro.dev/docs/custom-agents/configuration-reference/
        tags = ["read"] + ["write"] * agent.writes + ["shell"] * agent.shell + ["web"] * agent.web
        value = {
            "name": agent.name,
            "description": agent.description,
            "prompt": agent.prompt,
            "tools": tags,
            "permissions": {"rules": kiro_rules(agent)},
            "resources": [f"skill://cad/skills/{skill}/SKILL.md" for skill in agent.skills],
        }
        return json.dumps(value, indent=2, ensure_ascii=False) + "\n"
    if harness == "opencode":
        # Format: https://opencode.ai/docs/agents/ and https://opencode.ai/docs/permissions/
        return (
            "---\n"
            f"description: {json.dumps(agent.description)}\n"
            "mode: subagent\n"
            f"{opencode_permission(agent)}\n"
            "---\n\n"
            f"{agent.prompt}\n"
        )
    raise ValueError(f"unknown harness {harness!r}")


def output_path(name: str, harness: str) -> Path:
    return OUTPUTS[harness] / f"{name}.{'json' if harness == 'kiro' else 'md'}"


def claude_manifest(names: list[str]) -> str:
    # Format: https://code.claude.com/docs/en/plugins-reference#plugin-manifest-schema
    # A declared `agents` list replaces the default agents/ directory, so Claude Code
    # never loads the OMP-format sources there. `version` is left out: Claude Code
    # then reads it from the marketplace entry, which build-catalog.py derives from
    # .omp-plugin/plugin.json, the only manifest release-please bumps.
    omp = json.loads(OMP_MANIFEST.read_text(encoding="utf-8"))
    paths = [f"./{output_path(name, 'claude').relative_to(ROOT).as_posix()}" for name in names]
    return json.dumps({"name": omp["name"], "description": omp["description"], "agents": paths}, indent=2) + "\n"


def opencode_command() -> str:
    return """---
description: Prototype-to-CAD flow (cad plugin)
---

Load the `cad-flow` skill and follow it. With arguments, apply it to $ARGUMENTS. Without arguments, resume the existing `hw/` design record, or ask what to design when there is none.
"""


def generated() -> dict[Path, str]:
    found = agents()
    outputs = {output_path(agent.name, harness): render(agent, harness) for harness in OUTPUTS for agent in found}
    outputs[CLAUDE_MANIFEST] = claude_manifest([agent.name for agent in found])
    outputs[OPENCODE_COMMAND] = opencode_command()
    return outputs


def unexpected(outputs: dict[Path, str]) -> list[Path]:
    """Files in the generated agent directories that no canonical agent produces."""
    return sorted(path for folder in OUTPUTS.values() if folder.is_dir()
                  for path in folder.iterdir() if path not in outputs)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if generated files are missing, stale, or unexpected")
    args = parser.parse_args()
    try:
        outputs = generated()
    except (OSError, KeyError, ValueError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1

    drift: list[str] = []
    for path, expected in outputs.items():
        if args.check:
            if not path.is_file():
                drift.append(f"missing {path.relative_to(ROOT)}")
            elif path.read_text(encoding="utf-8") != expected:
                drift.append(f"stale {path.relative_to(ROOT)}")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(expected, encoding="utf-8")
            print(f"generated {path.relative_to(ROOT)}")
    for path in unexpected(outputs):
        if args.check:
            drift.append(f"unexpected {path.relative_to(ROOT)}")
        else:
            path.unlink()
            print(f"removed {path.relative_to(ROOT)}")
    if drift:
        print("FAIL: generated CAD harness files differ from canonical OMP files:", file=sys.stderr)
        for path in drift:
            print(f"  {path}", file=sys.stderr)
        print("Run python3 cad/harness/generate.py", file=sys.stderr)
        return 1
    if args.check:
        print(f"PASS: {len(outputs)} harness files current")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
