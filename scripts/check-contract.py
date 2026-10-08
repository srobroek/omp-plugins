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

# Bundled agents are `EMBEDDED_AGENT_DEFS` in the pinned host's `src/task/agents.ts`, read
# from the `@oh-my-pi/pi-coding-agent` that `bun install` puts in node_modules. Shipping one
# of these names shadows the bundled definition. The literal set is OMP 18.8.4's and is used,
# with a warning, only when the host source is missing or no longer parses.
HOST_AGENTS = REPO / "node_modules/@oh-my-pi/pi-coding-agent/src/task/agents.ts"
FALLBACK_BUNDLED_AGENTS = frozenset({"scout", "reviewer", "security-reviewer", "task", "sonic"})

# The configured roles. An agent model must name one of these, never a raw selector.
ROLES = {
    "default", "slow", "plan", "architect", "designer", "reviewer", "vision", "task",
    "advisor", "challenger", "smol", "commit", "tiny",
}

# `node_modules` is created by OMP itself the first time it runs in this repository, and it
# is gitignored, so treating it as a plugin fails the gate on a clean tree. `ci` holds the
# full-estate census fixtures (#419), not a plugin.
NOT_A_PLUGIN = {"scripts", "examples", "node_modules", "ci"}


def top_level_objects(body: str) -> list[str]:
    """Split an array literal's body into its top-level `{...}` objects."""
    objects: list[str] = []
    depth = start = 0
    for index, char in enumerate(body):
        if char == "{":
            if depth == 0:
                start = index
            depth += 1
        elif char == "}":
            depth -= 1
            if depth < 0:
                raise ValueError("unbalanced braces")
            if depth == 0:
                objects.append(body[start : index + 1])
    if depth:
        raise ValueError("unbalanced braces")
    return objects


def host_bundled_agents() -> frozenset[str]:
    """Every name in the host's `EMBEDDED_AGENT_DEFS`; raises when it cannot be read.

    An entry names itself in an inline `frontmatter`, or else in the frontmatter of the
    markdown its `template` identifier is imported from.
    """
    text = HOST_AGENTS.read_text(encoding="utf-8")
    block = re.search(r"\bEMBEDDED_AGENT_DEFS\b[^=]*=\s*\[(.*?)^\];", text, re.S | re.M)
    if block is None:
        raise ValueError("no `EMBEDDED_AGENT_DEFS = [...]` array")
    imports = dict(re.findall(r'^import\s+(\w+)\s+from\s+"([^"]+\.md)"', text, re.M))
    names: set[str] = set()
    entries = top_level_objects(block.group(1))
    for entry in entries:
        inline = re.search(r'\bfrontmatter:\s*\{[^}]*?\bname:\s*"([^"]+)"', entry, re.S)
        if inline:
            names.add(inline.group(1))
            continue
        template = re.search(r"\btemplate:\s*(\w+)", entry)
        source = imports.get(template.group(1)) if template else None
        parsed = split_frontmatter(HOST_AGENTS.parent / source) if source else None
        name = parsed[0].get("name", "").strip().strip("'\"") if parsed else ""
        if not name:
            raise ValueError(f"no agent name in entry {' '.join(entry.split())[:80]!r}")
        names.add(name)
    if not entries:
        raise ValueError("`EMBEDDED_AGENT_DEFS` has no entries")
    return frozenset(names)


def bundled_agents() -> frozenset[str]:
    try:
        return host_bundled_agents()
    except (OSError, ValueError) as error:
        print(
            f"WARN cannot read bundled agents from {HOST_AGENTS.relative_to(REPO)} ({error}); "
            f"falling back to {sorted(FALLBACK_BUNDLED_AGENTS)}. Run `bun install` to check "
            "against the pinned host.",
            file=sys.stderr,
        )
        return FALLBACK_BUNDLED_AGENTS


def split_frontmatter(path: Path) -> tuple[dict[str, str], str] | None:
    """Return (frontmatter lines as key->raw value, body), or None when absent."""
    text = path.read_text(encoding="utf-8", errors="replace")
    opening = re.match(r"\A---[ \t]*\r?\n", text)
    if opening is None:
        return None
    closing = re.search(r"^---[ \t]*(?:\r?\n|$)", text[opening.end():], re.MULTILINE)
    if closing is None:
        return None
    end = opening.end() + closing.start()
    fields: dict[str, str] = {}
    for line in text[opening.end():end].splitlines():
        match = re.match(r"^([\w-]+):\s*(.*)$", line)
        if match:
            fields[match.group(1)] = match.group(2).strip()
    return fields, text[opening.end() + closing.end():]


def plugin_dirs() -> list[Path]:
    return [
        p
        for p in sorted(REPO.iterdir())
        if p.is_dir() and not p.name.startswith(".") and p.name not in NOT_A_PLUGIN
    ]


# Rules adopted from rolled-up plugins keep their historical names: rule identity is
# the filename, and renaming would break every rule:// reference and shadow record.
# The names stay globally unique, which is the real invariant. New rules in the
# owning plugin still take that plugin's prefix.
ADOPTED_PREFIXES = {
	"toolchain": ("coexistence-", "shell-", "terraform-", "infrastructure-", "backend-", "ops-"),
}

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
    allowed = (f"{plugin}-", "srobroek-", *ADOPTED_PREFIXES.get(plugin, ()))
    if not stem.startswith(allowed):
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


def check_agent(path: Path, bundled: frozenset[str], fail: list[str]) -> str | None:
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
    if name in bundled:
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
    bundled = bundled_agents()

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
            got = check_agent(path, bundled, fail)
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
