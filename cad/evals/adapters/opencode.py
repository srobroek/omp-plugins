"""OpenCode adapter: `opencode run --model amazon-bedrock/<id> --format json`.

UNTESTED: OpenCode is not installed on the authoring machine; the event shapes
follow `packages/cli/src/run/noninteractive.ts` (JSONL `text`, `reasoning`,
`tool_use`, `step_start`, `step_finish`, `error`, each with a `part`). Token usage
and cost come from `step_finish.part.tokens`/`cost`. The served model is read from
any `modelID`/`providerID` the stream carries; when the stream carries none, the
runner records `model_unverified` in errors.jsonl instead of guessing.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Iterable

from .base import TrialPaths, Turn, add_usage, copy_tree, empty_usage, json_lines


@dataclass
class OpencodeAdapter:
    bin: str = "opencode"
    agent: str | None = None
    extra_env: dict[str, str] = field(default_factory=dict)
    plugin_marker: str = "skills"
    name: str = "opencode"

    def prepare(self, paths: TrialPaths) -> None:
        copy_tree(paths.plugin / "skills", paths.work / ".opencode" / "skills")
        copy_tree(paths.plugin / "harness" / "opencode" / "agents", paths.work / ".opencode" / "agents")

    def command(self, *, model: str, prompt: str, paths: TrialPaths, resume: bool) -> list[str]:
        argv = [self.bin, "run", "--model", model, "--format", "json", "--auto", "--dir", str(paths.work)]
        if self.agent:
            argv += ["--agent", self.agent]
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
