"""OMP adapter: `omp -p --model amazon-bedrock/<id> --mode json`.

`--mode json` writes a session header, then session events as JSON lines; every
completed message arrives whole in a `message_end` event. Assistant messages carry
the served `model` and a `usage` object in OMP's own key names.

Isolation: HOME, PI_CODING_AGENT_DIR, the XDG roots and TMPDIR point into the
trial, so no user plugin, rule, skill, extension, AGENTS.md, MCP server or memory
loads; the cad plugin arrives through `--plugin-dir`. Bedrock credentials come
from exported environment variables, not the user's AWS profile. The inventory is read
model-free from `omp --mode rpc` (`get_state` returns the assembled system prompt
and tool descriptions; `get_available_commands` lists skill and extension commands).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from .base import Baseline, Host, Inventory, TrialPaths, Turn, add_usage, empty_usage, isolated_home, json_lines, tool_text, trial_temp

# Bundled with OMP 18.12.3, observed in a clean isolated run (no plugins at all).
BASELINE = Baseline("18.12.3", {
    "agents": frozenset({"scout", "reviewer", "security-reviewer", "seance", "task", "sonic"}),
    "commands": frozenset({"autoresearch", "green", "review", "annotate", "init"}),
})
_STATE_ID, _COMMANDS_ID = "inventory-state", "inventory-commands"


@dataclass
class OmpAdapter:
    bin: str = "omp"
    extra_env: dict[str, str] = field(default_factory=dict)
    plugin_marker: str = ".omp-plugin/plugin.json"
    name: str = "omp"
    isolation: str = "HOME, PI_CODING_AGENT_DIR, XDG_* and TMPDIR in the trial; cad via --plugin-dir; AWS credentials exported to env"
    baseline: Baseline = field(default_factory=lambda: BASELINE)

    def prepare(self, paths: TrialPaths, host: Host) -> None:
        paths.state.mkdir(parents=True, exist_ok=True)

    def _plugin_args(self, paths: TrialPaths) -> list[str]:
        return ["--plugin-dir", str(paths.plugin)] if (paths.plugin / self.plugin_marker).is_file() else []

    def command(self, *, model: str, prompt: str, paths: TrialPaths, resume: bool) -> list[str]:
        argv = [self.bin, "-p", "--model", model, "--mode", "json", "--no-title", "--auto-approve"]
        argv += self._plugin_args(paths)
        argv += ["--session-dir", str(paths.state)]
        if resume:
            argv.append("--continue")
        argv.append(prompt)
        return argv

    def env(self, paths: TrialPaths, host: Host) -> dict[str, str]:
        return {
            **host.base_env, **isolated_home(paths), **trial_temp(paths), **host.aws_env, **self.extra_env,
            "PI_CODING_AGENT_DIR": str(paths.home / ".omp" / "agent"), "NO_COLOR": "1",
        }

    def user_stores(self, host: Host) -> list[Path]:
        return []  # sessions go to --session-dir, everything else to the trial HOME

    def preflight(self, host: Host, ceiling_s: float) -> str | None:
        return None  # Bedrock credentials are re-exported per trial with margin (HostSource)

    def release_login(self, paths: TrialPaths) -> str | None:
        return None  # no login is copied into the trial

    def version_command(self) -> list[str]:
        return [self.bin, "--version"]  # `omp/18.12.3`

    def probe(self, paths: TrialPaths, model: str, stream_lines: list[str]) -> list[tuple[list[str], str]]:
        argv = [self.bin, "--mode", "rpc", "--no-session", "--model", model, *self._plugin_args(paths)]
        stdin = "".join(json.dumps(c) + "\n" for c in ({"id": _STATE_ID, "type": "get_state"}, {"id": _COMMANDS_ID, "type": "get_available_commands"}))
        return [(argv, stdin)]

    def complete(self, turn: Turn, lines: list[str], paths: TrialPaths, env: dict[str, str]) -> Turn:
        return turn

    def inventory(self, probe_outputs: list[str], stream_lines: list[str], paths: TrialPaths) -> Inventory:
        inv = Inventory()
        state = commands = None
        for event in json_lines("\n".join(probe_outputs).splitlines()):
            if event.get("type") == "response" and event.get("success"):
                if event.get("id") == _STATE_ID:
                    state = event.get("data") or {}
                elif event.get("id") == _COMMANDS_ID:
                    commands = (event.get("data") or {}).get("commands") or []
        if state is None or commands is None:
            return inv
        inv.observed = True
        prompt = "\n".join(state.get("systemPrompt") or [])
        inv.skills = _skills(prompt)
        inv.context = _context(prompt)
        inv.mcp = _mcp(prompt)
        task = next((t.get("description", "") for t in state.get("dumpTools") or [] if t.get("name") == "task"), "")
        inv.agents = re.findall(r"^- `([^`]+)`", task.split("# Available Agents", 1)[-1], re.MULTILINE) if task else []
        inv.commands = [c["name"] for c in commands if c.get("source") not in ("builtin", None)]
        return inv

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


def _block(prompt: str, tag: str) -> str | None:
    match = re.search(rf"<{tag}>(.*?)</{tag}>", prompt, re.DOTALL)
    return match.group(1) if match else None


def _skills(prompt: str) -> list[str]:
    block = _block(prompt, "skills") or ""
    return re.findall(r"^- ([^:\s]+):", block, re.MULTILINE)


def _context(prompt: str) -> list[str]:
    """Rules, project instruction files and memory; a clean trial has none."""
    found = []
    for tag in ("generic-rules", "domain-rules"):
        block = _block(prompt, tag)
        if block is not None:
            names = re.findall(r"^- ([\w.-]+) \(", block, re.MULTILINE)
            found += [f"rule:{n}" for n in names] or [f"rules:{tag}"]
    project = _block(prompt, "project-context") or ""
    for tag in set(re.findall(r"<([a-z][\w-]*)[\s>]", project)) - {"workstation"}:
        found.append(f"project-context:{tag}")
    found += [f"file:{p}" for p in re.findall(r'path="([^"]+)"', project)]
    if re.search(r"^# Memory$", prompt, re.MULTILINE):
        found.append("memory")
    return found


def _mcp(prompt: str) -> list[str]:
    if "## MCP Tool Routes" not in prompt and "## MCP Server Instructions" not in prompt:
        return []
    section = prompt.split("## MCP Server Instructions", 1)[-1]
    return re.findall(r"^### (\S+)", section, re.MULTILINE) or ["mcp"]


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
