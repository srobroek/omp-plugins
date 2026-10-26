"""Claude Code adapter: `claude -p --model <m> --output-format stream-json --verbose`.

stream-json emits `system/init`, then `assistant` and `user` events whose
`message` is an Anthropic Messages object, then one terminal `result` event with
session usage, cost and the final text. Subagent traffic carries a non-null
`parent_tool_use_id` and is excluded from the served-model read.

Isolation: CLAUDE_CONFIG_DIR points into the trial (no user settings,
enabledPlugins, skills, agents, CLAUDE.md or ~/.claude.json MCP servers),
`--setting-sources project,local` drops user settings, `--strict-mcp-config` with
an empty `--mcp-config` file allows no MCP server, and `--plugin-dir` loads cad.
What Claude Code bundles is switched off through its documented switches
(`BUNDLED_OFF`); the built-in commands no switch removes are the version's
declared `BASELINE`. TMPDIR and CLAUDE_CODE_TMPDIR (Claude's own temp root, `/tmp`
by default on macOS) point into the trial. HOME stays real only behind the toolbox
launcher, which resolves its own install from it. Bedrock auth:
`CLAUDE_CODE_USE_BEDROCK` plus exported AWS credentials. The `system/init` event
lists what loaded and is the inventory.
"""

from __future__ import annotations

import json
import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from .base import Baseline, Host, Inventory, TrialPaths, Turn, copy_tree, isolated_home, json_lines, tool_text, trial_temp

REQUIRED_TOOLS = ("Skill",)  # without it the agent cannot load a cad skill

# Plugins compiled into Claude Code 2.1.310; only `enabledPlugins` turns them off.
BUILTIN_PLUGINS = ("cc-plugin-agents-md@builtin", "cc-plugin-plugin-authoring@builtin")

# Every documented switch that removes a bundled skill, subagent or command
# (code.claude.com/docs/en/env-vars, settings-reference, sub-agents, skills).
# `--disable-slash-commands` is not used: it also removes the cad skills.
BUNDLED_OFF = {
    "CLAUDE_CODE_DISABLE_BUNDLED_SKILLS": "1",  # bundled skills and workflows; built-in commands hidden from the model
    "CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS": "1",  # every built-in subagent type, general-purpose included (-p only)
    "CLAUDE_CODE_DISABLE_WORKFLOWS": "1",  # dynamic workflows and their bundled commands
    "CLAUDE_CODE_DISABLE_POLICY_SKILLS": "1",  # skills from the system-wide managed skills directory
    "DISABLE_DOCTOR_COMMAND": "1",  # /doctor, which disableBundledSkills leaves typable
    "DISABLE_FEEDBACK_COMMAND": "1",  # /feedback, /bug, /share
    "DISABLE_EXTRA_USAGE_COMMAND": "1",
    "DISABLE_INSTALL_GITHUB_APP_COMMAND": "1",
    "DISABLE_LOGIN_COMMAND": "1",
    "DISABLE_LOGOUT_COMMAND": "1",
    "DISABLE_UPGRADE_COMMAND": "1",
}

# What Claude Code 2.1.310 still lists with BUNDLED_OFF applied, observed in a clean
# run whose CLAUDE_CONFIG_DIR was empty: built-in commands only (no bundled skill,
# subagent or plugin remains). No supported switch removes them; with bundled
# skills off they stay typable but are hidden from the model.
BASELINE = Baseline("2.1.310", {
    "commands": frozenset({
        "__remote-workflow", "agents", "auto-mode-setup", "autocompact", "clear", "color", "compact", "config",
        "context", "effort", "fast", "focus", "goal", "heapdump", "init", "insights", "list-agents", "mcp", "model",
        "output-style", "recap", "reload-plugins", "reload-skills", "rename", "security-review", "team-onboarding",
        "usage", "workflow-launch-exec",
    }),
})


def canonical_model(model: str) -> str:
    """`global.anthropic.claude-opus-5-5` -> `claude-opus-5-5`, the id Claude Code accepts.

    Claude Code resolves a model through its canonical name; a raw Bedrock id is only
    honoured via `modelOverrides`, which normally sits in user settings. Without it the
    flag is silently ignored and the default model serves (seen in the isolated smoke)."""
    model = model.rsplit("/", 1)[-1]
    parts = model.split(".")
    return parts[-1] if len(parts) >= 3 and parts[0] in {"global", "us", "eu", "apac", "jp", "au"} else model


def is_launcher(bin_name: str) -> bool:
    found = shutil.which(bin_name)
    return bool(found) and os.path.realpath(found).endswith("toolbox-exec")


