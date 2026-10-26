"""OMP adapter: `omp -p --model amazon-bedrock/<id> --mode json`.

`--mode json` writes a session header, then session events as JSON lines; every
completed message arrives whole in a `message_end` event. Assistant messages carry
the served `model` and a `usage` object in OMP's own key names.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Iterable

from .base import TrialPaths, Turn, add_usage, empty_usage, json_lines, tool_text


@dataclass
class OmpAdapter:
    bin: str = "omp"
    profile: str | None = None
    extra_env: dict[str, str] = field(default_factory=dict)
    plugin_marker: str = ".omp-plugin/plugin.json"
    name: str = "omp"

    def prepare(self, paths: TrialPaths) -> None:
        paths.state.mkdir(parents=True, exist_ok=True)

    def command(self, *, model: str, prompt: str, paths: TrialPaths, resume: bool) -> list[str]:
        argv = [self.bin, "-p", "--model", model, "--mode", "json", "--no-title", "--auto-approve"]
        if self.profile:
            argv += ["--profile", self.profile]
        if (paths.plugin / self.plugin_marker).is_file():
            argv += ["--plugin-dir", str(paths.plugin)]
        argv += ["--session-dir", str(paths.state)]
        if resume:
            argv.append("--continue")
        argv.append(prompt)
        return argv

    def env(self, paths: TrialPaths) -> dict[str, str]:
        return dict(self.extra_env)

    def parse(self, lines: Iterable[str]) -> Turn:
        turn = Turn()
        usage = empty_usage()
        for event in json_lines(lines):
            if event.get("type") != "message_end":
                continue
            message = event.get("message") or {}
            role = message.get("role")
            if role == "user":
                turn.transcript.append({"role": "user", "content": tool_text(message.get("content"))})
            elif role == "toolResult":
                turn.transcript.append(
                    {"role": "tool_result", "name": message.get("toolName", ""), "content": tool_text(message.get("content"))}
                )
            elif role == "assistant":
                self._assistant(turn, message)
                usage = add_usage(usage, _usage(message.get("usage") or {}))
        turn.usage = usage
        return turn

    @staticmethod
    def _assistant(turn: Turn, message: dict) -> None:
        if message.get("model"):
            turn.model = message["model"]
        texts, thinking = [], []
        for block in message.get("content") or []:
            kind = block.get("type")
            if kind == "text":
                texts.append(block.get("text", ""))
            elif kind == "thinking":
                thinking.append(block.get("thinking", ""))
            elif kind == "toolCall":
                name = block.get("name", "")
                turn.tools.append(name)
                turn.transcript.append(
                    {"role": "tool_call", "name": name, "content": json.dumps(block.get("arguments", {}), sort_keys=True)}
                )
        entry = {"role": "assistant", "content": "\n".join(texts)}
        if thinking:
            entry["thinking"] = "\n".join(thinking)
        if texts or thinking:
            turn.transcript.append(entry)
        if texts:
            turn.text = "\n".join(texts)
        stop = message.get("stopReason")
        if stop == "error":
            turn.error = message.get("errorMessage") or "assistant turn ended with stopReason=error"
        elif stop == "length":
            turn.truncated = True


def _usage(raw: dict) -> dict:
    cost = raw.get("cost")
    out = {
        "input": raw.get("input", 0),
        "output": raw.get("output", 0),
        "cacheRead": raw.get("cacheRead", 0),
        "cacheWrite": raw.get("cacheWrite", 0),
    }
    if isinstance(cost, dict) and cost.get("total") is not None:
        out["cost_usd"] = cost["total"]
    return out
