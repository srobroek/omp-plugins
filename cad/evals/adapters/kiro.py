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

Isolation: HOME and the XDG roots point into the trial, so ~/.kiro (global agents,
steering, skills, memories, settings incl. the default agent, MCP config) does not
load. Kiro keeps its login in `~/Library/Application Support/kiro-cli`, which is
symlinked into the isolated HOME: auth and Kiro's session store are shared with
the user, configuration is not. The run is pinned to a sandbox-local agent
(`.kiro/agents/cad-eval.json`) whose only resources are the cad skills. The plugin
is copied to `<work>/cad/`, where the generated reviewer agents' relative
`skill://cad/skills/...` resources resolve. The inventory is read from the turn's
stream: active mode, available commands, context files, memory and MCP usage.
"""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass, field
from typing import Iterable

from .base import EVAL_AGENT, Host, Inventory, TrialPaths, Turn, add_usage, copy_tree, empty_usage, isolated_home, json_lines, tool_text

BUILTIN: dict[str, frozenset[str]] = {}
_APP_SUPPORT = ("Library", "Application Support", "kiro-cli")


@dataclass
class KiroAdapter:
    bin: str = "kiro-cli"
    trust_tools: str = ""
    extra_env: dict[str, str] = field(default_factory=dict)
    plugin_marker: str = "skills"
    name: str = "kiro"
    isolation: str = (
        "HOME and XDG_* in the trial with only Kiro's auth store symlinked in; --agent cad-eval"
        " (sandbox-local, cad skills only); cad copied to <work>/cad"
    )
    builtin: dict = field(default_factory=lambda: BUILTIN)

    def prepare(self, paths: TrialPaths, host: Host) -> None:
        # Kiro's login store, and the sibling executables kiro-cli launches from
        # $HOME/.local/bin, are linked in; nothing under ~/.kiro is.
        auth = host.real_home.joinpath(*_APP_SUPPORT)
        link = paths.home.joinpath(*_APP_SUPPORT)
        link.parent.mkdir(parents=True, exist_ok=True)
        if auth.is_dir():
            link.symlink_to(auth, target_is_directory=True)
        bin_dir = paths.home / ".local" / "bin"
        bin_dir.mkdir(parents=True, exist_ok=True)
        for exe in (host.real_home / ".local" / "bin").glob("kiro-cli*"):
            (bin_dir / exe.name).symlink_to(exe.resolve())
        local = paths.work / "cad"
        shutil.copytree(paths.plugin, local, dirs_exist_ok=True)
        agents = paths.work / ".kiro" / "agents"
        copy_tree(paths.plugin / "harness" / "kiro" / "agents", agents)
        agents.mkdir(parents=True, exist_ok=True)
        skills = sorted(p.parent for p in (local / "skills").glob("*/SKILL.md"))
        # CLI V3 format, checked with `kiro-cli agent list` ("(v3 format)"): a JSON
        # profile with `allowedTools` and no `permissions` is skipped as unconverted
        # 2.x config, and `toolsSettings` also demotes it, so access is granted only
        # through capability rules.
        (agents / f"{EVAL_AGENT}.json").write_text(json.dumps({
            "name": EVAL_AGENT,
            "description": "cad plugin eval agent: the cad skills and reviewer agents only.",
            "tools": ["read", "write", "shell", "subagent"],
            # `**/*` does not match the workspace root itself (List Directory on it
            # asked for approval and failed in --no-interactive), so the trial's own
            # paths are listed explicitly, under both /var and /private/var.
            "permissions": {"rules": [
                {"capability": "filesystem", "match": sorted({"**", f"{paths.root}/**", f"{paths.root.resolve()}/**",
                                                              str(paths.work), str(paths.work.resolve())}), "effect": "allow"},
                *({"capability": capability, "match": ["*"], "effect": "allow"} for capability in ("shell", "subagent", "skill")),
            ]},
            "resources": [f"skill://{p}/SKILL.md" for p in skills],
            "mcpServers": {},
            "includeMcpJson": False,
        }, indent=2) + "\n", encoding="utf-8")

    def command(self, *, model: str, prompt: str, paths: TrialPaths, resume: bool) -> list[str]:
        argv = [
            self.bin, "chat", "--no-interactive", "--agent-engine", "v3", "--model", model,
            "--output-format", "stream-json", f"--trust-tools={self.trust_tools}", "--trust-workspace",
            "--agent", EVAL_AGENT,
        ]
        if resume:
            argv.append("--resume")
        argv.append(prompt)
        return argv

    def env(self, paths: TrialPaths, host: Host) -> dict[str, str]:
        return {**host.base_env, **isolated_home(paths), **self.extra_env, "NO_COLOR": "1"}

    def probe(self, paths: TrialPaths, model: str, stream_lines: list[str]) -> list[tuple[list[str], str]]:
        return []  # the turn's own stream reports mode, commands and context files

    def complete(self, turn: Turn, lines: list[str], paths: TrialPaths, env: dict[str, str]) -> Turn:
        return turn

    def inventory(self, probe_outputs: list[str], stream_lines: list[str], paths: TrialPaths) -> Inventory:
        """The session's final state: the last mode and the last command list (earlier
        snapshots show Kiro's default agent before `--agent` applies), plus every
        context file, memory and MCP use seen during the turn."""
        inv = Inventory()
        mode: str | None = None
        commands: list[dict] = []
        for event in json_lines(stream_lines):
            if event.get("type") != "sessionUpdate":
                continue
            inv.observed = True
            update = (event.get("data") or {}).get("update") or {}
            sub = update.get("sessionUpdate")
            meta = (update.get("_meta") or {}).get("kiro") or {}
            if sub == "config_option_update":
                for option in update.get("configOptions") or []:
                    if option.get("id") == "mode" and option.get("currentValue"):
                        mode = option["currentValue"]
            elif sub == "available_commands_update":
                commands = update.get("availableCommands") or []
            elif sub == "session_info_update":
                breakdown = (meta.get("contextUsage") or {}).get("breakdown") or meta.get("breakdown") or {}
                for item in (breakdown.get("contextFiles") or {}).get("items") or []:
                    inv.context.append(item.get("uri") or item.get("name", ""))
                if ((breakdown.get("memory") or {}).get("tokens") or 0) > 0:
                    inv.context.append("memory")
                if (((breakdown.get("tools") or {}).get("mcp") or {}).get("tokens") or 0) > 0:
                    inv.mcp.append("mcp-tools")
                inv.context += [d for d in meta.get("steeringDocuments") or [] if isinstance(d, str)]
        if mode is not None:
            inv.agents.append(mode)
        for command in commands:
            kind = ((command.get("_meta") or {}).get("kiro") or {}).get("type")
            bucket = {"custom-agent": inv.agents, "skill": inv.skills}.get(kind, inv.commands)
            bucket.append(command.get("name", ""))
        if mode != EVAL_AGENT:
            inv.missing.append(f"agent:{EVAL_AGENT} not active (mode {mode})")
        return inv

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
