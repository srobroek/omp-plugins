"""Kiro adapter: `kiro-cli chat --no-interactive --agent-engine v3 --output-format stream-json`.

Observed stream (kiro-cli 2.34.0, v3 engine): `runStarted`, then `sessionUpdate`
events whose `data.update` is an ACP session update, then `runFinished` with
`status`, `stopReason` and `finalText`.

- Text: `agent_message_chunk`/`agent_thought_chunk` content.
- Tools: `tool_call` (title, rawInput) and `tool_call_update` (status, rawOutput).
- Served model: the `model` entry of the last `config_option_update`. This is
  the session's model setting as Kiro reports it, not a per-response provider id;
  Kiro's stream carries nothing closer to the wire.
- Usage: Kiro reports no token counts; `session_info_update` turn summaries carry
  spend in credits (`_meta.kiro.promptTurnSummaries[].usage`), recorded as
  `usage.credits`. Token fields stay 0.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Iterable

from .base import TrialPaths, Turn, add_usage, copy_tree, empty_usage, json_lines, tool_text


@dataclass
class KiroAdapter:
    bin: str = "kiro-cli"
    trust_tools: str = ""
    agent: str | None = None
    extra_env: dict[str, str] = field(default_factory=dict)
    plugin_marker: str = "skills"
    name: str = "kiro"

    def prepare(self, paths: TrialPaths) -> None:
        # Workspace-scoped Kiro resources: skills and the generated agent JSON.
        copy_tree(paths.plugin / "skills", paths.work / ".kiro" / "skills")
        copy_tree(paths.plugin / "harness" / "kiro" / "agents", paths.work / ".kiro" / "agents")

    def command(self, *, model: str, prompt: str, paths: TrialPaths, resume: bool) -> list[str]:
        argv = [
            self.bin, "chat", "--no-interactive", "--agent-engine", "v3", "--model", model,
            "--output-format", "stream-json", f"--trust-tools={self.trust_tools}", "--trust-workspace",
        ]
        if self.agent:
            argv += ["--agent", self.agent]
        if resume:
            argv.append("--resume")
        argv.append(prompt)
        return argv

    def env(self, paths: TrialPaths) -> dict[str, str]:
        return dict(self.extra_env)

    def parse(self, lines: Iterable[str]) -> Turn:
        turn = Turn()
        usage = empty_usage()
        chunks: list[str] = []
        thoughts: list[str] = []
        names: dict[str, str] = {}
        for event in json_lines(lines):
            kind = event.get("type")
            data = event.get("data") or {}
            if kind == "runFinished":
                _flush(turn, chunks, thoughts)
                if isinstance(data.get("finalText"), str) and data["finalText"]:
                    turn.text = data["finalText"]
                if data.get("status") != "success":
                    turn.error = data.get("error") or f"run {data.get('status')}: {data.get('stopReason')}"
                if data.get("stopReason") in ("max_tokens", "max_turn_requests"):
                    turn.truncated = True
                continue
            if kind != "sessionUpdate":
                if data.get("error"):
                    turn.error = tool_text(data["error"])
                continue
            update = data.get("update") or {}
            sub = update.get("sessionUpdate")
            if sub == "agent_message_chunk":
                chunks.append(tool_text(update.get("content")))
            elif sub == "agent_thought_chunk":
                thoughts.append(tool_text(update.get("content")))
            elif sub == "config_option_update":
                for option in update.get("configOptions") or []:
                    if option.get("id") == "model" and option.get("currentValue"):
                        turn.model = option["currentValue"]
            elif sub == "tool_call":
                _flush(turn, chunks, thoughts)
                name = update.get("title") or update.get("kind") or ""
                names[update.get("toolCallId", "")] = name
                turn.tools.append(name)
                turn.transcript.append({"role": "tool_call", "name": name, "content": json.dumps(update.get("rawInput", {}), sort_keys=True)})
            elif sub == "tool_call_update" and update.get("status") in ("completed", "failed"):
                payload = update.get("rawOutput", update.get("content"))
                turn.transcript.append({"role": "tool_result", "name": names.get(update.get("toolCallId", ""), ""), "content": tool_text(payload)})
            elif sub == "session_info_update":
                for summary in ((update.get("_meta") or {}).get("kiro") or {}).get("promptTurnSummaries") or []:
                    if summary.get("unit") == "credit":
                        usage = add_usage(usage, {"credits": summary.get("usage", 0)})
        _flush(turn, chunks, thoughts)
        turn.usage = usage
        return turn


def _flush(turn: Turn, chunks: list[str], thoughts: list[str]) -> None:
    if not chunks and not thoughts:
        return
    entry = {"role": "assistant", "content": "".join(chunks)}
    if thoughts:
        entry["thinking"] = "".join(thoughts)
    turn.transcript.append(entry)
    if chunks:
        turn.text = "".join(chunks)
    chunks.clear()
    thoughts.clear()
