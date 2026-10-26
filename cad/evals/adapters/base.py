"""Shared adapter types: one harness turn in, one parsed `Turn` out.

An adapter knows three things about its harness: how to install the plugin into a
fresh trial, the exact non-interactive argv for a first or continued turn, and how
to read the served model, usage, final text and transcript out of its stream.
Process execution, timeouts and retries belong to the runner, not the adapter.
"""

from __future__ import annotations

import json
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Protocol

# Usage keys follow OMP's own naming because the ratchet host is OMP.
USAGE_KEYS = ("input", "output", "cacheRead", "cacheWrite")
# Harness-reported spend, summed when present: `cost_usd` (OMP, Claude Code,
# OpenCode) and `credits` (Kiro, which reports no token counts).
SPEND_KEYS = ("cost_usd", "credits")


def empty_usage() -> dict:
    return {key: 0 for key in USAGE_KEYS}


def add_usage(total: dict, part: dict) -> dict:
    """Sum token counters, and spend fields only when a harness reports them."""
    out = dict(total)
    for key in USAGE_KEYS:
        out[key] = int(out.get(key, 0)) + int(part.get(key, 0) or 0)
    for key in SPEND_KEYS:
        if part.get(key) is not None:
            out[key] = round(float(out.get(key, 0.0)) + float(part[key]), 6)
    return out


@dataclass
class Turn:
    """What one harness invocation produced, read from its own stream."""

    text: str = ""
    model: str | None = None
    usage: dict = field(default_factory=empty_usage)
    transcript: list[dict] = field(default_factory=list)
    error: str | None = None
    truncated: bool = False
    tools: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class TrialPaths:
    """Per-trial directories. `work` is the sandbox the model under test sees."""

    root: Path
    work: Path
    plugin: Path  # staged copy of the plugin, evals/ excluded
    state: Path  # harness session/state directory, inside the trial root


class Adapter(Protocol):
    name: str
    plugin_marker: str  # plugin-root-relative path whose presence means the plugin can load

    def prepare(self, paths: TrialPaths) -> None: ...

    def command(self, *, model: str, prompt: str, paths: TrialPaths, resume: bool) -> list[str]: ...

    def env(self, paths: TrialPaths) -> dict[str, str]: ...

    def parse(self, lines: Iterable[str]) -> Turn: ...


def json_lines(lines: Iterable[str]) -> Iterable[dict]:
    """Yield JSON objects from a stream, skipping blank or non-JSON lines (banners)."""
    for raw in lines:
        raw = raw.strip()
        if not raw.startswith("{"):
            continue
        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            yield value


def copy_tree(src: Path, dst: Path) -> None:
    if src.is_dir():
        shutil.copytree(src, dst, dirs_exist_ok=True)


def tool_text(content) -> str:
    """Flatten a tool-result payload (string, block list or object) to text."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(tool_text(item) for item in content)
    if isinstance(content, dict):
        if isinstance(content.get("text"), str):
            return content["text"]
        if "content" in content:
            return tool_text(content["content"])
    return json.dumps(content, sort_keys=True)


_SUFFIX = re.compile(r"(-\d{8})?(-v\d+(-\d+)?)?")
_REGION = re.compile(r"^(global|us|eu|apac|jp|au|ca)\.")
_VENDOR = re.compile(r"^[a-z][a-z0-9]*\.(?=[a-z])")


def _norm(model: str) -> str:
    """Provider, Bedrock region and vendor prefixes off; separators unified.

    `amazon-bedrock/global.anthropic.claude-opus-5-5`, `claude-opus-5.5` and
    Claude Code's `claude-opus-5-5` all normalise to `claude-opus-5-5`.
    """
    model = model.strip().lower().rsplit("/", 1)[-1]
    model = _VENDOR.sub("", _REGION.sub("", model))
    return re.sub(r"[._:]", "-", model)


def served_matches(requested: str, served: str | None, expect: str | None = None) -> bool:
    """True when the served model is the requested one.

    `expect` is an explicit regex from the matrix. Without it, both ids are
    normalised and the served id must equal the requested one, optionally followed
    by a date or `-vN` suffix, so `claude-opus-5` never matches `claude-opus-5-5`.
    """
    if not served:
        return False
    if expect:
        return re.search(expect, served) is not None
    want, got = _norm(requested), _norm(served)
    return got.startswith(want) and _SUFFIX.fullmatch(got[len(want):]) is not None
