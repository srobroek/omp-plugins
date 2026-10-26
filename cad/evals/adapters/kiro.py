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

Isolation: HOME, the XDG roots and TMPDIR point into the trial, so ~/.kiro (global
agents, steering, skills, memories, settings incl. the default agent, MCP config)
does not load, and V3 sessions (`~/.kiro/sessions`) and logs (`$TMPDIR/kiro-log`)
are written inside the trial. Kiro keeps its login in the same SQLite database as
its prompt history and runtime state (`~/Library/Application Support/kiro-cli/
data.sqlite3`); the trial gets its own database holding a read-only copy of the
login only (`copy_login`), so nothing a trial does is written to the user's store,
and Kiro extracts its agent runtime into the trial's copy of that directory. The
runner allows Kiro to refresh the copied token during a trial, notes whether the
copy changed, then deletes it even when a sandbox is kept. The kiro-cli executables
are linked in from the user's ~/.local/bin, and `user_stores` names their targets,
so the smoke sees an updater writing through a link. The run is pinned to a sandbox-local agent (`.kiro/agents/cad-eval.json`) whose only resources
are the cad skills. The plugin is copied to `<work>/cad/`, where the generated
reviewer agents' relative `skill://cad/skills/...` resources resolve. The inventory
is read from the turn's stream: active mode, available commands, context files,
memory and MCP usage.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from .base import (
    EVAL_AGENT, Baseline, Host, Inventory, TrialPaths, Turn, add_usage, copy_tree, empty_usage, isolated_home, json_lines,
    tool_text, trial_temp,
)

BASELINE = Baseline("2.34.0")  # the pinned agent's command list holds only what its config names
_APP_SUPPORT = ("Library", "Application Support", "kiro-cli")
_DB = "data.sqlite3"
# `state` keys that belong to the sign-in (IAM Identity Center start URL and region,
# the CodeWhisperer profile) and the migration marker; telemetry ids and UI
# counters stay behind.
_LOGIN_STATE = ("auth.", "api.", "migration.")
_TOKEN_KEY = "kirocli:odic:token"  # `auth_kv` row holding the OIDC access token


def _token(db: Path) -> str | None:
    if not db.is_file():
        return None
    con = sqlite3.connect(f"{db.as_uri()}?mode=ro", uri=True, timeout=30)
    try:
        row = con.execute("SELECT value FROM auth_kv WHERE key = ?", (_TOKEN_KEY,)).fetchone()
    except sqlite3.Error:
        return None
    finally:
        con.close()
    return row[0] if row else None


def _digest(value: str | bytes | None) -> str | None:
    if value is None:
        return None
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode()).hexdigest()



def copy_login(src: Path, dst: Path) -> None:
    """Create `dst` as a Kiro database holding only the login in `src`: the schema and
    migration record (so Kiro does not migrate again), `auth_kv` (the OIDC token and
    client registration) and the sign-in `state` keys. `src` is opened read-only."""
    source = sqlite3.connect(f"{src.as_uri()}?mode=ro", uri=True, timeout=30)
    try:
        schema = [sql for (sql,) in source.execute(
            "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type = 'index'")]

        rows = {table: source.execute(f"SELECT * FROM {table}").fetchall() for table in ("migrations", "auth_kv", "state")}
    finally:
        source.close()
    rows["state"] = [row for row in rows["state"] if row[0].startswith(_LOGIN_STATE)]
    target = sqlite3.connect(dst)
    try:
        with target:
            for sql in schema:
                target.execute(sql)
            for table, values in rows.items():
                if values:
                    target.executemany(f"INSERT INTO {table} VALUES ({', '.join('?' * len(values[0]))})", values)
    finally:
        target.close()


def _executables(real_home: Path) -> list[tuple[str, Path]]:
    """(name, resolved target) of each kiro-cli executable in the user's ~/.local/bin.
    prepare() links them into the trial, so a write through a link lands in the
    user's install; `user_stores` names the targets for the smoke to fingerprint."""
    return [(exe.name, exe.resolve()) for exe in sorted((real_home / ".local" / "bin").glob("kiro-cli*"))]


