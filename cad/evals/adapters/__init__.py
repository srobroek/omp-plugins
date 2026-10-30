"""Harness adapters keyed by the matrix `[harness.<name>]` table."""

from __future__ import annotations

from .base import Adapter, Baseline, Host, Inventory, TrialPaths, Turn, audit, parse_version, served_matches
from .claude import ClaudeAdapter
from .kiro import KiroAdapter
from .omp import OmpAdapter
from .opencode import OpencodeAdapter

_FACTORIES = {
    "omp": lambda cfg: OmpAdapter(bin=cfg.get("bin", "omp"), extra_env=cfg.get("env", {})),
    "claude": lambda cfg: ClaudeAdapter(
        bin=cfg.get("bin", "claude"), bare=cfg.get("bare", False),
        setting_sources=cfg.get("setting_sources", "project,local"), extra_env=cfg.get("env", {}),
    ),
    "kiro": lambda cfg: KiroAdapter(bin=cfg.get("bin", "kiro-cli"), extra_env=cfg.get("env", {})),
    "opencode": lambda cfg: OpencodeAdapter(bin=cfg.get("bin", "opencode"), agent=cfg.get("agent"), extra_env=cfg.get("env", {})),
}

HARNESSES = tuple(_FACTORIES)


def build(harness: str, cfg: dict) -> Adapter:
    try:
        factory = _FACTORIES[harness]
    except KeyError:
        raise ValueError(f"unknown harness {harness!r}; expected one of {', '.join(HARNESSES)}") from None
    return factory(cfg)


__all__ = [
    "Adapter", "Baseline", "HARNESSES", "Host", "Inventory", "TrialPaths", "Turn", "audit", "build", "parse_version", "served_matches",
]