def resolve_launcher(bin_name: str) -> str:
    """The real Claude Code binary behind an Amazon toolbox launcher.

    `~/.toolbox/bin/claude` is `toolbox-exec`, which copies Amazon builder rules into
    the Claude rules directory and adds builder context before it starts Claude Code
    (only `--bare` skips that). Running the versioned binary the launcher would run,
    read from the toolbox's `info.json`, keeps those rules out. Any other `claude`
    is returned unchanged."""
    if not is_launcher(bin_name):
        return bin_name
    tool = Path(os.path.realpath(shutil.which(bin_name))).parents[2] / "claude-code"  # tools/toolbox/<v>/toolbox-exec
    try:
        version = json.loads((tool / "info.json").read_text(encoding="utf-8"))["CurrentVersion"]["Version"]
    except (OSError, KeyError, json.JSONDecodeError):
        return bin_name
    real = tool / version / "claude"
    return str(real) if real.is_file() else bin_name


@dataclass
class ClaudeAdapter:
    bin: str = "claude"
    # `--bare` keeps only Bash/Edit/Read (no Skill, Task, Write, Glob, Grep), so the
    # cad skills are unreachable; isolation comes from the config dir and flags instead.
    bare: bool = False
    bypass_launcher: bool = True
    setting_sources: str = "project,local"
    extra_env: dict[str, str] = field(default_factory=dict)
    plugin_marker: str = "skills"  # cad ships no .claude-plugin manifest; Claude derives the name from the directory
    name: str = "claude"
    isolation: str = (
        "real Claude Code binary (toolbox launcher bypassed); CLAUDE_CONFIG_DIR in the trial;"
        " --setting-sources project,local; trial --settings pins the model and disables bundled plugins;"
        " bundled skills, subagents, workflows and hideable commands switched off (BUNDLED_OFF);"
        " TMPDIR and CLAUDE_CODE_TMPDIR in the trial; --strict-mcp-config with an empty --mcp-config;"
        " cad via --plugin-dir; AWS credentials exported to env"
    )
    baseline: Baseline = field(default_factory=lambda: BASELINE)

    def __post_init__(self) -> None:
        if self.bypass_launcher:
            self.bin = resolve_launcher(self.bin)
        # Only the launcher needs the user's HOME (it resolves its install from it).
        self.via_launcher = is_launcher(self.bin)
        if self.via_launcher:
            self.isolation += "; WARNING: toolbox launcher in use, it injects Amazon builder rules"

    def prepare(self, paths: TrialPaths, host: Host) -> None:
        # Generated Claude agents ship under harness/claude/agents; project scope
        # makes them visible without touching the user's ~/.claude.
        copy_tree(paths.plugin / "harness" / "claude" / "agents", paths.work / ".claude" / "agents")
        (paths.home / ".claude").mkdir(parents=True, exist_ok=True)
        (paths.root / "mcp.json").write_text('{"mcpServers": {}}\n', encoding="utf-8")

    def command(self, *, model: str, prompt: str, paths: TrialPaths, resume: bool) -> list[str]:
        canonical = canonical_model(model)
        settings: dict = {"enabledPlugins": {name: False for name in BUILTIN_PLUGINS}}
        if canonical != model:
            settings["modelOverrides"] = {canonical: model}
        argv = [
            self.bin, "-p", "--model", canonical, "--output-format", "stream-json", "--verbose",
            "--permission-mode", "bypassPermissions",
            "--strict-mcp-config", "--mcp-config", str(paths.root / "mcp.json"),
            "--setting-sources", self.setting_sources, "--settings", json.dumps(settings, sort_keys=True),
        ]
        if self.bare:
            argv.append("--bare")
        if (paths.plugin / self.plugin_marker).exists():
            argv += ["--plugin-dir", str(paths.plugin)]
        if resume:
            argv.append("--continue")
        argv.append(prompt)
        return argv

    def env(self, paths: TrialPaths, host: Host) -> dict[str, str]:
        # The launcher resolves its install from the real HOME; the bare binary needs
        # no HOME of the user's, so it gets the isolated one.
        home = {"HOME": str(host.real_home)} if self.via_launcher else isolated_home(paths)
        return {
            **host.base_env, **home, **trial_temp(paths), **host.aws_env, **BUNDLED_OFF, **self.extra_env,
            "CLAUDE_CONFIG_DIR": str(paths.home / ".claude"), "CLAUDE_CODE_TMPDIR": str(paths.tmp), "NO_COLOR": "1",
        }

    def user_stores(self, host: Host) -> list[Path]:
        return []  # sessions and history follow CLAUDE_CONFIG_DIR into the trial

    def probe(self, paths: TrialPaths, model: str, stream_lines: list[str]) -> list[tuple[list[str], str]]:
        return []  # system/init in the first turn's stream is the inventory

    def complete(self, turn: Turn, lines: list[str], paths: TrialPaths, env: dict[str, str]) -> Turn:
        return turn

    def inventory(self, probe_outputs: list[str], stream_lines: list[str], paths: TrialPaths) -> Inventory:
        inv = Inventory()
        init = next((e for e in json_lines(stream_lines) if e.get("type") == "system" and e.get("subtype") == "init"), None)
        if init is None:
            return inv
        inv.observed = True
        inv.version = init.get("claude_code_version")
        # Instruction files Claude reads from its config dir; init does not list them.
        config = paths.home / ".claude"
        inv.context += [str(p) for p in sorted(config.glob("rules/**/*.md")) + sorted(config.glob("CLAUDE.md"))]
        roots = (str(paths.root), str(paths.root.resolve()))
        for plugin in init.get("plugins") or []:
            where = plugin.get("path", "")
            inside = any(where.startswith(r) for r in roots)
            inv.plugins.append(plugin.get("name", "") if inside else f"{plugin.get('name', '')}@{where}")
        inv.skills = [s for s in init.get("skills") or [] if isinstance(s, str)]
        inv.agents = [a for a in init.get("agents") or [] if isinstance(a, str)]
        inv.commands = [c for c in init.get("slash_commands") or [] if isinstance(c, str)]
        inv.mcp = [m.get("name", "") if isinstance(m, dict) else str(m) for m in init.get("mcp_servers") or []]
        tools = set(init.get("tools") or [])
        inv.missing = [f"tool:{t}" for t in REQUIRED_TOOLS if t not in tools]
        # Auto-memory lives under the config dir. Inside the trial's fresh config dir it
        # starts empty and holds only what this trial writes; anywhere else it is ambient.
        memory = init.get("memory_paths") or {}
        for where in memory.values() if isinstance(memory, dict) else memory:
            if isinstance(where, str) and not any(where.startswith(r) for r in roots):
                inv.context.append(f"memory:{where}")
        return inv

    def parse(self, lines: Iterable[str]) -> Turn:
        turn = Turn()
        init_model = None
        for event in json_lines(lines):
            kind = event.get("type")
            if kind == "system" and event.get("subtype") == "init":
                init_model = event.get("model")
            elif kind == "assistant" and event.get("parent_tool_use_id") is None:
                self._assistant(turn, event.get("message") or {})
            elif kind == "user" and event.get("parent_tool_use_id") is None:
                self._user(turn, event.get("message") or {})
            elif kind == "result":
                self._result(turn, event)
        turn.model = turn.model or init_model
        return turn

    @staticmethod
    def _assistant(turn: Turn, message: dict) -> None:
        if message.get("model"):
            turn.model = message["model"]
        for block in message.get("content") or []:
            kind = block.get("type")
            if kind == "text":
                turn.transcript.append({"role": "assistant", "content": block.get("text", "")})
            elif kind == "thinking":
                turn.transcript.append({"role": "assistant", "content": "", "thinking": block.get("thinking", "")})
            elif kind == "tool_use":
                turn.tools.append(block.get("name", ""))
                turn.transcript.append(
                    {"role": "tool_call", "name": block.get("name", ""), "content": json.dumps(block.get("input", {}), sort_keys=True)}
                )

    @staticmethod
    def _user(turn: Turn, message: dict) -> None:
        content = message.get("content")
        if isinstance(content, str):
            turn.transcript.append({"role": "user", "content": content})
            return
        for block in content or []:
            if block.get("type") == "tool_result":
                turn.transcript.append({"role": "tool_result", "name": block.get("tool_use_id", ""), "content": tool_text(block.get("content"))})
            elif block.get("type") == "text":
                turn.transcript.append({"role": "user", "content": block.get("text", "")})

    @staticmethod
    def _result(turn: Turn, event: dict) -> None:
        raw = event.get("usage") or {}
        turn.usage = {
            "input": raw.get("input_tokens", 0) or 0,
            "output": raw.get("output_tokens", 0) or 0,
            "cacheRead": raw.get("cache_read_input_tokens", 0) or 0,
            "cacheWrite": raw.get("cache_creation_input_tokens", 0) or 0,
        }
        if event.get("total_cost_usd") is not None:
            turn.usage["cost_usd"] = event["total_cost_usd"]
        if isinstance(event.get("result"), str):
            turn.text = event["result"]
        subtype = event.get("subtype", "")
        if subtype == "error_max_turns":
            turn.truncated = True
        elif event.get("is_error") or subtype.startswith("error"):
            turn.error = (event.get("result") if isinstance(event.get("result"), str) else None) or subtype or "result is_error"
