#!/usr/bin/env python3
"""Enumerate a project's declared dependencies and versions, without network.

Output: one ``ecosystem<TAB>name<TAB>version`` line per dependency on stdout,
then a short summary on stderr. The version is the declared string verbatim;
resolving it against a registry is the research step's job.

Ecosystems: npm/pnpm/yarn (node), pip/uv/poetry (python), cargo (rust), go,
ruby (Gemfile), php (composer.json).

Usage: ``detect.py [project-dir]`` (defaults to the current directory).

TWIN: this file is shipped byte-identical by two packages,
``packages/whats-new/.apm/skills/whats-new/scripts/detect.py`` and
``packages/dep-update/.apm/skills/dep-update/scripts/detect.py``. Constitution
principle I forbids one package reaching into another's internals at runtime,
and a skill script resolves paths relative to its own installed directory, so
the duplication is deliberate. ``.apm/scripts/check-twin-scripts.py`` enforces
that the two copies stay identical; edit both or neither.
"""

from __future__ import annotations

import json
import re
import sys
import tomllib
from pathlib import Path

# Version specifier operators, per PEP 440 plus the extras bracket that
# precedes them in a PEP 508 requirement. Splitting a requirement on the first
# of these separates the name from everything that constrains it.
_REQ_SPLIT = re.compile(r"[\[<>=!~;\s]")

# A legal distribution name, per PEP 508. Anything else on a requirements line --
# a bare URL, a `--hash` continuation, an option -- is not a named dependency,
# and emitting it as one sends the research step to a registry with a URL for a
# package name.
_REQ_NAME = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$")

# Files may carry a UTF-8 BOM: a Windows editor writes one, and both `json` and
# `tomllib` reject it outright, which silently discarded the whole manifest.
_ENCODING = "utf-8-sig"

# `gem "rails", "~> 7.1"` / `gem 'puma'`
_GEM = re.compile(
    r"""^\s*gem\s+(['"])(?P<name>[^'"]+)\1"""
    r"""(?:\s*,\s*(['"])(?P<ver>[^'"]*)\3)?"""
)

_MISSING = "?"


