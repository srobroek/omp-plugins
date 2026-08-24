#!/usr/bin/env python3
"""Apply one confirmed dependency bump by running the ecosystem's package manager.

Usage: ``apply.py <ecosystem> <name> <new_version> [project-dir]``

``ecosystem`` is one of pypi, npm, cargo, go. cargo and go are advisory-only:
the manual command is printed and nothing is applied.

Node package manager selection, in order: ``DEP_UPDATE_PKG_MANAGER``, then
``.project-setup/answers.toml`` ``[module.lang-ts] package_manager``, then
lockfile presence (pnpm-lock.yaml, bun.lock/bun.lockb, yarn.lock, else npm).

After applying, the manifest is re-read to confirm the version landed. An absent
package manager prints the manual command and exits 0.

This never writes ``.project-setup/`` files.

Exit status:
  0  applied, printed a manual command, or advisory-only
  1  applied but the post-apply manifest check found a version mismatch
  2  bad arguments
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

PROTECTED_NAME = re.compile(r"^\.project-setup|answers\.toml|sources\.toml")


def note(message: str) -> None:
    # Flushed because stdout is block-buffered when piped while stderr is not,
    # so an unflushed progress line lands AFTER the warning that follows it.
    print(message, flush=True)


def warn(message: str) -> None:
    print(f"WARN: {message}", file=sys.stderr, flush=True)


def error(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr, flush=True)


def canonical(name: str) -> str:
    """PEP 503 normalized name: case, `.`, `_` and `-` all fold together.

    `Ruamel.YAML`, `ruamel-yaml` and `ruamel_yaml` are one project on PyPI, so a
    post-apply check that compares raw strings reports a false mismatch.
    """
    return re.sub(r"[-_.]+", "-", name).lower()


# --- node package manager detection -----------------------------------------


def detect_node_pm(root: Path) -> str:
    override = os.environ.get("DEP_UPDATE_PKG_MANAGER", "")
    if override:
        return override

    answers = root / ".project-setup" / "answers.toml"
    if answers.is_file():
        try:
            with answers.open("rb") as handle:
                data = tomllib.load(handle)
            lang_ts = (data.get("module") or {}).get("lang-ts") or {}
            pinned = lang_ts.get("package_manager") or lang_ts.get(
                "package_manager_pin", ""
            )
            if pinned:
                # A pin may carry a version, as in `pnpm@9.1.0`.
                return str(pinned).split("@")[0].strip()
        except (OSError, tomllib.TOMLDecodeError, AttributeError):
            # Fail open to lockfile detection rather than aborting the bump.
            pass

    if (root / "pnpm-lock.yaml").is_file():
        return "pnpm"
    if (root / "bun.lock").is_file() or (root / "bun.lockb").is_file():
        return "bun"
    if (root / "yarn.lock").is_file():
        return "yarn"
    return "npm"


# --- post-apply version checks ----------------------------------------------


def check_python_version(root: Path, name: str, version: str) -> bool:
    """Whether a python manifest now declares `name` at exactly `version`.

    The shell predecessor ran `grep -qiE "\"${name}==${ver}\""` with BOTH
    interpolations unescaped, so every `.` was a regex wildcard: `ruamel.yaml`
    confirmed against `ruamelXyaml`, and `1.2.3` confirmed against `1x2x3`.
    Matching is structural here, and the name is PEP 503 normalized so a
    manifest spelling of `ruamel-yaml` still counts.
    """
    wanted = canonical(name)

    pyproject = root / "pyproject.toml"
    if pyproject.is_file():
        try:
            with pyproject.open("rb") as handle:
                data = tomllib.load(handle)
        except (OSError, tomllib.TOMLDecodeError):
            data = {}
        for requirement in _pyproject_requirements(data):
            req_name, req_version = _split_pin(requirement)
            if req_name and canonical(req_name) == wanted and req_version == version:
                return True

    requirements = root / "requirements.txt"
    if requirements.is_file():
        try:
            lines = requirements.read_text(encoding="utf-8", errors="replace")
        except OSError:
            lines = ""
        for raw in lines.splitlines():
            req_name, req_version = _split_pin(raw.split("#", 1)[0].strip())
            if req_name and canonical(req_name) == wanted and req_version == version:
                return True

    lock = root / "uv.lock"
    if lock.is_file():
        try:
            with lock.open("rb") as handle:
                data = tomllib.load(handle)
        except (OSError, tomllib.TOMLDecodeError):
            return False
        for entry in data.get("package") or []:
            if not isinstance(entry, dict):
                continue
            if canonical(str(entry.get("name", ""))) == wanted:
                return entry.get("version") == version
        return False

    # Conservative: no manifest read means the bump is unconfirmed.
    return False


def _pyproject_requirements(data: dict) -> list[str]:
    """Every PEP 508 requirement string a pyproject.toml declares."""
    out: list[str] = []
    project = data.get("project")
    if isinstance(project, dict):
        out.extend(r for r in project.get("dependencies") or [] if isinstance(r, str))
        extras = project.get("optional-dependencies")
        if isinstance(extras, dict):
            for reqs in extras.values():
                out.extend(r for r in reqs or [] if isinstance(r, str))
    groups = data.get("dependency-groups")
    if isinstance(groups, dict):
        for reqs in groups.values():
            out.extend(r for r in reqs or [] if isinstance(r, str))
    return out


def _split_pin(requirement: str) -> tuple[str, str]:
    """Split `name==version` into its parts; ("", "") when not an `==` pin."""
    body = requirement.split(";", 1)[0].strip()
    if "==" not in body:
        return "", ""
    name, _, version = body.partition("==")
    name = re.sub(r"\[[^\]]*\]", "", name).strip()
    return name, version.strip()


def check_node_version(root: Path, name: str, version: str) -> bool:
    """Whether package.json now declares `name` at `version`.

    The shell predecessor accepted `ver in v`, a substring test: bumping to
    `1.2` "confirmed" against an unchanged `^1.20.0`. Accepted forms are exact,
    caret, and tilde.
    """
    manifest = root / "package.json"
    if not manifest.is_file():
        return False
    try:
        data = json.loads(manifest.read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError):
        return False
    if not isinstance(data, dict):
        return False
    accepted = {version, f"^{version}", f"~{version}", f"={version}"}
    for section in (
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
    ):
        block = data.get(section)
        if not isinstance(block, dict):
            continue
        declared = block.get(name)
        # A string comparison, not `str(declared)`: a numeric `"x": 1` stringified
        # to "1" and confirmed a bump to version "1", so a manifest npm would
        # reject read as a landed upgrade.
        if isinstance(declared, str) and declared in accepted:
            return True
    return False


# --- apply ------------------------------------------------------------------


def run_pm(command: list[str], root: Path) -> int:
    note("==> " + " ".join(command))
    return subprocess.run(command, cwd=root).returncode


def apply_python(root: Path, name: str, version: str) -> int:
    if not shutil.which("uv"):
        note("SKIP: uv not found. To apply manually:")
        note(f'  uv add "{name}=={version}"')
        note(
            f'  (or: pip install "{name}=={version}" and update your '
            "requirements file)"
        )
        return 0
    result = run_pm(["uv", "add", f"{name}=={version}"], root)
    if result != 0:
        warn(f"uv exited with status {result}; bump was not confirmed")
        return 1
    return _confirm(check_python_version(root, name, version), name, version)


NODE_COMMANDS = {
    "pnpm": lambda name, version: ["pnpm", "update", name, "--version", version],
    "bun": lambda name, version: ["bun", "add", f"{name}@{version}"],
    "yarn": lambda name, version: ["yarn", "add", f"{name}@{version}"],
    "npm": lambda name, version: ["npm", "install", f"{name}@{version}"],
}


def apply_node(root: Path, name: str, version: str) -> int:
    pm = detect_node_pm(root)
    if pm not in NODE_COMMANDS:
        pm = "npm"
    command = NODE_COMMANDS[pm](name, version)
    if not shutil.which(pm):
        note(f"SKIP: {pm} not found. To apply manually:")
        note("  " + " ".join(command))
        return 0
    result = run_pm(command, root)
    if result != 0:
        warn(f"{pm} exited with status {result}; bump was not confirmed")
        return 1
    return _confirm(check_node_version(root, name, version), name, version)


def _confirm(landed: bool, name: str, version: str) -> int:
    if landed:
        note(f"OK: {name} confirmed at {version}")
        return 0
    warn(f"{name}: post-apply manifest check failed - version may not have landed")
    return 1


def main(argv: list[str]) -> int:
    if len(argv) < 4:
        error(
            "apply.py: usage: apply.py <ecosystem> <name> <new_version> "
            "[project-dir]"
        )
        return 2

    ecosystem, name, version = argv[1], argv[2], argv[3]
    target = argv[4] if len(argv) > 4 else "."
    root = Path(target)

    # is_dir() RAISES ENAMETOOLONG on Linux for an over-long path, while macOS
    # returns False. CI caught this where a local run could not: the uncaught
    # OSError left main() with no exit code of its own. Treat anything the
    # filesystem cannot name as "not a directory", which is what it is.
    try:
        usable = root.is_dir()
    except (OSError, ValueError):
        usable = False
    if not usable:
        error(f"apply.py: '{target}' is not a directory")
        return 2

    # Belt-and-braces: the skill should never route a project-setup path here.
    if PROTECTED_NAME.search(name):
        error("apply.py: refusing to touch project-setup files")
        return 2

    note(f"dep-update/apply: {ecosystem} {name} -> {version}")

    if ecosystem in ("pypi", "python"):
        return apply_python(root, name, version)
    if ecosystem in ("npm", "node", "pnpm", "yarn", "bun"):
        return apply_node(root, name, version)
    if ecosystem in ("cargo", "rust"):
        note("ADVISORY-ONLY: Rust deps are advisory-only in this version.")
        note(f"To update manually: cargo update -p {name} --precise {version}")
        return 0
    if ecosystem == "go":
        note("ADVISORY-ONLY: Go deps are advisory-only in this version.")
        note(f"To update manually: go get {name}@{version} && go mod tidy")
        return 0

    warn(f"apply.py: unknown ecosystem '{ecosystem}'")
    note(f"Cannot apply automatically. Check the registry for {name}@{version}.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