@dataclass
class KiroAdapter:
    bin: str = "kiro-cli"
    extra_env: dict[str, str] = field(default_factory=dict)
    plugin_marker: str = "skills"
    name: str = "kiro"
    isolation: str = (
        "HOME, XDG_* and TMPDIR in the trial; a trial-own Kiro database holding a copy of the user's login only;"
        " --agent cad-eval (sandbox-local, cad skills only); cad copied to <work>/cad"
    )
    baseline: Baseline = field(default_factory=lambda: BASELINE)
    # trial root -> SHA-256 of the token row prepare() copied in, until release_login
    _copied: dict[Path, str | None] = field(default_factory=dict, init=False, repr=False)

    def prepare(self, paths: TrialPaths, host: Host) -> None:
        # The login is copied, never linked; the sibling executables kiro-cli launches
        # from $HOME/.local/bin are linked in; nothing under ~/.kiro is.
        store = paths.home.joinpath(*_APP_SUPPORT)
        store.mkdir(parents=True)
        user_db = host.real_home.joinpath(*_APP_SUPPORT, _DB)
        if user_db.is_file():
            copy_login(user_db, store / _DB)
            self._copied[paths.root] = _digest(_token(store / _DB))
        bin_dir = paths.home / ".local" / "bin"
        bin_dir.mkdir(parents=True, exist_ok=True)
        for name, target in _executables(host.real_home):
            (bin_dir / name).symlink_to(target)
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
            "permissions": {"rules": [  # fs patterns need `**` to cross separators; shell/subagent/skill `*` matches all
                {"capability": "filesystem", "match": ["**"], "effect": "allow"},
                *({"capability": capability, "match": ["*"], "effect": "allow"} for capability in ("shell", "subagent", "skill")),
            ]},
            "resources": [f"skill://{p}/SKILL.md" for p in skills],
            "mcpServers": {},
            "includeMcpJson": False,
        }, indent=2) + "\n", encoding="utf-8")

    def command(self, *, model: str, prompt: str, paths: TrialPaths, resume: bool) -> list[str]:
        # Headless V3 treats every `ask` as a deny. The agent's allow rules did not
        # cover List Directory on the workspace root, and `--trust-tools` takes exact
        # V3 tool ids only, so the sandbox runs with every tool pre-approved, as the
        # other harnesses do (bypassPermissions, --auto-approve, --auto).
        argv = [
            self.bin, "chat", "--no-interactive", "--agent-engine", "v3", "--model", model,
            "--output-format", "stream-json", "--trust-all-tools", "--trust-workspace",
            "--agent", EVAL_AGENT,
        ]
        if resume:
            argv.append("--resume")
        argv.append(prompt)
        return argv

    def env(self, paths: TrialPaths, host: Host) -> dict[str, str]:
        return {**host.base_env, **isolated_home(paths), **trial_temp(paths), **self.extra_env, "NO_COLOR": "1"}

    def preflight(self, host: Host, ceiling_s: float) -> str | None:
        return None  # Kiro refreshes its own token inside its trial-local login copy.

    def user_stores(self, host: Host) -> list[Path]:
        return [host.real_home.joinpath(*_APP_SUPPORT), host.real_home / ".kiro",
                *(target for _, target in _executables(host.real_home))]

    def release_login(self, paths: TrialPaths) -> bool:
        """Return whether the copied token changed, then delete the copy even when kept."""
        if paths.root not in self._copied:
            return False
        copied = self._copied.pop(paths.root)
        db = paths.home.joinpath(*_APP_SUPPORT, _DB)
        refreshed = _digest(_token(db)) != copied
        for part in db.parent.glob(_DB + "*"):
            part.unlink(missing_ok=True)
        return refreshed

    def version_command(self) -> list[str]:
        return [self.bin, "--version"]  # `kiro-cli 2.34.0`

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
