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
    plugin: Path  # staged copy of the plugin (directory named `cad`), evals/ excluded
    state: Path  # harness session/state directory, inside the trial root
    home: Path  # isolated HOME / config root the harness reads instead of the user's

    @property
    def tmp(self) -> Path:
        """The trial's TMPDIR, removed with the trial root."""
        return self.root / "tmp"


@dataclass(frozen=True)
class Host:
    """What a trial may take from the host. Nothing else of the user's environment
    reaches the harness: adapters build the child environment from this alone."""

    base_env: dict[str, str]  # allowlisted variables: PATH, locale, user, toolchain caches
    aws_env: dict[str, str]  # short-lived Bedrock credentials exported from the host profile
    real_home: Path


def isolated_home(paths: TrialPaths) -> dict[str, str]:
    """HOME and the XDG roots pointed into the trial, so no user-level config loads."""
    home = paths.home
    return {
        "HOME": str(home),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_DATA_HOME": str(home / ".local" / "share"),
        "XDG_CACHE_HOME": str(home / ".cache"),
        "XDG_STATE_HOME": str(home / ".local" / "state"),
    }


def trial_temp(paths: TrialPaths) -> dict[str, str]:
    """TMPDIR, TMP and TEMP pointed into the trial, so a harness's temp files (Bun's
    extracted native libraries, logs, shell scratch) neither land in nor are read
    from the shared temp directory. Every adapter's environment includes these."""
    return {var: str(paths.tmp) for var in ("TMPDIR", "TMP", "TEMP")}


CATEGORIES = ("plugins", "skills", "agents", "commands", "context", "mcp")
EVAL_AGENT = "cad-eval"  # the sandbox-local agent a harness is pinned to, where it needs one


@dataclass(frozen=True)
class Baseline:
    """What a harness bundles that no supported setting turns off, observed in a clean
    run of one harness version. Rows may load these items; a run that reports another
    version is not covered by the declaration and counts as a leak."""

    version: str
    items: dict[str, frozenset[str]] = field(default_factory=dict)


@dataclass
class Inventory:
    """Components a harness loaded for one trial, as the harness itself reports them."""

    plugins: list[str] = field(default_factory=list)
    skills: list[str] = field(default_factory=list)
    agents: list[str] = field(default_factory=list)
    commands: list[str] = field(default_factory=list)
    context: list[str] = field(default_factory=list)  # instruction files, steering, rules, memory
    mcp: list[str] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)  # capabilities cad needs that the harness withheld
    version: str | None = None  # the harness version, when the harness reports it
    observed: bool = False  # the harness reported its components; False means nothing to verify

    def as_dict(self) -> dict[str, list[str]]:
        return {cat: sorted(set(getattr(self, cat))) for cat in (*CATEGORIES, "missing")}


def cad_allowlist(plugin: Path) -> dict[str, set[str]]:
    skills = {p.name for p in (plugin / "skills").glob("*") if (p / "SKILL.md").is_file()}
    agents = {p.stem for p in (plugin / "agents").glob("*.md")} | {EVAL_AGENT}
    return {"plugins": {"cad"}, "skills": skills, "agents": agents, "commands": skills | agents}


def _bare(name: str) -> str:
    name = name.strip().lstrip("/")
    for prefix in ("skill:", "cad:"):
        if name.startswith(prefix):
            name = name[len(prefix):]
    return name


def audit(inventory: Inventory, paths: TrialPaths, baseline: Baseline) -> tuple[list[str], dict[str, list[str]]]:
    """(leaks, bundled). Leaks: every loaded component that is neither the cad plugin
    nor in the harness's baseline, every capability cad needs that is missing, and a
    baseline used under a harness version it was not declared for. Instruction files
    pass only when they are the cad plugin's own (the staged copy or `<work>/cad`).
    Bundled: the baseline items this run loaded, by category. Fails closed: an
    unobserved inventory leaks."""
    if not inventory.observed:
        return ["inventory: the harness reported no loaded components to verify"], {}
    allow = cad_allowlist(paths.plugin)
    cad_dirs = {str(p) for d in (paths.plugin, paths.work / "cad") for p in (d, d.resolve())}
    found: set[str] = set()
    bundled: dict[str, set[str]] = {}
    for cat in CATEGORIES:
        for item in getattr(inventory, cat):
            bare = _bare(item)
            if bare in allow.get(cat, ()):
                continue
            if bare in baseline.items.get(cat, ()):
                bundled.setdefault(cat, set()).add(item)
                continue
            if cat == "context" and any(d + "/" in item for d in cad_dirs):
                continue
            found.add(f"{cat}:{item}")
    found.update(f"missing:{m}" for m in inventory.missing)
    if bundled and inventory.version is not None and inventory.version != baseline.version:
        found.add(f"baseline: declared for {baseline.version}, the harness reports {inventory.version}")
    return sorted(found), {cat: sorted(items) for cat, items in sorted(bundled.items())}


class Adapter(Protocol):
    name: str
    plugin_marker: str  # plugin-root-relative path whose presence means the plugin can load
    isolation: str  # one line: how ambient user config is kept out
    baseline: Baseline  # what the harness bundles and no supported setting removes

    def prepare(self, paths: TrialPaths, host: Host) -> None: ...

    def command(self, *, model: str, prompt: str, paths: TrialPaths, resume: bool) -> list[str]: ...

    def env(self, paths: TrialPaths, host: Host) -> dict[str, str]:
        """The complete child environment, `trial_temp` included; nothing else is inherited."""

    def user_stores(self, host: Host) -> list[Path]:
        """User-level state the harness keeps outside its config (login, sessions,
        history) that a trial must leave untouched; the smoke fingerprints it."""

    def probe(self, paths: TrialPaths, model: str, stream_lines: list[str]) -> list[tuple[list[str], str]]:
        """Model-free commands (argv, stdin), run after the trial's first turn, whose
        stdout reports loaded components; [] when the turn's own stream reports them."""

    def inventory(self, probe_outputs: list[str], stream_lines: list[str], paths: TrialPaths) -> Inventory:
        """`probe_outputs` holds one stdout per probe command, in order ('' if it failed)."""

    def parse(self, lines: Iterable[str]) -> Turn: ...

    def complete(self, turn: Turn, lines: list[str], paths: TrialPaths, env: dict[str, str]) -> Turn:
        """Fill what the stream lacks from the harness's own model-free record (OpenCode:
        served model and usage from the session store). Most adapters return `turn`."""


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
