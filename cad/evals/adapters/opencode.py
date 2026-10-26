"""OpenCode adapter: `opencode run --standalone --model amazon-bedrock/<id> --format json --auto`.

Verified against OpenCode v2.1.4. The stream is JSONL `step_start`, `tool_use`,
`text`, `reasoning`, `step_finish` and `error` events, each with a `part`; it
carries no model id and can end before the final `step_finish`. `complete()`
therefore reads the served model and token usage from the session's assistant
messages through the private server (`opencode api --standalone
session.message.list`), limited to the messages this turn's stream produced.

Isolation: HOME, the XDG roots and TMPDIR point into the trial, so
`~/.config/opencode` (global config, agents, plugins, MCP), `~/.claude/skills`,
`~/.agents/skills` and `~/.local/share/opencode` do not load, and the native
libraries the Bun-compiled binary extracts at startup (`.bun-<uid>-<hash>.*`)
land in the trial rather than the shared temp directory; `--standalone` starts a
private server with the trial's environment instead of the shared background
service; Bedrock credentials are exported to env. The cad skills and generated
agents are copied to `<work>/.opencode/`.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from .base import Baseline, Host, Inventory, TrialPaths, Turn, add_usage, copy_tree, empty_usage, isolated_home, json_lines, trial_temp

BASELINE = Baseline("2.1.4")  # skills and agents are read from disk, where OpenCode bundles none

# bun's global bin, where `bun add -g opencode-ai` installs it; not on the agent PATH.
BUN_GLOBAL_BIN = Path.home() / ".cache" / ".bun" / "bin" / "opencode"


def _runs(candidate: str) -> bool:
    try:
        return subprocess.run([candidate, "--version"], capture_output=True, timeout=30, check=False).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def resolve_bin(configured: str) -> str:
    """OPENCODE_BIN, then the configured name on PATH if it runs (a stale mise shim
    named `opencode` does not), then bun's global bin."""
    if os.environ.get("OPENCODE_BIN"):
        return os.environ["OPENCODE_BIN"]
    if shutil.which(configured) and _runs(configured):
        return configured
    return str(BUN_GLOBAL_BIN) if BUN_GLOBAL_BIN.is_file() else configured


def _json(text: str):
    try:
        return json.loads(text) if text and text.strip() else None
    except json.JSONDecodeError:
        return None


def _name(item) -> str:
    return item.get("name") or item.get("id") or json.dumps(item, sort_keys=True) if isinstance(item, dict) else str(item)


def _session_id(lines: list[str]) -> str | None:
    return next((e["sessionID"] for e in json_lines(lines) if isinstance(e.get("sessionID"), str)), None)


