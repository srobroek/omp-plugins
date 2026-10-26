"""Claude Code adapter: `claude -p --model <m> --output-format stream-json --verbose`.

stream-json emits `system/init`, then `assistant` and `user` events whose
`message` is an Anthropic Messages object, then one terminal `result` event with
session usage, cost and the final text. Subagent traffic carries a non-null
`parent_tool_use_id` and is excluded from the served-model read.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Iterable

from .base import TrialPaths, Turn, copy_tree, json_lines, tool_text


@dataclass
class ClaudeAdapter:
    bin: str = "claude"
    bare: bool = True
    # `--bare` still loads user-scope plugins (seen in the smoke stream). Setting
    # this to "project,local" drops user settings, including enabledPlugins;
    # untested live, so Bedrock auth must then come from `env` alone.
    setting_sources: str | None = None
    extra_env: dict[str, str] = field(default_factory=dict)
    plugin_marker: str = ".claude-plugin/plugin.json"
    name: str = "claude"

    def prepare(self, paths: TrialPaths) -> None:
        # Generated Claude agents ship under harness/claude/agents; project scope
        # makes them visible without touching the user's ~/.claude.
        copy_tree(paths.plugin / "harness" / "claude" / "agents", paths.work / ".claude" / "agents")

    def command(self, *, model: str, prompt: str, paths: TrialPaths, resume: bool) -> list[str]:
        argv = [
            self.bin, "-p", "--model", model, "--output-format", "stream-json", "--verbose",
            "--permission-mode", "bypassPermissions", "--strict-mcp-config",
        ]
        if self.bare:
            argv.append("--bare")
        if self.setting_sources:
            argv += ["--setting-sources", self.setting_sources]
        if (paths.plugin / self.plugin_marker).is_file():
            argv += ["--plugin-dir", str(paths.plugin)]
        if resume:
            argv.append("--continue")
        argv.append(prompt)
        return argv

    def env(self, paths: TrialPaths) -> dict[str, str]:
        return dict(self.extra_env)

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