class Detector:
    """Collects dependency rows for one project directory."""

    def __init__(self, root: Path) -> None:
        self.root = root
        # Keyed by (ecosystem, name) so a package declared in two blocks --
        # npm `dependencies` plus `devDependencies`, composer `require` plus
        # `require-dev` -- yields one row. Last declaration wins, matching the
        # `jq '[...] | add'` merge the shell predecessor used.
        self._rows: dict[tuple[str, str], str] = {}

    @property
    def rows(self) -> list[tuple[str, str, str]]:
        return [(eco, name, ver) for (eco, name), ver in self._rows.items()]

    # --- helpers -----------------------------------------------------------

    def emit(self, ecosystem: str, name: str, version: str) -> None:
        if name:
            self._rows[(ecosystem, name)] = version or _MISSING

    def _read_toml(self, name: str) -> dict | None:
        """Parse a TOML file, or return None when it is absent or malformed.

        Fail open: a manifest this parser cannot read yields no rows and a
        stderr note rather than an error exit, so a syntax error in one
        ecosystem never hides the others.
        """
        path = self.root / name
        if not _is_file(path):
            return None
        try:
            # Decoded here rather than by `tomllib.load`, which reads bytes and
            # raises UnicodeDecodeError -- NOT TOMLDecodeError -- on a manifest
            # holding one invalid byte. That escaped this handler and crashed the
            # detector with a traceback, taking every other ecosystem with it.
            body = path.read_text(encoding=_ENCODING, errors="replace")
            return tomllib.loads(body)
        except (OSError, ValueError) as exc:
            note(f"detect: {name} is unreadable ({exc}); skipping")
            return None

    def _read_json(self, name: str) -> dict | None:
        path = self.root / name
        if not _is_file(path):
            return None
        try:
            data = json.loads(path.read_text(encoding=_ENCODING, errors="replace"))
        except (OSError, ValueError) as exc:
            note(f"detect: {name} is unreadable ({exc}); skipping")
            return None
        return data if isinstance(data, dict) else None

    def _read_lines(self, name: str) -> list[str] | None:
        path = self.root / name
        if not _is_file(path):
            return None
        try:
            return path.read_text(encoding=_ENCODING, errors="replace").splitlines()
        except OSError as exc:
            note(f"detect: {name} is unreadable ({exc}); skipping")
            return None

    # --- node --------------------------------------------------------------

    def scan_node(self) -> None:
        data = self._read_json("package.json")
        if data is None:
            return
        for field in (
            "dependencies",
            "devDependencies",
            "peerDependencies",
            "optionalDependencies",
        ):
            block = data.get(field)
            if not isinstance(block, dict):
                continue
            for name, spec in block.items():
                self.emit("npm", str(name), _scalar(spec))

    # --- python ------------------------------------------------------------

    def scan_python(self) -> None:
        """Scan the highest-fidelity python manifest present, and stop there.

        A lockfile pins exactly, so it wins over a manifest range; the
        precedence uv.lock > poetry.lock > requirements.txt > pyproject.toml is
        part of the output contract.
        """
        for lock in ("uv.lock", "poetry.lock"):
            data = self._read_toml(lock)
            if data is None:
                continue
            for entry in data.get("package") or []:
                if not isinstance(entry, dict):
                    continue
                name, version = entry.get("name"), entry.get("version")
                # Both fields are required: a package block missing either is
                # a source or workspace member, not a pinned dependency.
                if isinstance(name, str) and isinstance(version, str):
                    self.emit("pypi", name, version)
            return

        lines = self._read_lines("requirements.txt")
        if lines is not None:
            for raw in lines:
                name, version = _parse_requirement(raw)
                self.emit("pypi", name, version)
            return

        data = self._read_toml("pyproject.toml")
        if data is None:
            return
        self._scan_pep621(data.get("project"))
        self._scan_dependency_groups(data.get("dependency-groups"))
        tool = data.get("tool")
        if isinstance(tool, dict):
            self._scan_poetry(tool.get("poetry"))

    def _scan_pep621(self, project: object) -> None:
        """PEP 621 `[project] dependencies` and `optional-dependencies`.

        These are arrays of PEP 508 strings, not tables. The shell predecessor
        matched any quoted TOML scalar in the file, which missed these arrays
        entirely while emitting `requires-python` and `name` as packages.
        """
        if not isinstance(project, dict):
            return
        for req in project.get("dependencies") or []:
            if isinstance(req, str):
                name, version = _parse_requirement(req)
                self.emit("pypi", name, version)
        extras = project.get("optional-dependencies")
        if isinstance(extras, dict):
            for reqs in extras.values():
                for req in reqs or []:
                    if isinstance(req, str):
                        name, version = _parse_requirement(req)
                        self.emit("pypi", name, version)

    def _scan_dependency_groups(self, groups: object) -> None:
        """PEP 735 `[dependency-groups]`: arrays of requirements per group."""
        if not isinstance(groups, dict):
            return
        for reqs in groups.values():
            for req in reqs or []:
                # A group may include another group as {"include-group": "x"};
                # only plain strings are requirements.
                if isinstance(req, str):
                    name, version = _parse_requirement(req)
                    self.emit("pypi", name, version)

    def _scan_poetry(self, poetry: object) -> None:
        """`[tool.poetry.dependencies]` and its dev and group variants."""
        if not isinstance(poetry, dict):
            return
        blocks = [poetry.get("dependencies"), poetry.get("dev-dependencies")]
        groups = poetry.get("group")
        if isinstance(groups, dict):
            blocks.extend(
                group.get("dependencies")
                for group in groups.values()
                if isinstance(group, dict)
            )
        for block in blocks:
            if not isinstance(block, dict):
                continue
            for name, spec in block.items():
                # `python` is the interpreter constraint, not a package.
                if name == "python":
                    continue
                self.emit("pypi", str(name), _spec_version(spec))

    # --- rust --------------------------------------------------------------

    def scan_rust(self) -> None:
        data = self._read_toml("Cargo.toml")
        if data is None:
            return
        for field in ("dependencies", "dev-dependencies", "build-dependencies"):
            block = data.get(field)
            if not isinstance(block, dict):
                continue
            for name, spec in block.items():
                # `[dependencies.reqwest]` sub-table form parses to the same
                # shape here; the shell predecessor dropped it because any `[`
                # line reset its in-section flag.
                self.emit("cargo", str(name), _spec_version(spec))

    # --- go ----------------------------------------------------------------

    def scan_go(self) -> None:
        lines = self._read_lines("go.mod")
        if lines is None:
            return
        in_block = False
        for raw in lines:
            line = raw.strip()
            if line.startswith("require (") or line == "require(":
                in_block = True
                continue
            if line.startswith(")"):
                in_block = False
                continue
            if line.startswith("require "):
                fields = line.split()
                self.emit("go", fields[1] if len(fields) > 1 else "", _field(fields, 2))
                continue
            if in_block:
                # `// indirect` trails a version; a whole-line comment is not
                # a module.
                if not line or line.startswith("//"):
                    continue
                fields = line.split()
                self.emit("go", fields[0], _field(fields, 1))

    # --- ruby --------------------------------------------------------------

    def scan_ruby(self) -> None:
        lines = self._read_lines("Gemfile")
        if lines is None:
            return
        for raw in lines:
            match = _GEM.match(raw)
            if match:
                self.emit("rubygems", match["name"], match["ver"] or _MISSING)

    # --- php ---------------------------------------------------------------

    def scan_php(self) -> None:
        data = self._read_json("composer.json")
        if data is None:
            return
        for field in ("require", "require-dev"):
            block = data.get(field)
            if not isinstance(block, dict):
                continue
            for name, spec in block.items():
                name = str(name)
                # php, ext-* and lib-* are platform requirements, not packages.
                if name == "php" or name.startswith(("ext-", "lib-")) or " " in name:
                    continue
                self.emit("packagist", name, _scalar(spec))


