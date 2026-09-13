#!/usr/bin/env python3
"""Synchronize generated manifest fields while preserving plugin-owned metadata.

`--check` compares generated artifacts without creating or modifying files.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# name -> (category, description). The description is a retrieval key, not a summary:
# rulebook and skill discovery rest entirely on it.
PLUGINS: dict[str, tuple[str, str]] = {
    # --- language plugins ---
    "go": ("language", "Go rules: module layout, error wrapping, table-driven tests, and a Go review skill."),
    "python": ("language", "Python rules: uv-managed projects, typing, pytest layout, and a Python review skill."),
    "rust": (
        "language",
        "Rust rules: crate boundaries, domain modeling, error and persistence patterns, "
        "workspace and Tauri layout, and a Rust review skill.",
    ),
    "typescript": (
        "language",
        "TypeScript rules: contract boundaries, type safety and validation, component layout, "
        "build tooling, testing, and a TypeScript review skill.",
    ),
    # --- topic plugins ---
    "backend": ("development", "Backend rules: API contracts, background jobs, and service boundaries."),
    "infrastructure": ("devops", "Infrastructure rules for provisioning, environments, and operational surface."),
    "architecture": (
        "development",
        "Architecture rules: module boundaries, compose-don't-fork, project structure, "
        "component promotion, and structural-search routing.",
    ),
    "delivery": ("devops", "Delivery and git-workflow rules, plus a pull-request review agent."),
    "authoring": ("productivity", "Author and audit agentic assets: skills, rules, agents, and steering."),
    "quality": (
        "development",
        "Quality gates for final verification, lint and docs adjudication, "
        "and browser-verification discipline.",
    ),
    "ops": ("devops", "Operational telemetry and toolchain cache policy: metrics reading and log digests."),
    "build": ("development", "Execution agents: operator and external-repo worker."),
    "project": (
        "productivity",
        "Project lifecycle: brownfield onboarding, license selection, and user journeys.",
    ),
    "speckit": (
        "development",
        "SpecKit workflow: spec-driven setup, bugfix flow, tasks.md protection, and PR title discipline.",
    ),
    "beads": ("productivity", "Beads issue tracking: dependency DAGs, formulas, and decisions recorded as beads."),
    "toolchain": ("development", "Toolchain defaults, tools-versus-scripts layout, and pragmatic output rules."),
    "safety": ("security", "Defence-in-depth advisories for destructive commands, attribution, and remote execution."),
    "chezmoi": ("productivity", "Edit chezmoi-managed dotfiles at their authoritative source."),
    # --- standalone plugins ---
    "find-tools": ("productivity", "Discover and vet skills, agents, MCP servers, and plugins across real registries."),
    "whats-new": ("productivity", "Research breaking changes, deprecations, and new features between two versions."),
    "dep-update": ("development", "Classify dependency updates by semver safety and produce a cited upgrade plan."),
    "eli5": ("productivity", "Explain a topic at five depth levels, from metaphor to frontier."),
    "debate": ("productivity", "Stress-test a decision from both sides before committing."),
    "session": ("productivity", "Create a selective fresh-session handoff from a prior OMP transcript without replaying its full history."),
    "design": (
        "development",
        "UI and UX design: system audit, DESIGN.md, browser verification, accessibility, tokens, and Component Driven build.",
    ),
    "browser-tools": ("development", "Cross-engine browser coverage and Chrome performance tracing over MCP."),
    "diagram": ("productivity", "Interactive diagramming and architecture-sketching canvas over MCP."),
}

# Keep this set for any temporarily unpublished plugins.
UNPUBLISHED: set[str] = set()

def load_object(path: Path) -> dict[str, object]:
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as err:
        raise ValueError(f"{path}: invalid JSON: {err}") from err
    if not isinstance(value, dict):
        raise ValueError(f"{path}: expected a JSON object")
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="verify generated manifests and linked MCP configs without writing")
    args = parser.parse_args()
    problems: list[str] = []
    discovered = {
        path.parent.parent.name for path in REPO.glob("*/.omp-plugin/plugin.json")
    } | {path.parent.name for path in REPO.glob("*/package.json")}
    unregistered = discovered - set(PLUGINS)
    if unregistered:
        print(f"FAIL: unregistered plugin directories: {sorted(unregistered)}", file=sys.stderr)
        return 1
    for name, (category, description) in PLUGINS.items():
        manifest_path = REPO / name / ".omp-plugin" / "plugin.json"
        package_path = REPO / name / "package.json"
        try:
            manifest = load_object(manifest_path)
            package = load_object(package_path)
            version = manifest.get("version", "0.1.0")
            if not isinstance(version, str) or not version.strip():
                raise ValueError(f"{manifest_path}: version must be a non-empty string")
            manifest.update(
                name=name, description=description, version=version, category=category,
            )
            if name in UNPUBLISHED:
                manifest["publish"] = False
            else:
                manifest.pop("publish", None)

            # The omp marker enables component discovery for marketplace and link installs.
            package.update(
                name=f"@srobroek/{name}", version=version,
                description=description, private=True,
            )
            package.setdefault("omp", {})
            if not isinstance(package["omp"], dict):
                raise ValueError(f"{package_path}: omp must be an object")
            artifacts = [(manifest_path, manifest), (package_path, package)]
            if "mcpServers" in manifest:
                servers = manifest["mcpServers"]
                if not isinstance(servers, dict):
                    raise ValueError(f"{manifest_path}: mcpServers must be an object")
                artifacts.append((REPO / name / ".mcp.json", {"mcpServers": servers}))
            for path, value in artifacts:
                expected = json.dumps(value, indent=2) + "\n"
                if args.check:
                    if not path.is_file() or path.read_text(encoding="utf-8") != expected:
                        problems.append(f"{path.relative_to(REPO)}: missing or stale")
                else:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(expected, encoding="utf-8")
        except (ValueError, OSError) as err:
            problems.append(str(err))
    if problems:
        for problem in problems:
            print(f"FAIL: {problem}", file=sys.stderr)
        return 1
    print(f"{'PASS: checked' if args.check else 'wrote'} {len(PLUGINS)} plugin manifests and packages, plus declared linked MCP configs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
