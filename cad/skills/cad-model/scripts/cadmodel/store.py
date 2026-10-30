"""The content-addressed store of a project's per-part outputs, so each byte sequence is kept once.

Objects (cad-record layout `cache.part_objects`, `hw/.cad/parts/<sha256>`) are the bytes of generated
files, named by their sha256. A version holds a hard link to each where the filesystem allows one,
else a byte copy, so readers keep reading the version's own paths. Records (`cache.part_records`,
`hw/.cad/builds/<key>.json`) map the sha256 of an output's inputs (`key`) to the objects and facts
that output had. Both directories ignore themselves in git and are disposable: deleting them costs a
rebuild, never a version, because every version file is a link or copy of its own.

Nothing is rewritten in place: an object or a record is written beside its name and renamed onto it,
so a link a version holds always keeps the bytes it was sealed with. Every object is checked against
its name before it is reused.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from pathlib import Path
from typing import Any, Mapping

from cadmodel.record import load_layout

FORMAT = 1  # the record format; a record of another format is never reused
SHA = re.compile(r"[0-9a-f]{64}")


def key(material: Mapping[str, Any]) -> str:
    """The sha256 of `material` as canonical JSON (cad-record layout `recipe_sha256`)."""
    return load_layout().recipe_sha256(material)


def file_sha(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _link_or_copy(source: Path, target: Path) -> None:
    try:
        os.link(source, target)
    except OSError:  # no hard links here (another filesystem, FAT, a link limit): the same bytes, copied
        shutil.copyfile(source, target)


class Store:
    def __init__(self, hw: Path) -> None:
        self.hw = hw
        self.layout = load_layout()
        self._held: dict[str, bool] = {}  # objects already checked in this run

    def _path(self, entry_id: str, sha: str) -> Path:
        return self.layout.resolve(self.hw, entry_id, SHA=sha)

    def _directory(self, path: Path) -> Path:
        """`path`'s directory, created with the `.gitignore` that keeps it out of git."""
        folder = path.parent
        if not (folder / ".gitignore").is_file():
            folder.mkdir(parents=True, exist_ok=True)
            (folder / ".gitignore").write_text("*\n", encoding="utf-8")
        return folder

    def holds(self, sha: Any) -> bool:
        """Whether the object `sha` exists and its bytes still hash to its name."""
        if not isinstance(sha, str) or not SHA.fullmatch(sha):
            return False
        if sha not in self._held:
            path = self._path("cache.part_objects", sha)
            self._held[sha] = path.is_file() and file_sha(path) == sha
        return self._held[sha]

    def intern(self, path: Path) -> str:
        """Store the file at `path` and return its sha256. When the store already holds those bytes,
        `path` becomes a link to that object, so the bytes are kept once."""
        sha = file_sha(path)
        if self.holds(sha):
            self.place(sha, path)
            return sha
        target = self._path("cache.part_objects", sha)
        staged = self._directory(target) / f".{sha}.{os.getpid()}.tmp"
        _link_or_copy(path, staged)
        os.replace(staged, target)
        self._held[sha] = True
        return sha

    def place(self, sha: str, target: Path) -> None:
        """Make `target` the object `sha`: a hard link where possible, else a copy; never written in place."""
        target.parent.mkdir(parents=True, exist_ok=True)
        staged = target.with_name(f".{target.name}.{os.getpid()}.link")
        _link_or_copy(self._path("cache.part_objects", sha), staged)
        os.replace(staged, target)

    def record(self, record_key: str) -> dict[str, Any] | None:
        """The record saved under `record_key`, or None when there is none, it is unreadable or of another
        format, or an object it names is missing or no longer matches its sha256."""
        try:
            data = json.loads(self._path("cache.part_records", record_key).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        objects = data.get("objects") if isinstance(data, dict) and data.get("format") == FORMAT else None
        if not isinstance(objects, dict) or not all(self.holds(sha) for sha in objects.values()):
            return None
        return data

    def save(self, record_key: str, record: Mapping[str, Any]) -> None:
        """Save `record` (its `objects` map a name to an object sha256) under `record_key`."""
        target = self._path("cache.part_records", record_key)
        staged = self._directory(target) / f".{record_key}.json.{os.getpid()}.tmp"
        staged.write_text(json.dumps({"format": FORMAT, **record}, indent=1, sort_keys=True) + "\n", encoding="utf-8")
        os.replace(staged, target)
