#!/usr/bin/env python3
"""Check every plugin's capability files against the contracts OMP actually enforces.

These are the failure modes that are SILENT at runtime rather than loud:

- A rule with no `description`, no `alwaysApply: true`, and no `condition` lands in no
  bucket: it is discovered, unaddressable, and never injected.
- Rule identity comes from the FILENAME for the native and omp-plugins providers, so a
  frontmatter `name` that disagrees with the stem is a lie the tooling will not catch.
- Frontmatter arrays must be single-line flow YAML; the fallback line parser cannot
  reconstruct a multiline sequence, and the metadata is dropped.
- Agent and skill identity is the bare `name` with first-wins dedup across every source,
  so re-shipping a bundled agent name silently shadows the bundled definition.
- A leftover `<skill-dir>` or `apm_modules` path is a dead link: the first is APM's
  placeholder, the second points into a module tree this migration deletes.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# Bundled agents. Shipping one of these names shadows the bundled definition.
BUNDLED_AGENTS = {"scout", "designer", "reviewer", "security-reviewer", "librarian", "task", "sonic"}

# The configured roles. An agent model must name one of these, never a raw selector.
ROLES = {
    "default", "slow", "plan", "architect", "designer", "coder", "vision", "task",
    "fast-coder", "advisor", "challenger", "smol", "commit", "tiny",
}

NOT_A_PLUGIN = {"scripts", "examples"}


def split_frontmatter(path: Path) -> tuple[dict[str, str], str] | None:
    """Return (frontmatter lines as key->raw value, body), or None when absent."""
    text = path.read_text(encoding="utf-8", errors="replace")
    if not text.startswith("---"):
        return None
    end = text.find("\n---", 3)
    if end == -1:
        return None
    fields: dict[str, str] = {}
    for line in text[3:end].splitlines():
        match = re.match(r"^([\w-]+):\s*(.*)$", line)
        if match:
            fields[match.group(1)] = match.group(2).strip()
    return fields, text[end + 4 :]


def plugin_dirs() -> list[Path]:
    return [
        p
        for p in sorted(REPO.iterdir())
        if p.is_dir() and not p.name.startswith(".") and p.name not in NOT_A_PLUGIN
    ]


def check_rule(path: Path, plugin: str, fail: list[str]) -> str | None:
    """Validate one rule file; return its name when it is a usable non-index rule."""
    parsed = split_frontmatter(path)
    if parsed is None:
        fail.append(f"{path}: no frontmatter, so the rule lands in no bucket")
        return None
    fields, _ = parsed
    stem = path.stem

    name = fields.get("name")
    if name != stem:
        fail.append(f"{path}: frontmatter name {name!r} != filename stem {stem!r} (identity is the filename)")
    if not stem.startswith(f"{plugin}-") and not stem.startswith("srobroek-"):
        fail.append(f"{path}: filename is not plugin-prefixed, so it can collide across plugins")

    always = fields.get("alwaysApply", "").lower() == "true"
    described = bool(fields.get("description"))
    triggered = bool(fields.get("condition") or fields.get("astCondition"))
    if not (always or described or triggered):
        fail.append(f"{path}: no description, no alwaysApply, no condition -> unaddressable")

    for key in ("globs", "scope"):
        raw = fields.get(key)
        if raw is not None and raw == "":
            fail.append(f"{path}: `{key}:` is empty, which the fallback parser drops (use flow YAML)")

    if stem == f"{plugin}-index":
        # OMP natively renders every rulebook rule as `- name (globs): description`
        # in the system prompt's domain-rules block, so an always-apply index that
        # lists the same rules is injected twice: pure token waste. Verified live.
        fail.append(f"{path}: always-apply index duplicates the native domain-rules listing; delete it")
        return None
    return stem


def check_agent(path: Path, fail: list[str]) -> str | None:
    parsed = split_frontmatter(path)
    if parsed is None:
        fail.append(f"{path}: no frontmatter, so the agent fails to parse and is skipped")
        return None
    fields, _ = parsed

    name = fields.get("name")
    if not name:
        fail.append(f"{path}: missing required `name`")
    if not fields.get("description"):
        fail.append(f"{path}: missing required `description`")
    if name and name != path.stem:
        fail.append(f"{path}: frontmatter name {name!r} != filename stem {path.stem!r}")
    if name in BUNDLED_AGENTS:
        fail.append(f"{path}: name {name!r} shadows a bundled agent")
    if "permissionMode" in fields:
        fail.append(f"{path}: `permissionMode` has no OMP equivalent; express it as a `tools` allowlist")

    model = fields.get("model", "").strip().strip('"').strip("'")
    if model:
        if not model.startswith("@"):
            fail.append(f"{path}: model {model!r} is a raw selector; name a role as \"@<role>\"")
        elif model[1:].split(":")[0] not in ROLES:
            fail.append(f"{path}: model {model!r} names no configured role")
    return name


def check_skill(path: Path, fail: list[str]) -> str | None:
    parsed = split_frontmatter(path)
    if parsed is None:
        fail.append(f"{path}: no frontmatter, so the skill is not discoverable")
        return None
    fields, _ = parsed
    name = fields.get("name")
    if not name:
        fail.append(f"{path}: missing required `name`")
    if not fields.get("description"):
        fail.append(f"{path}: missing required `description`")
    if name and name != path.parent.name:
        fail.append(f"{path}: frontmatter name {name!r} != directory {path.parent.name!r}")
    return name


def main() -> int:
    fail: list[str] = []
    counts = {"plugins": 0, "rules": 0, "agents": 0, "skills": 0}
    seen: dict[tuple[str, str], list[str]] = {}

    for plugin in plugin_dirs():
        counts["plugins"] += 1
        name = plugin.name

        if not (plugin / ".omp-plugin" / "plugin.json").is_file():
            fail.append(f"{name}: missing .omp-plugin/plugin.json")
        if not (plugin / "README.md").is_file():
            fail.append(f"{name}: missing README.md")

        for path in sorted(plugin.glob("rules/*.md")):
            counts["rules"] += 1
            got = check_rule(path, name, fail)
            if got:
                seen.setdefault(("rule", got), []).append(str(path.relative_to(REPO)))

        for path in sorted(plugin.glob("agents/*.md")):
            counts["agents"] += 1
            got = check_agent(path, fail)
            if got:
                seen.setdefault(("agent", got), []).append(str(path.relative_to(REPO)))

        for path in sorted(plugin.glob("skills/*/SKILL.md")):
            counts["skills"] += 1
            got = check_skill(path, fail)
            if got:
                seen.setdefault(("skill", got), []).append(str(path.relative_to(REPO)))

    for (kind, capability), paths in sorted(seen.items()):
        if len(paths) > 1:
            fail.append(f"duplicate {kind} name {capability!r}: {', '.join(paths)}")

    # A dead APM link, not a mention. `apm_modules/` legitimately appears in audit
    # exclusion lists, so only flag it when it sits inside a path or link target.
    dead_link = re.compile(r"\]\([^)]*apm_modules|\.apm/apm_modules|\.\./[^\s)]*apm_modules")
    for path in REPO.rglob("*.md"):
        if ".git" in path.parts:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        if "<skill-dir>" in text:
            fail.append(f"{path.relative_to(REPO)}: unrewritten <skill-dir> reference")
        if dead_link.search(text):
            fail.append(f"{path.relative_to(REPO)}: dead apm_modules link target")

    print(
        f"checked {counts['plugins']} plugins: "
        f"{counts['rules']} rules, {counts['agents']} agents, {counts['skills']} skills"
    )
    if fail:
        for line in fail:
            print(f"  FAIL {line}")
        print(f"FAIL: {len(fail)} problem(s)")
        return 1
    print("PASS: every capability satisfies the discovery contract")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