@dataclass
class OpencodeAdapter:
    bin: str = "opencode"
    agent: str | None = None
    extra_env: dict[str, str] = field(default_factory=dict)
    plugin_marker: str = "skills"
    name: str = "opencode"
    isolation: str = (
        "HOME, XDG_* and TMPDIR in the trial (temp OpenCode config/data/state); --standalone private server;"
        " cad skills and agents in <work>/.opencode; AWS credentials exported to env"
    )
    baseline: Baseline = field(default_factory=lambda: BASELINE)

    def __post_init__(self) -> None:
        self.bin = resolve_bin(self.bin)

    def prepare(self, paths: TrialPaths, host: Host) -> None:
        copy_tree(paths.plugin / "skills", paths.work / ".opencode" / "skills")
        copy_tree(paths.plugin / "harness" / "opencode" / "agents", paths.work / ".opencode" / "agents")

    def command(self, *, model: str, prompt: str, paths: TrialPaths, resume: bool) -> list[str]:
        # --standalone: a private server started with this trial's environment; the
        # default background service is shared across runs and would carry their state.
        argv = [self.bin, "run", "--standalone", "--model", model, "--format", "json", "--auto"]
        if self.agent:
            argv += ["--agent", self.agent]
        if resume:
            argv.append("--continue")
        argv.append(prompt)
        return argv

    def env(self, paths: TrialPaths, host: Host) -> dict[str, str]:
        return {**host.base_env, **isolated_home(paths), **trial_temp(paths), **host.aws_env, **self.extra_env, "NO_COLOR": "1"}

    def user_stores(self, host: Host) -> list[Path]:
        return []  # config, data and state all follow the trial's XDG roots

    def _api(self, *op: str) -> list[str]:
        return [self.bin, "api", "--standalone", *op]

    def probe(self, paths: TrialPaths, model: str, stream_lines: list[str]) -> list[tuple[list[str], str]]:
        session = _session_id(stream_lines)
        if session is None:
            return []
        return [
            (self._api("experimental.session.instructions.entry.list", "--param", f"sessionID={session}"), ""),
            (self._api("plugin.list"), ""),
            (self._api("mcp.list"), ""),
            (self._api("config.get"), ""),
        ]

    def inventory(self, probe_outputs: list[str], stream_lines: list[str], paths: TrialPaths) -> Inventory:
        """Instruction files the session loaded, plugins, MCP servers and config sources
        from the private server; skills and agents from OpenCode's documented discovery
        directories (the API's skill and agent lists stay empty in a standalone server,
        even for skills the model can see, so they cannot serve as evidence)."""
        inv = Inventory()
        instructions, plugins, mcp, config = (_json(o) for o in (list(probe_outputs) + [""] * 4)[:4])
        if not isinstance(instructions, dict) or not isinstance(instructions.get("data"), list):
            return inv
        inv.observed = True
        inv.context += [json.dumps(e, sort_keys=True) if not isinstance(e, str) else e for e in instructions["data"]]
        inv.plugins += [_name(p) for p in (plugins or {}).get("data", [])] if isinstance(plugins, dict) else ["plugin.list: no answer"]
        inv.mcp += [_name(m) for m in (mcp or {}).get("data", [])] if isinstance(mcp, dict) else ["mcp.list: no answer"]
        roots = (str(paths.root), str(paths.root.resolve()))
        for source in config if isinstance(config, list) else []:
            where = source.get("path", "") if isinstance(source, dict) else str(source)
            if not any(where.startswith(r) for r in roots):
                inv.context.append(f"config:{where}")
        home, work = paths.home, paths.work
        for base in (home / ".config" / "opencode", home / ".claude", home / ".agents", work / ".opencode", work / ".claude", work / ".agents"):
            for folder in ("skills", "skill"):
                inv.skills += [p.parent.name for p in (base / folder).glob("*/SKILL.md")]
        for base in (home / ".config" / "opencode", work / ".opencode"):
            for folder in ("agents", "agent"):
                inv.agents += [p.stem for p in (base / folder).glob("*.md")]
        return inv

    def complete(self, turn: Turn, lines: list[str], paths: TrialPaths, env: dict[str, str]) -> Turn:
        """`run --format json` carries no model id and can end before the last
        step_finish, so the served model and usage come from the session's own
        assistant messages, restricted to the messages this turn's stream produced."""
        session = _session_id(lines)
        seen = {(e.get("part") or {}).get("messageID") for e in json_lines(lines)} - {None}
        if session is None or not seen:
            return turn
        try:
            done = subprocess.run(self._api("session.message.list", "--param", f"sessionID={session}"), cwd=paths.work, env=env,
                                  capture_output=True, text=True, timeout=120, check=False)
        except (OSError, subprocess.TimeoutExpired):
            return turn
        messages = (_json(done.stdout) or {}).get("data") or []
        usage = empty_usage()
        for message in messages:
            if message.get("type") != "assistant" or message.get("id") not in seen:
                continue
            model = message.get("model") or {}
            if model.get("id"):
                turn.model = f"{model['providerID']}/{model['id']}" if model.get("providerID") else model["id"]
            tokens = message.get("tokens") or {}
            cache = tokens.get("cache") or {}
            usage = add_usage(usage, {
                "input": tokens.get("input", 0), "output": (tokens.get("output", 0) or 0) + (tokens.get("reasoning", 0) or 0),
                "cacheRead": cache.get("read", 0), "cacheWrite": cache.get("write", 0), "cost_usd": message.get("cost"),
            })
            if message.get("finish") == "length":
                turn.truncated = True
        if turn.model:
            turn.usage = usage
        return turn

    def parse(self, lines: Iterable[str]) -> Turn:
        turn = Turn()
        usage = empty_usage()
        for event in json_lines(lines):
            part = event.get("part") or {}
            kind = event.get("type")
            model = part.get("modelID") or event.get("modelID")
            if model:
                provider = part.get("providerID") or event.get("providerID")
                turn.model = f"{provider}/{model}" if provider else model
            if kind == "text":
                turn.text = part.get("text", "")
                turn.transcript.append({"role": "assistant", "content": turn.text})
            elif kind == "reasoning":
                turn.transcript.append({"role": "assistant", "content": "", "thinking": part.get("text", "")})
            elif kind == "tool_use":
                state = part.get("state") or {}
                name = part.get("tool", "")
                turn.tools.append(name)
                turn.transcript.append({"role": "tool_call", "name": name, "content": json.dumps(state.get("input", {}), sort_keys=True)})
                turn.transcript.append({"role": "tool_result", "name": name, "content": str(state.get("output", ""))})
            elif kind == "step_finish":
                tokens = part.get("tokens") or {}
                cache = tokens.get("cache") or {}
                step = {
                    "input": tokens.get("input", 0),
                    "output": (tokens.get("output", 0) or 0) + (tokens.get("reasoning", 0) or 0),
                    "cacheRead": cache.get("read", 0),
                    "cacheWrite": cache.get("write", 0),
                }
                if part.get("cost") is not None:
                    step["cost_usd"] = part["cost"]
                usage = add_usage(usage, step)
                if part.get("reason") == "length":
                    turn.truncated = True
            elif kind == "error":
                err = event.get("error") or part.get("error") or {}
                if isinstance(err, dict):
                    message = (err.get("data") or {}).get("message") or err.get("name")
                else:
                    message = str(err)
                turn.error = message or "opencode error event"
        turn.usage = usage
        return turn
