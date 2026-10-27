"""Launch a PEP 723 script in the uv environment shared by every script with its dependency set.

`uv run --script S` keys its environment by the script's path, so every copy of the plugin (a
project's skill copy, an eval trial, a worktree) installs and first-loads its own copy of the same
packages. `uv run --no-project --with-requirements S python S` reads the same inline dependencies
but keys the environment by the resolved set and interpreter, so every copy of S loads one shared
environment. `--with-requirements` ignores the header's `requires-python`, so the header's
specifier is passed as `--python`. `--isolated` keeps an active or discovered virtual environment
out of the interpreter's path, as `uv run --script` does.

Standard library only: the orchestrator, the preflight, and the warm-up import it outside any kernel.
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path
from typing import Any

# PEP 723's reference block pattern: `# /// script`, `#`-prefixed TOML lines, `# ///`.
BLOCK = re.compile(r"(?m)^# /// (?P<type>[a-zA-Z0-9-]+)$\s(?P<content>(^#(| .*)$\s)+)^# ///$")
NAME = re.compile(r"^\s*(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)")
PIN = re.compile(r"^\s*(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*==\s*(?P<version>[^\s,;]+)\s*$")


def metadata(script: Path) -> dict[str, Any]:
    """The script's PEP 723 `script` table; ValueError when it has none or more than one."""
    blocks = [m for m in BLOCK.finditer(script.read_text(encoding="utf-8")) if m.group("type") == "script"]
    if len(blocks) != 1:
        raise ValueError(f"{script}: expected one PEP 723 `# /// script` block, found {len(blocks)}")
    toml = "".join(line[2:] if line.startswith("# ") else line[1:]
                   for line in blocks[0].group("content").splitlines(keepends=True))
    try:
        return tomllib.loads(toml)
    except tomllib.TOMLDecodeError as error:
        raise ValueError(f"{script}: invalid PEP 723 metadata: {error}") from error


def normalize(name: str) -> str:
    """A distribution name in PEP 503 normal form."""
    return re.sub(r"[-_.]+", "-", name).lower()


def dependency_names(script: Path) -> frozenset[str]:
    """The normalized distribution names the script's header depends on."""
    names = (NAME.match(requirement) for requirement in metadata(script).get("dependencies", []))
    return frozenset(normalize(match.group("name")) for match in names if match)


def pinned(script: Path, distribution: str) -> str:
    """The exact version the script's header pins for `distribution` (`name==version`)."""
    wanted = normalize(distribution)
    for requirement in metadata(script).get("dependencies", []):
        match = PIN.match(requirement)
        if match and normalize(match.group("name")) == wanted:
            return match.group("version")
    raise ValueError(f"{script}: no `{distribution}==<version>` dependency")


def python_command(script: Path, *python_args: str, uv: str = "uv") -> list[str]:
    """argv running `python *python_args` in the environment shared by `script`'s dependency set."""
    command = [uv, "run", "--quiet", "--isolated", "--no-project"]
    requires = metadata(script).get("requires-python")
    if requires is not None:
        command += ["--python", requires]
    return [*command, "--with-requirements", str(script), "python", *python_args]


def script_command(script: Path, *args: str, uv: str = "uv") -> list[str]:
    """argv running `script` with `args` in the environment shared by its dependency set."""
    return python_command(script, str(script), *args, uv=uv)
