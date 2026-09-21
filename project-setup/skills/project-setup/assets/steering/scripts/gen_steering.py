#!/usr/bin/env python3
"""Generate docs/agents/ from what is on disk.

    gen_steering.py <dest> [--check]

A pure function of the tree. No prompts and no network, so CI can verify it: `--check`
regenerates in memory and exits 1 when a file on disk differs, naming the command that
fixes it.

Only the content between markers is written:

    <!-- BEGIN GENERATED: quality-rust -->
    <!-- END GENERATED: quality-rust -->

Everything outside them survives, and a file with no marker is never written after it is
first created. That is what keeps `conventions.md` and the "why a rule is off" notes: they
are the hand-written half of the ownership table in docs/steering.md.

What it reads, per that table: the tool configs each language layer wrote, the workflows
the host layer rendered, the release configuration, the test directories, and the variable
names CI and configuration mention. Nothing is asked, because an answer could disagree with
the tree an agent will actually read.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tomllib
from pathlib import Path

AGENTS = Path("docs/agents")

# Both markers carry the block name, which is the form the shipped templates use. A bare
# `<!-- END GENERATED -->` matched nothing and the generator wrote an empty block while
# reporting success.
BEGIN = "<!-- BEGIN GENERATED: {name} -->"
END = "<!-- END GENERATED: {name} -->"

# Which config file proves a language is present, and what its quality leaf is called.
# Keyed on a file the layer writes rather than on a recorded answer: a layer whose files were
# removed by hand should stop being described.
LANGUAGES = (
    ("rust", "rust-toolchain.toml"),
    ("python", "ruff.toml"),
    ("ts", "biome.json"),
    ("go", ".golangci.yml"),
    ("tofu", ".tflint.hcl"),
)

# The command each language's quality gate runs, which is the one an agent should reach for
# rather than the underlying tool.
QUALITY_COMMANDS = {
    "rust": ("just rust-lint", "clippy with cargo-deny and cargo-machete"),
    "python": ("just python-lint", "ruff and ty"),
    "ts": ("just ts-lint", "biome for format and oxlint for type-aware rules"),
    "go": ("just go-lint", "golangci-lint on the v2 schema, with gosec and revive"),
    "tofu": ("just tofu-lint", "tflint with the configured provider ruleset and trivy for misconfiguration"),
}

TEST_DIRECTORIES = (
    ("tests", "python and rust integration tests"),
    ("src", "rust unit tests, beside the code"),
    ("infra/tests", "tofu test suites, with command = plan"),
)


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.is_file() else ""


def present_languages(dest: Path) -> list[str]:
    return [name for name, marker in LANGUAGES if (dest / marker).exists()]


def toolchain_pins(dest: Path) -> list[tuple[str, str]]:
    """Every tool and version the .mise/conf.d fragments pin.

    Read rather than asked: the fragments are what `mise install` resolves, so they are
    what an agent should be told about.
    """
    pins: list[tuple[str, str]] = []
    directory = dest / ".mise" / "conf.d"
    if not directory.is_dir():
        return pins
    for path in sorted(directory.glob("*.toml")):
        try:
            data = tomllib.loads(path.read_bytes().decode())
        except (tomllib.TOMLDecodeError, UnicodeDecodeError):
            continue
        for tool, version in (data.get("tools") or {}).items():
            if isinstance(version, str):
                pins.append((tool, version))
    return sorted(set(pins))


def recipes(dest: Path) -> list[str]:
    """Recipe names the justfile and its fragments define, which is the task surface."""
    pattern = re.compile(r"^([a-z][a-z0-9-]*)(?:\s+[^:]*)?:", re.M)
    found: set[str] = set()
    for path in [dest / "justfile", *sorted((dest / ".just.d").glob("*.just"))]:
        found |= set(pattern.findall(read_text(path)))
    # `default` is the listing itself. `set` and `import` are just's own directives, which
    # the pattern above cannot tell from a recipe: `set shell := [...]` and
    # `import? '.just.d/x.just'` both start a line with a lowercase word.
    return sorted(found - {"default", "set", "import", "mod", "alias", "export"})


def workflows(dest: Path) -> list[str]:
    directory = dest / ".github" / "workflows"
    if not directory.is_dir():
        return []
    return sorted(path.name for path in directory.glob("*.yml"))


def env_names(dest: Path) -> list[str]:
    """Variable names the workflows and the container reference.

    Names only. A value would be a secret, and the point is telling an agent which
    variables exist rather than what they hold.
    """
    pattern = re.compile(r"\b([A-Z][A-Z0-9_]{3,})\b")
    # Names every CI run defines, which say nothing about this project.
    ambient = {
        "GITHUB_TOKEN",
        "GITHUB_OUTPUT",
        "GITHUB_STEP_SUMMARY",
        "GITHUB_ENV",
        "GITHUB_REPOSITORY",
        "GITHUB_REF",
        "GITHUB_SHA",
        "GITHUB_ACTOR",
        "CI_REGISTRY",
        "CI_REGISTRY_IMAGE",
        "CI_REGISTRY_USER",
        "CI_REGISTRY_PASSWORD",
        "CI_COMMIT_BRANCH",
        "CI_COMMIT_SHORT_SHA",
        "CI_PIPELINE_SOURCE",
        "CI_MERGE_REQUEST_TARGET_BRANCH_NAME",
        "PATH",
        "HOME",
        "TRUE",
        "FALSE",
        "CRITICAL",
        "HIGH",
        "ERR",
        "WARN",
        "BEGIN",
        "END",
        "GENERATED",
        "EOF",
    }
    found: set[str] = set()
    for path in [
        *sorted((dest / ".github" / "workflows").glob("*.yml")),
        *sorted((dest / ".gitlab" / "ci").glob("*.yml")),
        dest / "Dockerfile",
    ]:
        found |= set(pattern.findall(read_text(path)))
    return sorted(found - ambient)


def release_shape(dest: Path) -> tuple[str, str]:
    """The release tool and the tag format it produces."""
    config = dest / "release-please-config.json"
    if config.is_file():
        try:
            data = json.loads(config.read_text())
        except json.JSONDecodeError:
            return ("release-please", "unreadable configuration")
        separator = data.get("tag-separator", "-")
        if data.get("include-component-in-tag"):
            return ("release-please", f"`<component>{separator}v<version>`")
        return ("release-please", "`v<version>`")
    if (dest / "cog.toml").is_file():
        return ("cocogitto", "`v<version>`")
    return ("none", "no release tooling rendered")


# --- the generated blocks --------------------------------------------------


def block_index(dest: Path) -> str:
    lines = ["## Commands", ""]
    names = recipes(dest)
    if names:
        lines.append("Every task runs through `just`. The surface:")
        lines.append("")
        lines.append("```")
        # Wrapped rather than one per line: the list is long and its shape is not the point.
        row: list[str] = []
        for name in names:
            row.append(name)
            if len(row) == 6:
                lines.append(" ".join(row))
                row = []
        if row:
            lines.append(" ".join(row))
        lines.append("```")
    else:
        lines.append("No justfile rendered, so there is no task surface yet.")

    pins = toolchain_pins(dest)
    if pins:
        lines += [
            "",
            "## Toolchain",
            "",
            "Pinned in `.mise/conf.d/`, so CI and a laptop resolve the same versions.",
            "",
        ]
        lines.append("| Tool | Version |")
        lines.append("|---|---|")
        lines += [f"| `{tool}` | `{version}` |" for tool, version in pins]

    languages = present_languages(dest)
    if languages:
        lines += ["", "## Languages", "", ", ".join(f"`{name}`" for name in languages) + ".", ""]
        lines.append("Each has a quality leaf under `quality/`.")

    if (dest / "repomix.config.json").is_file():
        lines += [
            "",
            "## Structural tool",
            "",
            "repomix, configured in `repomix.config.json`. Search the pack with `rg` rather than",
            "reading it: a pack of a large repository runs to several context windows, and `rg`",
            "over it lists every path in milliseconds.",
        ]
    return "\n".join(lines)


def block_quality(dest: Path, language: str) -> str:
    command, tools = QUALITY_COMMANDS[language]
    return "\n".join(
        [
            f"{tools.capitalize()}.",
            "",
            f"Run `{command}`. The configuration is committed, so a finding here is a",
            "finding in CI.",
        ]
    )


def block_quality_index(dest: Path) -> str:
    languages = present_languages(dest)
    lines = ["One leaf per language present in this repository.", ""]
    if languages:
        lines.append("| Language | Leaf | Command |")
        lines.append("|---|---|---|")
        for name in languages:
            command, _ = QUALITY_COMMANDS[name]
            lines.append(f"| {name} | [`{name}.md`]({name}.md) | `{command}` |")
    else:
        lines.append("No language layer rendered.")
    lines += [
        "",
        "`just check` runs every language's gate plus the hook set, which is what CI runs.",
    ]
    return "\n".join(lines)


def block_ci(dest: Path) -> str:
    names = workflows(dest)
    lines = []
    if names:
        lines += [
            "Reusable workflows, wired by `ci.yml`, which `just ci-sync` generates:",
            "",
            "```",
            *names,
            "```",
            "",
            "`wc-gate.yml` is the only required status check. It lists every other job in",
            "`needs:` and receives `toJSON(needs)`, so a new job is covered without touching",
            "branch protection.",
            "",
            "Reproduce a failure locally with `just check`. The hook set runs there and in CI",
            "through `prek run --all-files`, so a local pass means the same thing.",
        ]
    elif (dest / ".gitlab-ci.yml").is_file():
        lines.append(
            "GitLab, with `.gitlab/ci/*.yml` resolved by a glob include. There is no caller."
        )
    else:
        lines.append("No CI rendered.")
    return "\n".join(lines)


def block_release(dest: Path) -> str:
    tool, tags = release_shape(dest)
    return "\n".join(
        [
            f"Tool: {tool}. Tags: {tags}.",
            "",
            "A version is never tagged by hand. The release tool derives the next one from the",
            "Conventional Commit subjects in the range, so a hand-made tag makes it compute the",
            "wrong version, and the quality workflow refuses one.",
        ]
    )


def block_testing(dest: Path) -> str:
    present = [(path, why) for path, why in TEST_DIRECTORIES if (dest / path).is_dir()]
    lines = []
    if present:
        lines.append("| Directory | Holds |")
        lines.append("|---|---|")
        lines += [f"| `{path}` | {why} |" for path, why in present]
        lines.append("")
    names = set(recipes(dest))
    runners = sorted(name for name in names if name.endswith("-test") or name == "test")
    if runners:
        lines += ["Runners:", "", *[f"- `just {name}`" for name in runners], ""]
    lines.append(
        "Run one test by passing its filter to the underlying tool rather than the recipe."
    )
    return "\n".join(lines)


def block_docs(dest: Path) -> str:
    if not (dest / "docs" / "site").is_dir():
        return "No documentation site rendered. `docs/agents/` is steering and is never published."
    workflow_names = workflows(dest)
    if any("docs-publish" in name for name in workflow_names):
        topology = "split: this repository builds and pushes the rendered output to a sibling."
    elif any("pages" in name for name in workflow_names):
        topology = "sibling: the sibling repository holds the source and builds itself."
    else:
        topology = "no deploy workflow rendered."
    return "\n".join(
        [
            f"Topology: {topology}",
            "",
            "The site is under `docs/site`. `docs/agents/` is steering and is never published.",
            "",
            "Everything under `docs/site/src/content` is authored. The built output is generated",
            "and gitignored.",
        ]
    )


def block_env(dest: Path) -> str:
    names = env_names(dest)
    if not names:
        return "No variables are referenced by CI or the container."
    return "\n".join(
        [
            "Names referenced by CI and the container. What each one holds is not recorded here,",
            "and what fails without it belongs beside the name once someone knows.",
            "",
            "```",
            *names,
            "```",
        ]
    )


# One entry per generated block: the file it lives in, the marker name, and the builder.
# The marker names are the ones the shipped templates already carry, so the generator
# matches the files rather than the files matching it.
BLOCKS = (
    ("index.md", "index", block_index),
    ("quality/index.md", "quality-index", block_quality_index),
    ("ci/index.md", "ci-index", block_ci),
    ("release/index.md", "release-index", block_release),
    ("testing/index.md", "testing-index", block_testing),
    ("docs/index.md", "docs-index", block_docs),
    ("env/index.md", "env-index", block_env),
)


def replace_block(body: str, name: str, content: str) -> str | None:
    """The file with its marked block replaced, or None when it carries no such marker.

    A file with no marker is never written, which is what keeps conventions.md and the
    hand-written halves intact.
    """
    begin = BEGIN.format(name=name)
    end = END.format(name=name)
    if begin not in body or end not in body:
        return None
    head, _, rest = body.partition(begin)
    _, _, tail = rest.partition(end)
    return f"{head}{begin}\n{content}\n{end}{tail}"


def targets(dest: Path) -> list[tuple[Path, str]]:
    """Every (path, desired body) pair, including one quality leaf per language."""
    out: list[tuple[Path, str]] = []
    root = dest / AGENTS

    for relative, name, builder in BLOCKS:
        path = root / relative
        body = read_text(path)
        if not body:
            continue
        updated = replace_block(body, name, builder(dest))
        if updated is not None:
            out.append((path, updated))

    for language in present_languages(dest):
        path = root / "quality" / f"{language}.md"
        body = read_text(path)
        if not body:
            # A leaf for a newly adopted language, seeded with its marker so the block has
            # somewhere to go. Adding a language adds a file rather than growing one.
            body = "\n".join(
                [
                    f"# Quality: {language}",
                    "",
                    BEGIN.format(name=f"quality-{language}"),
                    END.format(name=f"quality-{language}"),
                    "",
                    "## Why a rule is off",
                    "",
                    "Hand-written. A rule disabled without a reason gets re-enabled by the next",
                    "person to read the config.",
                    "",
                ]
            )
        updated = replace_block(body, f"quality-{language}", block_quality(dest, language))
        if updated is not None:
            out.append((path, updated))
    return out


def main() -> int:
    parser = argparse.ArgumentParser(prog="gen_steering.py", description=__doc__)
    parser.add_argument("dest", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    dest = args.dest
    if not (dest / AGENTS).is_dir():
        print("no docs/agents/, so there is nothing to generate", file=sys.stderr)
        return 0

    pairs = targets(dest)
    stale: list[str] = []
    written = 0

    for path, body in pairs:
        current = read_text(path)
        if current == body:
            continue
        if args.check:
            stale.append(str(path.relative_to(dest)))
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(body, encoding="utf-8")
            written += 1

    if args.check:
        if stale:
            print("stale steering: " + ", ".join(stale), file=sys.stderr)
            print("fix with: just steering", file=sys.stderr)
            return 1
        print(f"{len(pairs)} steering file(s) current")
        return 0

    print(f"wrote {written} of {len(pairs)} steering file(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
