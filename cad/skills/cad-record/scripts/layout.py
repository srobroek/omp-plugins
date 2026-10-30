#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""The canonical hw/ layout: resolve, classify and audit paths, and publish sealed bundles.

`layout.json` in the cad-record skill is the source of truth, `schemas/layout.schema.json`
validates it, and `references/layout.md` is generated from it with `layout.py --markdown`. This
module is its one reader. It uses the standard library only, so any CAD skill can load it by path;
register the module in `sys.modules` before executing it, because dataclasses look it up there.
`references/layout-api.md` describes the consumer API.
"""

from __future__ import annotations

import argparse
import functools
import hashlib
import json
import os
import posixpath
import re
import shutil
import sys
import time
import uuid
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

LAYOUT_JSON = Path(__file__).resolve().parent.parent / "layout.json"
HW = "hw"
SCRATCH = ".cad-work"
MANIFEST = "manifest.json"
BUNDLE_SCHEMA_VERSION = 1
ANY_PATH_EXAMPLE = "notes/example.md"  # what `**` stands for in a generated example path
_TOKEN = re.compile(r"\{([A-Z][A-Z_]*)\}")


class LayoutError(ValueError):
    """A path, parameter, staged bundle or layout.json entry the layout does not admit."""


class PublishConflict(LayoutError):
    """The bundle directory exists with another recipe, or another writer claimed it first."""


@dataclass(frozen=True)
class FileSpec:
    name: str
    role: str
    optional: bool
    excludes: tuple[str, ...]  # stray classes this name never accepts, such as geometry under hw/docs
    pattern: re.Pattern[str]


@dataclass(frozen=True)
class Entry:
    id: str
    path: str
    kind: str
    role: str | None  # a file entry's role; None for a directory entry, whose files carry roles
    files: tuple[FileSpec, ...]
    writer: str
    stage: str
    mutability: str
    manifest: str | None  # version, bundle or release: the manifest.json format that seals the directory
    meaning: str
    pattern: re.Pattern[str]


@dataclass(frozen=True)
class Match:
    """Where a path sits in the layout: its entry, the token values in it, and its file role."""

    entry: Entry
    params: Mapping[str, str]
    name: str | None  # the matching file name template of a directory entry
    role: str


@dataclass(frozen=True)
class Exemption:
    id: str
    path: str
    directory: bool
    kind: str  # transient and metadata are reported; vcs is accepted silently
    writer: str
    action: str
    pattern: re.Pattern[str]


@dataclass(frozen=True)
class Rule:
    code: str
    match: str | None
    referenced_by: str | None
    directory: bool
    canonical: str
    message: str
    action: str
    pattern: re.Pattern[str] | None


@dataclass(frozen=True)
class StrayClass:
    name: str
    suffixes: tuple[str, ...]
    canonical: str
    file_by_suffix: Mapping[str, str]
    message: str
    action: str


@dataclass(frozen=True)
class Problem:
    """One layout finding. `path` is project-relative; `severity` is stage, warning or error."""

    code: str
    path: str
    message: str
    action: str
    canonical_location: str | None
    severity: str


@dataclass(frozen=True)
class Audit:
    problems: tuple[Problem, ...]
    bundles: tuple[str, ...]  # project-relative manifest.json of every sealed bundle whose inventory reads


@dataclass(frozen=True)
class ManufacturePolicy:
    """The effective manufacturing contract of one custom-made part."""

    relationship: str  # same or different
    state: str | None
    reason: str | None
    decision: str | None
    volume_rel_tolerance: float
    volume_abs_tolerance_mm3: float
    linear_deflection_mm: float
    angular_deflection_rad: float
    outputs: tuple[str, ...]  # file names under hw/versions/<V>/manufacturing/<PN>/

    def volume_tolerance_mm3(self, installed_volume_mm3: float) -> float:
        """Allowed |manufactured - installed| volume: the absolute floor or the relative share, whichever is larger."""
        return max(self.volume_abs_tolerance_mm3, self.volume_rel_tolerance * abs(installed_volume_mm3))


@dataclass(frozen=True)
class Published:
    path: Path
    manifest: Mapping[str, Any]
    reused: bool  # an identical, verified bundle already existed; nothing was written
    replaced: Path | None  # where the bundle this one replaced now lives, under .cad-work/replaced/


class Layout:
    """layout.json compiled: every path template becomes an anchored regular expression."""

    def __init__(self, data: Mapping[str, Any]) -> None:
        self.data = data
        self.tokens: Mapping[str, Mapping[str, str]] = data["tokens"]
        self.entries = tuple(self._entry(item) for item in data["entries"])
        self.by_id = {entry.id: entry for entry in self.entries}
        if len(self.by_id) != len(self.entries):
            raise LayoutError("layout.json: entry ids are not unique")
        self.exemptions = tuple(
            Exemption(item["id"], item["path"], bool(item.get("directory")), item["kind"], item["writer"],
                      item["action"], self.compile(item["path"]))
            for item in data["exceptions"])
        self.rules = tuple(
            Rule(item["code"], item.get("match"), item.get("referenced_by"), bool(item.get("directory")),
                 item["canonical"], item["message"], item["action"],
                 self.compile(item["match"]) if "match" in item else None)
            for item in data["rules"])
        self.classes = tuple(
            StrayClass(item["class"], tuple(item["suffixes"]), item["canonical"], item.get("file_by_suffix", {}),
                       item["message"], item["action"])
            for item in data["classes"])
        if not self.classes or self.classes[-1].suffixes:
            raise LayoutError("layout.json: the last stray class must take every other suffix")
        self.findings: Mapping[str, Mapping[str, str]] = data["findings"]
        unknown = sorted({rule.code for rule in self.rules} - set(self.findings))
        if unknown:
            raise LayoutError(f"layout.json: rules use finding codes {unknown} that findings does not define")
        self.manufacturing: Mapping[str, Any] = data["manufacturing"]
        self._directories = tuple({p.pattern: p for p in self._directory_patterns()}.values())

    def _entry(self, item: Mapping[str, Any]) -> Entry:
        files = tuple(FileSpec(spec["name"], spec["role"], bool(spec.get("optional")), tuple(spec.get("excludes", ())),
                               self.compile(f"{item['path']}/{spec['name']}"))
                      for spec in item.get("files", ()))
        return Entry(item["id"], item["path"], item["kind"], item.get("role"), files, item["writer"], item["stage"],
                     item["mutability"], item.get("manifest"), item["meaning"], self.compile(item["path"]))

    def compile(self, template: str) -> re.Pattern[str]:
        """A template's anchored pattern: `{TOKEN}` captures its grammar; `**` spans nested names
        (one or more at the end, zero or more in the middle)."""
        segments = template.split("/")
        named: set[str] = set()
        pieces = []
        for index, segment in enumerate(segments):
            last = index == len(segments) - 1
            if segment == "**":
                pieces.append(r"[^/]+(?:/[^/]+)*" if last else r"(?:[^/]+/)*")
                continue
            pieces.append(self._segment(segment, named) + ("" if last else "/"))
        return re.compile("".join(pieces))

    def _segment(self, segment: str, named: set[str]) -> str:
        pieces, position = [], 0
        for found in _TOKEN.finditer(segment):
            name = found.group(1)
            if name not in self.tokens:
                raise LayoutError(f"layout.json: unknown token {{{name}}} in {segment!r}")
            pieces.append(re.escape(segment[position:found.start()]))
            pieces.append(f"(?P={name})" if name in named else f"(?P<{name}>(?:{self.tokens[name]['pattern']}))")
            named.add(name)
            position = found.end()
        pieces.append(re.escape(segment[position:]))
        return "".join(pieces)

    def _directory_patterns(self) -> Iterable[re.Pattern[str]]:
        """Every directory some entry path passes through, or that a trailing `**` admits."""
        for entry in self.entries:
            templates = [f"{entry.path}/{spec.name}" for spec in entry.files] or [entry.path]
            for template in templates:
                segments = template.split("/")
                for count in range(1, len(segments)):
                    yield self.compile("/".join(segments[:count]))
                    if segments[count - 1] == "**":
                        break
                if segments[-1] == "**":
                    yield self.compile(template)

    @staticmethod
    def fill(template: str, values: Mapping[str, str]) -> str:
        """`template` with each `{NAME}` that `values` holds replaced; others stay as written."""
        return _TOKEN.sub(lambda found: values.get(found.group(1), found.group(0)), template)

    def entry(self, entry_id: str) -> Entry:
        try:
            return self.by_id[entry_id]
        except KeyError:
            raise LayoutError(f"no layout entry {entry_id!r}") from None

    def example(self, entry: Entry, name: str | None = None) -> str:
        """The entry's path, or one of its files, with every token at its example value."""
        examples = {token: spec["example"] for token, spec in self.tokens.items()}
        template = entry.path if name is None else f"{entry.path}/{name}"
        return "/".join(ANY_PATH_EXAMPLE if segment == "**" else self.fill(segment, examples)
                        for segment in template.split("/"))

    def path(self, entry_id: str, params: Mapping[str, str]) -> str:
        """The project-relative path of `entry_id` with its tokens set; every value must match its grammar."""
        entry = self.entry(entry_id)
        wanted = set(_TOKEN.findall(entry.path))
        if set(params) != wanted:
            raise LayoutError(f"{entry_id} takes {sorted(wanted)}, got {sorted(params)}")
        for name, value in params.items():
            if not isinstance(value, str) or not re.fullmatch(f"(?:{self.tokens[name]['pattern']})", value):
                raise LayoutError(f"{name} {value!r} does not match {self.tokens[name]['pattern']}")
        return self.fill(entry.path, params)

    def stray_class(self, rel: str) -> StrayClass:
        suffix = PurePosixPath(rel).suffix.lower()
        return next((c for c in self.classes if suffix in c.suffixes), self.classes[-1])

    def classify(self, rel: str) -> Match | None:
        for entry in self.entries:
            if not entry.files:
                found = entry.pattern.fullmatch(rel)
                if found:
                    return Match(entry, found.groupdict(), None, entry.role or "")
                continue
            for spec in entry.files:
                found = spec.pattern.fullmatch(rel)
                if found and self.stray_class(rel).name not in spec.excludes:
                    return Match(entry, found.groupdict(), spec.name, spec.role)
        return None

    def known_directory(self, rel: str) -> bool:
        return any(pattern.fullmatch(rel) for pattern in self._directories)

    def sealed(self, rel: str) -> tuple[Entry, dict[str, str]] | None:
        """The entry whose manifest.json seals directory `rel`, with the token values in `rel`."""
        for entry in self.entries:
            if entry.manifest and entry.files:
                found = entry.pattern.fullmatch(rel)
                if found:
                    return entry, found.groupdict()
        return None

    def exemption(self, rel: str, directory: bool) -> Exemption | None:
        return next((e for e in self.exemptions if (directory or not e.directory) and e.pattern.fullmatch(rel)), None)

    def rule(self, rel: str, directory: bool) -> tuple[Rule, dict[str, str]] | None:
        for rule in self.rules:
            if rule.pattern is not None and rule.directory == directory:
                found = rule.pattern.fullmatch(rel)
                if found:
                    return rule, found.groupdict()
        return None

    def referenced_rule(self) -> Rule | None:
        return next((rule for rule in self.rules if rule.referenced_by), None)


