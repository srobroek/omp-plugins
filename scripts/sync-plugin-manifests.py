#!/usr/bin/env python3
"""Create the plugin skeleton: one directory per plugin with its `.omp-plugin/plugin.json`.

Run once. Re-running rewrites the manifests but never touches plugin content, so
it is safe as a drift check: `git diff` after a run shows hand-edits to name,
description, or category. `version` is preserved when a manifest already exists,
because release-please owns that field after the first release.
"""

from __future__ import annotations

import json
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
        "Quality gates: code-smell auditing, final verification, lint and docs adjudication, "
        "mechanical diff review, and browser-verification discipline.",
    ),
    "ops": ("devops", "Operational telemetry and toolchain cache policy: metrics reading and log digests."),
    "build": ("development", "Implementation agents: builder, high-effort builder, operator, external-repo worker."),
    "project": (
        "productivity",
        "Project lifecycle: brownfield onboarding, license selection, and user journeys.",
    ),
    "beads": ("productivity", "Beads issue tracking: dependency DAGs, formulas, and decisions recorded as beads."),
    "toolchain": ("development", "Toolchain defaults, tools-versus-scripts layout, and pragmatic output rules."),
    "safety": ("security", "Defence-in-depth advisories for destructive commands, attribution, and remote execution."),
    "chezmoi": ("productivity", "Edit chezmoi-managed dotfiles at their authoritative source."),
    "session": ("productivity", "Session continuity: recover prior work and hand over in-flight work."),
    # --- standalone plugins ---
    "find-tools": ("productivity", "Discover and vet skills, agents, MCP servers, and plugins across real registries."),
    "whats-new": ("productivity", "Research breaking changes, deprecations, and new features between two versions."),
    "dep-update": ("development", "Classify dependency updates by semver safety and produce a cited upgrade plan."),
    "eli5": ("productivity", "Explain a topic at five depth levels, from metaphor to frontier."),
    "debate": ("productivity", "Stress-test a decision from both sides before committing."),
}

UNPUBLISHED: set[str] = set()


def main() -> int:
    for name, (category, description) in PLUGINS.items():
        manifest_dir = REPO / name / ".omp-plugin"
        manifest_dir.mkdir(parents=True, exist_ok=True)
        manifest_path = manifest_dir / "plugin.json"

        version = "0.1.0"
        if manifest_path.exists():
            version = json.loads(manifest_path.read_text(encoding="utf-8")).get("version", version)

        manifest = {
            "name": name,
            "description": description,
            "version": version,
            "category": category,
        }
        if name in UNPUBLISHED:
            manifest["publish"] = False

        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

        # A `package.json` carrying an `omp` key is what makes the directory an OMP
        # extension package, and that is the only carrier whose sibling `rules/` and
        # `agents/` roots are discovered. Verified empirically on this estate:
        #
        #   marketplace install  -> skills load, rules and agents do NOT
        #   link, no `omp` key   -> `omp plugin doctor` reports "not an omp plugin"
        #   link, with `omp` key -> rules, agents, and skills all load
        #
        # The key may be empty for a plugin that ships no extension modules; it is a
        # marker, not a payload. Existing `omp.extensions` entries are preserved.
        package_path = REPO / name / "package.json"
        package = {}
        if package_path.exists():
            package = json.loads(package_path.read_text(encoding="utf-8"))
        package.update(
            {
                "name": f"@srobroek/{name}",
                "version": version,
                "description": description,
                "private": True,
            }
        )
        package.setdefault("omp", {})
        package_path.write_text(json.dumps(package, indent=2) + "\n", encoding="utf-8")

    print(f"wrote {len(PLUGINS)} plugin manifest(s) and package.json file(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