def _is_file(path: Path) -> bool:
    """`path.is_file()`, but False rather than a raise on a hostile path.

    Which OSErrors `Path.is_file` swallows is platform and version dependent:
    ENAMETOOLONG for an over-long component, and a ValueError for an embedded
    NUL, both return False on CPython 3.14/macOS and have raised elsewhere.
    A detector that raises there exits nonzero and reports no ecosystem at all,
    so the cost of guarding is two lines and the cost of assuming is total.
    """
    try:
        return path.is_file()
    except (OSError, ValueError):
        return False


def _is_dir(path: Path) -> bool:
    """`path.is_dir()` with the same platform guard as `_is_file`."""
    try:
        return path.is_dir()
    except (OSError, ValueError):
        return False


def _scalar(value: object) -> str:
    """Render a manifest value as the version string, or `?` when absent."""
    if value is None or isinstance(value, (dict, list)):
        return _MISSING
    return str(value)


def _spec_version(spec: object) -> str:
    """Version of a dependency declared as a string or as a table.

    Covers cargo's `{ version = "1.36", features = [...] }` and poetry's
    equivalent; a git or path dependency carries no version and yields `?`.
    """
    if isinstance(spec, dict):
        return _scalar(spec.get("version"))
    if isinstance(spec, list):
        # Poetry allows a list of constraint tables for multiple markers.
        for item in spec:
            if isinstance(item, dict) and item.get("version") is not None:
                return _scalar(item["version"])
        return _MISSING
    return _scalar(spec)


def _parse_requirement(raw: str) -> tuple[str, str]:
    """Split a PEP 508 requirement into name and version specifier.

    Extras and environment markers are dropped from the version rather than
    leaking into it: `requests[socks]>=2.31; python_version<"3.12"` yields
    `("requests", ">=2.31")`.
    """
    line = raw.split("#", 1)[0].strip()
    # A trailing backslash continues the line, most often onto a `--hash=` block;
    # left in place it became part of the version, as `==1.0 \`.
    line = line.rstrip("\\").strip()
    if not line or line.startswith(("-", ".", "/")):
        # -r/-e directives and bare paths are not named dependencies.
        return "", ""
    line = line.split(";", 1)[0].strip()
    match = _REQ_SPLIT.search(line)
    if not match:
        return (line, _MISSING) if _REQ_NAME.match(line) else ("", "")
    name = line[: match.start()].strip()
    # A direct-reference URL (`https://host/pkg.whl`) splits at its `:` scheme or
    # not at all, leaving the whole URL as the "name". Emitting it sent the
    # research step to a registry with a URL for a package name; a `pkg @ url`
    # requirement still yields `pkg`, because the name precedes the separator.
    if not _REQ_NAME.match(name):
        return "", ""
    rest = line[match.start() :]
    # Drop an extras bracket wherever it sits, then keep the specifier.
    version = re.sub(r"\[[^\]]*\]", "", rest).strip()
    return name, version or _MISSING


def _field(fields: list[str], index: int) -> str:
    return fields[index] if len(fields) > index else _MISSING


def note(message: str) -> None:
    print(message, file=sys.stderr)


def main(argv: list[str]) -> int:
    target = argv[1] if len(argv) > 1 else "."
    root = Path(target)
    if not _is_dir(root):
        note(f"detect.py: '{target}' is not a directory")
        return 2

    detector = Detector(root)
    detector.scan_node()
    detector.scan_python()
    detector.scan_rust()
    detector.scan_go()
    detector.scan_ruby()
    detector.scan_php()

    out = sys.stdout
    for row in detector.rows:
        out.write("\t".join(row) + "\n")
    out.flush()

    found = len(detector.rows)
    note("")
    note(f"detect: {found} dependency declaration(s) found in {target}")
    if not found:
        note("No supported manifest found (package.json, uv.lock, poetry.lock,")
        note("requirements.txt, pyproject.toml, Cargo.toml, go.mod, Gemfile,")
        note("composer.json).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