@functools.cache
def load() -> Layout:
    """The plugin's layout.json; projects cannot redefine it."""
    try:
        data = json.loads(LAYOUT_JSON.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise LayoutError(f"cannot read {LAYOUT_JSON}: {error}") from error
    return Layout(data)


# --- resolving paths -----------------------------------------------------------------------------------------------

def locate(hw: Path, rel: str) -> Path:
    """The filesystem path of project-relative `rel` (`hw/...` or `.cad-work/...`) for the record at `hw`."""
    hw = Path(hw)
    if rel == HW:
        return hw
    if rel.startswith(f"{HW}/"):
        return hw / rel[len(HW) + 1:]
    if rel == SCRATCH or rel.startswith(f"{SCRATCH}/"):
        return hw.parent / rel
    raise LayoutError(f"{rel!r} is neither under {HW}/ nor under {SCRATCH}/")


def relative(hw: Path, path: Path | str) -> str:
    """`path` as a project-relative POSIX path: `hw/...`, or `.cad-work/...` beside it."""
    hw_abs = Path(os.path.abspath(hw))
    target = Path(os.path.abspath(path))
    for base, prefix in ((hw_abs, HW), (hw_abs.parent / SCRATCH, SCRATCH)):
        try:
            rest = target.relative_to(base).as_posix()
        except ValueError:
            continue
        return prefix if rest == "." else f"{prefix}/{rest}"
    raise LayoutError(f"{path} is neither in {hw} nor in its {SCRATCH}/")


def resolve(hw: Path, entry_id: str, **params: str) -> Path:
    """The filesystem path of layout entry `entry_id` with its tokens set, such as V="v3" and PN="LMP-0001"."""
    return locate(hw, load().path(entry_id, params))


def version_dir(hw: Path, version: str) -> Path:
    return resolve(hw, "version.core", V=version)


def manufacturing_dir(hw: Path, version: str, pn: str) -> Path:
    return resolve(hw, "version.manufacturing", V=version, PN=pn)


def bundle_kinds() -> tuple[str, ...]:
    """The version-bound bundle roots: checks, drawings, renders, captures, motion, analysis."""
    return tuple(entry.id.split(".", 1)[1] for entry in load().entries if entry.id.startswith("bundle."))


def bundle_dir(hw: Path, kind: str, version: str, subject: str) -> Path:
    """`hw/<kind>/<version>/<subject>/`: one bundle per version and subject."""
    if kind not in bundle_kinds():
        raise LayoutError(f"bundle kind must be one of {list(bundle_kinds())}, got {kind!r}")
    return resolve(hw, f"bundle.{kind}", V=version, S=subject)


def classify(path: Path | str, hw: Path | None = None) -> Match | None:
    """The layout entry `path` belongs to, or None. Pass `hw` to classify a filesystem path;
    without it `path` is project-relative (`hw/...`)."""
    rel = relative(hw, path) if hw is not None else PurePosixPath(path).as_posix()
    return load().classify(rel)


def _version_number(label: str) -> int:
    return int(label[1:])  # V is v<number>


def versions(hw: Path) -> list[str]:
    """Built version labels, oldest first: folders named by the V grammar that hold a manifest.json."""
    pattern = f"(?:{load().tokens['V']['pattern']})"
    try:
        children = list(os.scandir(Path(hw) / "versions"))
    except (FileNotFoundError, NotADirectoryError):
        return []
    labels = [child.name for child in children if re.fullmatch(pattern, child.name)
              and child.is_dir(follow_symlinks=False) and (Path(child.path) / MANIFEST).is_file()]
    return sorted(labels, key=_version_number)


def next_version(hw: Path) -> str:
    """The label the next cad-model run takes: one above every folder in hw/versions named by the V grammar."""
    pattern = f"(?:{load().tokens['V']['pattern']})"
    try:
        names = [child.name for child in os.scandir(Path(hw) / "versions")]
    except (FileNotFoundError, NotADirectoryError):
        names = []
    return f"v{max((_version_number(n) for n in names if re.fullmatch(pattern, n)), default=0) + 1}"


def latest(hw: Path) -> str | None:
    """The label hw/versions/latest.json names, or None without a latest.json; LayoutError when it is
    malformed or names a version that is not built."""
    pointer = Path(hw) / "versions" / "latest.json"
    if not pointer.is_file():
        return None
    try:
        data = json.loads(pointer.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise LayoutError(f"cannot read {pointer}: {error}") from error
    label = data.get("label") if isinstance(data, dict) else None
    if not isinstance(label, str):
        raise LayoutError(f"{pointer}: `label` must be a version label, got {label!r}")
    if not (version_dir(hw, label) / MANIFEST).is_file():
        raise LayoutError(f"{pointer} names {label}, which is not a built version")
    return label


# --- custom-made parts ---------------------------------------------------------------------------------------------

def _field(document: Mapping[str, Any], dotted: str) -> Any:
    value: Any = document
    for key in dotted.split("."):
        if not isinstance(value, Mapping):
            return None
        value = value.get(key)
    return value


def custom_made(part: Mapping[str, Any]) -> bool:
    """Whether a part record needs a manufacturing output: make_buy make, or procurement.mode made_to_drawing."""
    return any(_field(part, condition["field"]) == condition["equals"]
               for condition in load().manufacturing["custom_made"])


def manufacture_policy(part: Mapping[str, Any]) -> ManufacturePolicy:
    """The effective manufacturing contract of a schema-valid custom-made part record."""
    if not custom_made(part):
        raise LayoutError(f"{part.get('PN')} is not custom-made, so it has no manufacturing output")
    rules = load().manufacturing
    outputs = rules["outputs"].get(part.get("process"))
    if outputs is None:
        raise LayoutError(f"{part.get('PN')}: no manufacturing outputs for process {part.get('process')!r}")
    declared = part.get("manufacture") or {}
    mesh = {**rules["mesh"], **(declared.get("mesh") or {})}
    if declared.get("relationship") == "different":
        if "volume_rel_tolerance" not in declared and "volume_abs_tolerance_mm3" not in declared:
            raise LayoutError(f"{part.get('PN')} declares a different manufacturing state without a volume tolerance")
        relative_tolerance = float(declared.get("volume_rel_tolerance", 0.0))
        absolute_tolerance = float(declared.get("volume_abs_tolerance_mm3", 0.0))
        relationship = "different"
    else:
        relative_tolerance, absolute_tolerance = float(rules["same_state_volume_rel_tolerance"]), 0.0
        relationship = "same"
    return ManufacturePolicy(relationship, declared.get("state"), declared.get("reason"), declared.get("decision"),
                             relative_tolerance, absolute_tolerance, float(mesh["linear_deflection_mm"]),
                             float(mesh["angular_deflection_rad"]), tuple(outputs))


# --- auditing a record ---------------------------------------------------------------------------------------------

def _safe_name(name: str) -> bool:
    """A printable name without separators, edge whitespace, control characters or undecodable bytes."""
    if name in ("", ".", "..") or name != name.strip() or "\\" in name or "/" in name:
        return False
    for character in name:
        code = ord(character)
        if code < 32 or code == 127 or 0xDC80 <= code <= 0xDCFF:  # 0xDC80-0xDCFF: os.fsdecode's undecodable bytes
            return False
    return True


def _safe_relative(name: Any) -> bool:
    return isinstance(name, str) and all(_safe_name(part) for part in name.split("/"))


def _within(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


class _Report:
    def __init__(self, lay: Layout, hw: Path) -> None:
        self.lay, self.hw = lay, hw
        self.problems: list[Problem] = []
        self._next: str | None = None

    @property
    def next_label(self) -> str:
        if self._next is None:
            self._next = next_version(self.hw)
        return self._next

    def add(self, code: str, path: str, *, values: Mapping[str, str] | None = None, message: str | None = None,
            action: str | None = None, canonical: str | None = None) -> None:
        spec = self.lay.findings[code]
        values = {"PATH": path, **(values or {})}
        self.problems.append(Problem(code, path, message or self.lay.fill(spec["message"], values),
                                     action or self.lay.fill(spec["action"], values), canonical, spec["severity"]))

    def exempt(self, exemption: Exemption, rel: str) -> None:
        if exemption.kind in ("transient", "metadata"):
            self.add(f"layout.{exemption.kind}", rel, values={"WRITER": exemption.writer}, action=exemption.action)

    def rule(self, rule: Rule, params: Mapping[str, str], rel: str) -> None:
        values = {**params, "PATH": rel, "NAME": posixpath.basename(rel)}
        fill = self.lay.fill
        self.add(rule.code, rel, message=fill(rule.message, values), action=fill(rule.action, values),
                 canonical=fill(rule.canonical, values))

    def stray(self, rel: str) -> None:
        stray = self.lay.stray_class(rel)
        found = re.search(f"(?<![A-Z])(?:{self.lay.tokens['PN']['pattern']})(?![0-9])", rel)
        values = {"PATH": rel, "PN": found.group(0) if found else "<PN>", "NEXT": self.next_label,
                  "REL": rel[len(HW) + 1:], "NAME": posixpath.basename(rel),
                  "FILE": stray.file_by_suffix.get(PurePosixPath(rel).suffix.lower(), "")}
        fill = self.lay.fill
        self.add("layout.stray", rel, message=fill(stray.message, values), action=fill(stray.action, values),
                 canonical=fill(stray.canonical, values))


def _walk(lay: Layout, hw: Path, report: _Report) -> tuple[list[str], list[tuple[str, bool]]]:
    """Every regular file and directory below hw/, symlinks reported and never followed."""
    files: list[str] = []
    directories: list[tuple[str, bool]] = []
    real_root = os.path.realpath(hw)
    stack = [(hw, HW)]
    while stack:
        directory, rel_dir = stack.pop()
        try:
            with os.scandir(directory) as iterator:
                children = sorted(iterator, key=lambda child: child.name)
        except OSError as error:
            report.add("layout.unsafe_path", rel_dir, message=f"{rel_dir} cannot be read: {error.strerror}")
            continue
        if rel_dir != HW:
            directories.append((rel_dir, not children))
        for child in children:
            rel = f"{rel_dir}/{child.name}"
            if not _safe_name(child.name):
                report.add("layout.unsafe_path", rel)
                continue
            if child.is_symlink():
                try:
                    target = os.readlink(child.path)
                except OSError:
                    target = "an unreadable target"
                inside = _within(os.path.realpath(child.path), real_root)
                report.add("layout.symlink" if inside else "layout.symlink_escape", rel, values={"TARGET": target})
                continue
            is_directory = child.is_dir(follow_symlinks=False)
            if not is_directory and not child.is_file(follow_symlinks=False):
                report.add("layout.unsafe_path", rel)
                continue
            exemption = lay.exemption(rel, is_directory)
            if exemption is not None:
                report.exempt(exemption, rel)
                continue
            if not is_directory:
                files.append(rel)
                continue
            found = lay.rule(rel, True)
            if found is not None:
                report.rule(*found, rel)
                continue
            stack.append((Path(child.path), rel))
    return files, directories


def _inventory(hw: Path, rel: str, entry: Entry, params: Mapping[str, str]) -> tuple[set[str] | None, str | None]:
    """(names the sealing manifest lists, None), (None, None) for a manifest without an inventory, or (None, problem)."""
    try:
        data = json.loads(locate(hw, f"{rel}/{MANIFEST}").read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        return None, f"cannot read the manifest: {error}"
    if not isinstance(data, dict):
        return None, "the manifest is not a JSON object"
    name = posixpath.basename(rel)
    if entry.manifest == "release" and "schema_version" not in data:
        return None, None  # a version 1 release lists project files in place; validate.py checks them
    if entry.manifest == "version" and data.get("label", name) != name:
        return None, f"label {data.get('label')!r} is not the folder name {name}"
    if entry.manifest == "bundle":
        if data.get("layout") != entry.id or data.get("path") != rel:
            return None, f"it names {data.get('layout')!r} at {data.get('path')!r}, not {entry.id} at {rel}"
        if "V" in params:
            version_manifest = version_dir(hw, params["V"]) / MANIFEST
            if not version_manifest.is_file():
                return None, f"it is bound to {params['V']}, which is not built"
            if data.get("version_manifest_sha256") != _sha256(version_manifest):
                return None, f"version_manifest_sha256 is not the sha256 of versions/{params['V']}/{MANIFEST}"
    files = data.get("files")
    if not isinstance(files, dict):
        return None, "it has no `files` inventory"
    unsafe = sorted(str(key) for key in files if not _safe_relative(key) or key == MANIFEST)
    if unsafe:
        return None, f"`files` names unsafe paths {unsafe}"
    return set(files), None


def audit(hw: Path, references: Mapping[str, str] | None = None) -> Audit:
    """Every file and directory under `hw` against the layout. `references` maps a project-relative
    file that a part record names (procurement/specification/artifact) to that part's PN."""
    lay, hw = load(), Path(hw)
    references = references or {}
    report = _Report(lay, hw)
    files, directories = _walk(lay, hw, report)
    present = set(files)
    sealed = {rel: found for rel, _ in directories if (found := lay.sealed(rel)) is not None}

    listed: dict[str, set[str]] = {}  # sealed directory -> the project-relative files its manifest lists
    unlisted: set[str] = set()
    bundles = []
    for rel, (entry, params) in sorted(sealed.items()):
        values = {"DIR": rel, "WRITER": entry.writer}
        if f"{rel}/{MANIFEST}" not in present:
            report.add("layout.unsealed", rel, values=values)
            continue
        names, problem = _inventory(hw, rel, entry, params)
        if problem is not None:
            report.add("layout.malformed_manifest", f"{rel}/{MANIFEST}", values={**values, "PROBLEM": problem})
            continue
        if names is None:
            continue
        expected = {f"{rel}/{name}" for name in names}
        listed[rel] = expected
        inside = {f for f in files if f.startswith(f"{rel}/") and f != f"{rel}/{MANIFEST}"}
        for path in sorted(inside - expected):
            report.add("layout.unlisted", path, values=values)
            unlisted.add(path)
        for path in sorted(expected - inside):
            report.add("layout.missing", path, values=values)
        if entry.manifest == "bundle":
            bundles.append(f"{rel}/{MANIFEST}")

    referenced = lay.referenced_rule()
    for rel in files:
        if rel in unlisted:
            continue
        match = lay.classify(rel)
        pn = references.get(rel)
        if pn is not None and referenced is not None:
            values = {"PATH": rel, "PN": pn, "NAME": posixpath.basename(rel)}
            canonical = lay.fill(referenced.canonical, values)
            home = lay.classify(canonical)
            if match is None or home is None or match.entry is not home.entry:
                report.add(referenced.code, rel, message=lay.fill(referenced.message, values),
                           action=lay.fill(referenced.action, values), canonical=canonical)
            continue
        if match is not None:
            continue
        found = lay.rule(rel, False)
        if found is not None:
            report.rule(*found, rel)
            continue
        owner = max((d for d in sealed if rel.startswith(f"{d}/")), key=len, default=None)
        if owner is not None:
            entry = sealed[owner][0]
            report.add("layout.foreign", rel, values={"ENTRY": entry.id, "DIR": owner, "WRITER": entry.writer,
                                                      "FILES": ", ".join(spec.name for spec in entry.files)})
            continue
        report.stray(rel)
    for rel, empty in directories:
        if empty and rel not in sealed and not lay.known_directory(rel):
            report.add("layout.empty_directory", rel)
    return Audit(tuple(sorted(report.problems, key=lambda p: (p.path, p.code))), tuple(bundles))


# --- publishing a sealed bundle ------------------------------------------------------------------------------------

def canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def recipe_sha256(recipe: Mapping[str, Any]) -> str:
    """sha256 of the recipe as canonical JSON: sorted keys, no whitespace."""
    return hashlib.sha256(canonical_json(recipe)).hexdigest()


def _tree(directory: Path) -> tuple[set[str], list[str], list[str]]:
    """(regular files, symlinks or special files or unsafe names, empty directories) below `directory`."""
    files: set[str] = set()
    odd: list[str] = []
    empty: list[str] = []
    for root, dirnames, filenames in os.walk(directory, followlinks=False):
        rel_root = Path(root).relative_to(directory).as_posix()
        prefix = "" if rel_root == "." else f"{rel_root}/"
        for name in list(dirnames):
            if (Path(root) / name).is_symlink() or not _safe_name(name):
                odd.append(prefix + name)
                dirnames.remove(name)
        for name in filenames:
            path = Path(root) / name
            if path.is_symlink() or not path.is_file() or not _safe_name(name):
                odd.append(prefix + name)
            else:
                files.add(prefix + name)
        if prefix and not dirnames and not filenames:
            empty.append(rel_root)
    return files, sorted(odd), sorted(empty)


def verify(directory: Path) -> list[str]:
    """Problems with a sealed directory against its manifest.json `files` inventory: unreadable
    manifest, missing, changed or unlisted files, links. Empty when it verifies."""
    directory = Path(directory)
    try:
        manifest = json.loads((directory / MANIFEST).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        return [f"cannot read {directory / MANIFEST}: {error}"]
    inventory = manifest.get("files") if isinstance(manifest, dict) else None
    if not isinstance(inventory, dict):
        return [f"{directory / MANIFEST} has no files inventory"]
    files, odd, empty = _tree(directory)
    problems = [f"{name} is a link, a special file or an unsafe name" for name in odd]
    problems += [f"{name}/ is an empty directory" for name in empty]
    for name, expected in sorted(inventory.items()):
        if isinstance(expected, dict):  # a v2 release manifest lists {sha256, original}
            expected = expected.get("sha256")
        if not _safe_relative(name) or name == MANIFEST:
            problems.append(f"the manifest lists an unsafe path {name!r}")
        elif name not in files:
            problems.append(f"{name} is listed but missing")
        elif _sha256(directory / name) != expected:
            problems.append(f"{name} changed after it was sealed")
    problems += [f"{name} is not in the manifest" for name in sorted(files - set(inventory) - {MANIFEST})]
    return problems


def _bundle_entry(entry_id: str) -> Entry:
    entry = load().entry(entry_id)
    if entry.manifest != "bundle":
        raise LayoutError(f"{entry_id} is not a bundle; only its own writer seals it")
    return entry


def staging(hw: Path, entry_id: str) -> Path:
    """A new, empty directory under .cad-work/publication/ to write one bundle of `entry_id` into."""
    entry = _bundle_entry(entry_id)
    root = Path(hw).parent / SCRATCH / "publication"
    root.mkdir(parents=True, exist_ok=True)
    path = root / f"{entry.id}-{uuid.uuid4().hex}"
    path.mkdir()
    return path


def _staged_files(lay: Layout, entry: Entry, target_rel: str, staged: Path) -> dict[str, str]:
    files, odd, empty = _tree(staged)
    if odd or empty:
        raise LayoutError(f"{staged} holds links, special files, unsafe names or empty directories: {odd + empty}")
    if MANIFEST in files:
        raise LayoutError(f"{staged} holds {MANIFEST}; publish writes it")
    if not files:
        raise LayoutError(f"{staged} is empty")
    used = set()
    for name in sorted(files):
        match = lay.classify(f"{target_rel}/{name}")
        if match is None or match.entry is not entry:
            raise LayoutError(f"{name} is not a file a {entry.id} bundle holds "
                              f"({', '.join(spec.name for spec in entry.files)})")
        used.add(match.name)
    missing = [spec.name for spec in entry.files if not spec.optional and spec.name != MANIFEST and spec.name not in used]
    if missing:
        raise LayoutError(f"a {entry.id} bundle needs {missing}")
    return {name: _sha256(staged / name) for name in sorted(files)}


def _sha_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) else None


def built_version(hw: Path, requested: str) -> tuple[str, Path, Path]:
    """(label, version folder, record snapshot folder) of a built version; `requested` is a label or
    `latest`. LayoutError when it is not built, fails its manifest or has no record snapshot."""
    hw = Path(hw)
    label = latest(hw) if requested == "latest" else requested
    if label is None:
        raise LayoutError("no built version: versions/latest.json is absent")
    folder = version_dir(hw, label)
    if not (folder / MANIFEST).is_file():
        raise LayoutError(f"{label} is not a built version: {folder / MANIFEST} is missing")
    problems = verify(folder)
    if problems:
        raise LayoutError(f"{label} fails its manifest: {'; '.join(problems)}")
    record = resolve(hw, "version.record", V=label)
    if not record.is_dir():
        raise LayoutError(f"{label} has no record snapshot at {record}; build a new version")
    return label, folder, record


def scratch_path(hw: Path, path: Path | str, option: str) -> Path:
    """`path` resolved, when it lies under the project's .cad-work/; an explicit output override
    anywhere else is a LayoutError naming `option`."""
    target = Path(path).resolve()
    root = Path(os.path.realpath(Path(hw).parent / SCRATCH))
    if not _within(str(target), str(root)) or target == root:
        raise LayoutError(f"{option} must be under {root}, not {target}")
    return target


def _reusable(target: Path, recipe_sha: str, version_sha: str | None) -> dict[str, Any] | None:
    """The manifest of the bundle at `target` when it has this recipe and version manifest and verifies."""
    try:
        existing = json.loads((target / MANIFEST).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if (isinstance(existing, dict) and existing.get("recipe_sha256") == recipe_sha
            and existing.get("version_manifest_sha256") == version_sha and not verify(target)):
        return existing
    return None


def _version_sha(hw: Path, params: Mapping[str, str]) -> str | None:
    if "V" not in params:
        return None
    version_manifest = version_dir(hw, params["V"]) / MANIFEST
    if not version_manifest.is_file():
        raise LayoutError(f"{params['V']} is not a built version: {version_manifest} is missing")
    return _sha256(version_manifest)


def _recipe_conflict(target_rel: str) -> PublishConflict:
    return PublishConflict(f"{target_rel} exists with another recipe or does not verify; "
                           "a different recipe for the same version and subject needs --replace")


def reusable(hw: Path, entry_id: str, params: Mapping[str, str], recipe: Mapping[str, Any], *,
             replace: bool = False) -> Path | None:
    """Before running a producer: the existing bundle `publish` would return unchanged for this
    recipe, or None when there is none to reuse. An existing bundle with another recipe, or one that
    fails verification, is a PublishConflict unless `replace` (then None: run and publish)."""
    hw = Path(hw)
    _bundle_entry(entry_id)
    target_rel = load().path(entry_id, params)
    target = locate(hw, target_rel)
    if not os.path.lexists(target):
        return None
    canonical = json.loads(canonical_json(recipe))
    if _reusable(target, recipe_sha256(canonical), _version_sha(hw, params)) is not None:
        return target
    if not replace:
        raise _recipe_conflict(target_rel)
    return None



def publish(hw: Path, entry_id: str, params: Mapping[str, str], staged: Path, *, recipe: Mapping[str, Any],
            producer: str, status: str | None = None, replace: bool = False) -> Published:
    """Seal the files in `staged` (from `staging`) as the bundle of `entry_id` at `params`.

    The bundle path never holds anything but a complete bundle: `publish` writes manifest.json into
    the staging directory, claims the target with an exclusive mkdir and renames the staging
    directory onto it (POSIX rename onto the empty claim). An existing bundle with the same recipe
    and version manifest that still verifies is returned unchanged. Any other existing bundle is a
    PublishConflict unless `replace`: then it moves to .cad-work/replaced/ and the new manifest's
    `replaces` records it. On failure `staged` stays as scratch.
    """
    hw, staged = Path(hw), Path(staged)
    lay, entry = load(), _bundle_entry(entry_id)
    target_rel = lay.path(entry_id, params)
    target = locate(hw, target_rel)
    scratch_root = os.path.realpath(hw.parent / SCRATCH)
    if staged.is_symlink() or not staged.is_dir() or not _within(os.path.realpath(staged), scratch_root) \
            or os.path.realpath(staged) == scratch_root:
        raise LayoutError(f"stage the bundle in a directory under {hw.parent / SCRATCH}, not {staged}")
    files = _staged_files(lay, entry, target_rel, staged)
    version_sha = _version_sha(hw, params)
    if not isinstance(recipe, Mapping):
        raise LayoutError("the recipe must be a JSON object")
    recipe = json.loads(canonical_json(recipe))
    recipe_sha = recipe_sha256(recipe)

    replaces = None
    retained = None
    if os.path.lexists(target):
        existing = _reusable(target, recipe_sha, version_sha)
        if existing is not None:
            shutil.rmtree(staged)
            return Published(target, existing, reused=True, replaced=None)
        try:
            existing = json.loads((target / MANIFEST).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            existing = None
        if not replace:
            raise _recipe_conflict(target_rel)
        stamp = f"{time.time_ns()}-{uuid.uuid4().hex[:8]}"
        retained = hw.parent / SCRATCH / "replaced" / target_rel / stamp
        old_manifest = target / MANIFEST
        replaces = {"manifest_sha256": _sha256(old_manifest) if old_manifest.is_file() else None,
                    "recipe_sha256": _sha_or_none(existing.get("recipe_sha256")) if isinstance(existing, dict) else None,
                    "moved_to": f"{SCRATCH}/replaced/{target_rel}/{stamp}"}
        retained.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.rename(target, retained)
        except FileNotFoundError as error:
            raise PublishConflict(f"another writer replaced {target_rel} meanwhile") from error

    manifest: dict[str, Any] = {
        "schema_version": BUNDLE_SCHEMA_VERSION, "layout": entry_id, "path": target_rel,
        "params": dict(sorted(params.items())), "version_manifest_sha256": version_sha, "producer": producer,
    }
    if status is not None:
        manifest["status"] = status
    manifest.update(recipe=recipe, recipe_sha256=recipe_sha, files=files, replaces=replaces)
    manifest_path = staged / MANIFEST
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    try:
        claim(staged, target, target_rel)
    except PublishConflict as error:
        manifest_path.unlink()
        kept = f"; the bundle it replaced is kept at {replaces['moved_to']}" if replaces else ""
        raise PublishConflict(f"{error}{kept}") from error.__cause__
    except LayoutError:
        manifest_path.unlink(missing_ok=True)
        raise
    return Published(target, manifest, reused=False, replaced=retained)


def claim(staged: Path, target: Path, target_rel: str) -> None:
    """Rename `staged` onto `target`, which must not exist. An exclusive mkdir claims it first, so
    two writers never both land; PublishConflict when another writer holds it."""
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.mkdir(target)
    except FileExistsError as error:
        raise PublishConflict(f"another writer published {target_rel} first") from error
    try:
        os.rename(staged, target)
    except OSError as error:
        os.rmdir(target)
        raise LayoutError(f"cannot publish {target_rel}: {error}") from error


# --- references/layout.md ------------------------------------------------------------------------------------------

def _cell(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")


def _code(text: str) -> str:
    return f"`{_cell(text)}`"


def markdown() -> str:
    """references/layout.md, rendered from layout.json."""
    lay = load()
    data = lay.data
    lines = [
        "# CAD `hw/` layout",
        "",
        "Generated from `layout.json` by `python3 scripts/layout.py --markdown`. Edit `layout.json`, then regenerate",
        "this file; a cad-record test fails when the two disagree. Commands that read or write these paths use the",
        "API in [layout-api.md](layout-api.md).",
        "",
        "Paths are relative to the project root, the folder that holds `hw/`. `{TOKEN}` stands for a value of the",
        "token's grammar; `**` stands for one or more nested names. A path ending in `/` is a folder that holds the",
        "listed files and nothing else.",
        "",
        "## Tokens",
        "",
        "| Token | Grammar | Example | Meaning |",
        "|---|---|---|---|",
    ]
    for name, spec in lay.tokens.items():
        lines.append(f"| `{{{name}}}` | {_code(spec['pattern'])} | {_code(spec['example'])} | {_cell(spec['meaning'])} |")
    lines += ["", "## Paths", "",
              "| Id | Path | Kind | Files (role) | Writer | Appears at | Mutability | Meaning |",
              "|---|---|---|---|---|---|---|---|"]
    for entry in lay.entries:
        if entry.files:
            path = f"`{_cell(entry.path)}/`"
            files = ", ".join(f"`{_cell(s.name)}` ({s.role}{', optional' if s.optional else ''}"
                              f"{'; never ' + ' or '.join(s.excludes) if s.excludes else ''})" for s in entry.files)
        else:
            path, files = _code(entry.path), f"({entry.role})"
        kind = f"{entry.kind}, sealed by its {entry.manifest} manifest" if entry.manifest else entry.kind
        lines.append(f"| `{entry.id}` | {path} | {kind} | {files} | {_cell(entry.writer)} | {entry.stage} | "
                     f"{entry.mutability} | {_cell(entry.meaning)} |")
    legend = data["legend"]
    for title, key in (("Kinds", "kind"), ("Mutability", "mutability"), ("Roles", "role")):
        lines += ["", f"## {title}", "", "| Value | Meaning |", "|---|---|"]
        lines += [f"| `{value}` | {_cell(meaning)} |" for value, meaning in legend[key].items()]
    lines += ["", "## Accepted exceptions", "",
              "These paths are not part of the layout but have a known writer. `transient` and `metadata` paths are",
              "reported with the action below; `vcs` paths are accepted.", "",
              "| Path | Kind | Writer | Action |", "|---|---|---|---|"]
    lines += [f"| {_code(e.path)}{'/' if e.directory else ''} | {e.kind} | {_cell(e.writer)} | {_cell(e.action)} |"
              for e in lay.exemptions]
    lines += ["", "## Misplaced and legacy paths", "",
              "| Path | Finding | Canonical location | Action |", "|---|---|---|---|"]
    for rule in lay.rules:
        where = (f"a file part.yaml `{rule.referenced_by}` names" if rule.referenced_by
                 else f"{_code(rule.match or '')}{'/' if rule.directory else ''}")
        lines.append(f"| {where} | `{rule.code}` | {_code(rule.canonical)} | {_cell(rule.action)} |")
    lines += ["", "## Stray files", "",
              "Any other file is a `layout.stray` finding. Its suffix picks the class and the suggested location;",
              "`{PN}` is the first part number in the stray path, `{NEXT}` the next version label and `{REL}` the path",
              "below `hw/`.", "",
              "| Class | Suffixes | Canonical location | Action |", "|---|---|---|---|"]
    for stray in lay.classes:
        suffixes = ", ".join(f"`{s}`" for s in stray.suffixes) or "any other"
        lines.append(f"| {stray.name} | {suffixes} | {_code(stray.canonical)} | {_cell(stray.action)} |")
    lines += ["", "## Finding codes", "",
              "`validate.py` reports each layout finding with `code`, `path`, `canonical_location` and `action`.",
              "A `stage` finding is a warning before `design_freeze` and an error from `design_freeze` on. It stays an",
              "error at every stage once `product.yaml` `flow.frozen` is set or a release manifest exists, and when",
              "the stage is missing or unknown. Errors fail validation (exit 1); warnings are reported and do not.", "",
              "| Code | Severity | Meaning |", "|---|---|---|"]
    lines += [f"| `{code}` | {spec['severity']} | {_cell(spec['meaning'])} |" for code, spec in lay.findings.items()]
    rules = lay.manufacturing
    predicate = " or ".join(f"`{c['field']}: {c['equals']}`" for c in rules["custom_made"])
    lines += ["", "## Manufacturing outputs", "",
              f"A part is custom-made when {predicate}; catalogue buys are not. Every custom-made PN gets",
              "`hw/versions/{V}/manufacturing/{PN}/` with these files, by process:", "",
              "| Process | Files |", "|---|---|"]
    lines += [f"| {process} | {', '.join(f'`{name}`' for name in names)} |" for process, names in rules["outputs"].items()]
    lines += ["", "| File | Format |", "|---|---|"]
    lines += [f"| `{name}` | {_cell(text)} |" for name, text in rules["formats"].items()]
    mesh = rules["mesh"]
    lines += ["",
              f"The STL tessellation defaults to {mesh['linear_deflection_mm']} mm linear and "
              f"{mesh['angular_deflection_rad']} rad angular deflection; part.yaml `manufacture.mesh` overrides it per",
              "part. A part made in its installed shape compares the manufactured volume to the installed one within",
              f"{rules['same_state_volume_rel_tolerance']:g} relative. A part with `manufacture.relationship: different`",
              "declares its own `volume_rel_tolerance` or `volume_abs_tolerance_mm3`.", ""]
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--markdown", action="store_true", help="print references/layout.md")
    args = parser.parse_args(argv)
    if not args.markdown:
        parser.print_usage(sys.stderr)
        return 2
    sys.stdout.write(markdown())
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
