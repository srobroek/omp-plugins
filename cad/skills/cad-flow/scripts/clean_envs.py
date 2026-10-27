#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""List stale per-path uv environments of the CAD plugin's scripts; delete them only with --delete.

`uv run --script S` keeps one environment per script path, `<uv cache>/environments-v2/<stem>-<hash>`,
so each lightweight script copy can leave its own environment. Heavy scripts started with
`cad-flow/scripts/run.py` use environments shared by dependency set (`cadmodel.scriptenv`); uv keeps
those under `environments-v2/<interpreter hash>/`, and this script never lists them.

A per-path environment belongs to a CAD script when its `pyvenv.cfg` prompt (the file name uv
created it for) names a PEP 723 script this plugin ships and it holds every distribution that
script's header depends on. It is stale unless it is the environment of a script in this plugin
copy (`uv python find --script`) or was modified within --min-age-hours, which suggests a session
still uses it. uv recreates a deleted environment on the next run of its script.

Sizes: apparent is the files' length. Freed is what deletion returns to the volume. A file with
another hard link frees nothing. Otherwise macOS counts the file's private size (bytes no APFS clone
shares) and Linux the bytes in extents no other file shares (FIEMAP, so XFS or Btrfs reflinks of the
uv cache count as shared). Where neither applies, freed is the file's allocated blocks.

Usage:
    uv run --script clean_envs.py [--min-age-hours 24] [--json] [--delete]

Dry run unless --delete. Exit 0 on success, 1 when a deletion failed, 2 when uv is unavailable.
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.util
import json
import os
import re
import shutil
import stat
import struct
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable, Mapping, Sequence

CAD_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(CAD_ROOT / "skills" / "cad-model" / "scripts"))
from cadmodel import scriptenv  # noqa: E402 - standard library only

ENVIRONMENT_NAME = re.compile(r"^.+-[0-9a-f]{16}$")
# cad-recheck's install-hook.py copies stamp.py into a repository's hooks under this name.
INSTALLED_AS = {"cad-recheck-stamp.py": CAD_ROOT / "skills" / "cad-recheck" / "scripts" / "stamp.py"}


@dataclass(frozen=True)
class Environment:
    path: str
    script: str  # the file name uv created it for
    modified: float
    status: str  # stale | current (this plugin copy's) | recent (modified within --min-age-hours)
    apparent_bytes: int
    freed_bytes: int


def shipped_scripts(root: Path = CAD_ROOT) -> dict[str, list[Path]]:
    """File name -> the PEP 723 scripts of that name in the plugin, plus their installed copies."""
    scripts: dict[str, list[Path]] = {}
    for path in sorted(root.rglob("*.py")):
        try:
            scriptenv.metadata(path)
        except (OSError, UnicodeDecodeError, ValueError):
            continue
        scripts.setdefault(path.name, []).append(path)
    for name, source in INSTALLED_AS.items():
        if source.is_file():
            scripts.setdefault(name, []).append(source)
    return scripts


def _prompt(environment: Path) -> str | None:
    try:
        lines = (environment / "pyvenv.cfg").read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        return None
    for line in lines:
        key, _, value = line.partition("=")
        if key.strip() == "prompt":
            return value.strip()
    return None


def _site_packages(environment: Path) -> Path | None:
    return next(iter(sorted((environment / "lib").glob("python3*/site-packages"))), None)


def _installed(site: Path | None) -> frozenset[str]:
    if site is None:
        return frozenset()
    return frozenset(scriptenv.normalize(entry.name.split("-", 1)[0]) for entry in site.glob("*.dist-info"))


def belongs(environment: Path, scripts: Mapping[str, list[Path]]) -> str | None:
    """The shipped script file name this per-path environment was made for, or None."""
    if not ENVIRONMENT_NAME.match(environment.name) or not environment.is_dir():
        return None
    name = _prompt(environment)
    if name not in scripts:
        return None
    installed = _installed(_site_packages(environment))
    for script in scripts[name]:
        try:
            if scriptenv.dependency_names(script) <= installed:
                return name
        except (OSError, ValueError):
            continue
    return None


def current_environments(uv: str, scripts: Iterable[Path], root: Path) -> set[Path]:
    """The per-path environments under `root` that this plugin copy's scripts run in now."""
    current = set()
    for script in scripts:
        try:
            found = subprocess.run([uv, "python", "find", "--script", str(script)], capture_output=True,
                                   text=True, timeout=60, check=False)
        except (OSError, subprocess.TimeoutExpired):
            continue
        python = Path(found.stdout.strip()) if found.returncode == 0 and found.stdout.strip() else None
        if python is not None and python.is_relative_to(root):
            current.add(root / python.relative_to(root).parts[0])
    return current


class _AttrList(ctypes.Structure):
    _fields_ = [("bitmapcount", ctypes.c_ushort), ("reserved", ctypes.c_uint16), ("commonattr", ctypes.c_uint32),
                ("volattr", ctypes.c_uint32), ("dirattr", ctypes.c_uint32), ("fileattr", ctypes.c_uint32),
                ("forkattr", ctypes.c_uint32)]


def _darwin_private_size():
    """getattrlist(2)'s ATTR_CMNEXT_PRIVATESIZE: the bytes deleting a file frees, APFS-clone aware."""
    libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
    libc.getattrlist.argtypes = [ctypes.c_char_p, ctypes.POINTER(_AttrList), ctypes.c_void_p, ctypes.c_size_t,
                                 ctypes.c_ulong]
    request = _AttrList(5, 0, 0, 0, 0, 0, 0x00000008)  # ATTR_BIT_MAP_COUNT, ATTR_CMNEXT_PRIVATESIZE
    options = 0x00000001 | 0x00000020  # FSOPT_NOFOLLOW | FSOPT_ATTR_CMN_EXTENDED
    buffer = ctypes.create_string_buffer(16)

    def private_size(path: str) -> int | None:
        if libc.getattrlist(os.fsencode(path), ctypes.byref(request), buffer, len(buffer), options) != 0:
            return None
        return struct.unpack_from("=Iq", buffer.raw)[1]

    return private_size


FS_IOC_FIEMAP = 0xC020660B
FIEMAP_HEADER = struct.Struct("=QQIIII")  # fm_start, fm_length, fm_flags, fm_mapped_extents, fm_extent_count, reserved
FIEMAP_EXTENT = struct.Struct("=QQQQQIIII")  # fe_logical, fe_physical, fe_length, reserved x2, fe_flags, reserved x3
FIEMAP_EXTENT_LAST, FIEMAP_EXTENT_SHARED = 0x1, 0x2000
FIEMAP_BATCH = 64


def _linux_private_size(path: str) -> int | None:
    """Bytes in extents no other file shares (FIEMAP), so reflinked copies on XFS or Btrfs free nothing."""
    import fcntl

    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        return None
    private, start = 0, 0
    try:
        while True:
            request = bytearray(FIEMAP_HEADER.pack(start, (1 << 64) - 1 - start, 0, 0, FIEMAP_BATCH, 0)
                                + bytes(FIEMAP_EXTENT.size * FIEMAP_BATCH))
            fcntl.ioctl(descriptor, FS_IOC_FIEMAP, request)
            mapped = FIEMAP_HEADER.unpack_from(request)[3]
            if mapped == 0:
                return private
            for index in range(mapped):
                logical, _, length, _, _, flags, *_ = FIEMAP_EXTENT.unpack_from(
                    request, FIEMAP_HEADER.size + index * FIEMAP_EXTENT.size)
                if not flags & FIEMAP_EXTENT_SHARED:
                    private += length
                if flags & FIEMAP_EXTENT_LAST:
                    return private
            start = logical + length
    except OSError:
        return None
    finally:
        os.close(descriptor)


PRIVATE_SIZE = (_darwin_private_size() if sys.platform == "darwin" else
                _linux_private_size if sys.platform.startswith("linux") else None)


def measure(environment: Path) -> tuple[int, int]:
    """(apparent, freed) bytes of the regular files under `environment`."""
    apparent = freed = 0
    for folder, _, files in os.walk(environment):
        for name in files:
            path = os.path.join(folder, name)
            try:
                info = os.lstat(path)
            except OSError:
                continue
            if not stat.S_ISREG(info.st_mode):
                continue
            apparent += info.st_size
            if info.st_nlink > 1:  # another hard link keeps the data
                continue
            private = PRIVATE_SIZE(path) if PRIVATE_SIZE else None
            freed += private if private is not None else info.st_blocks * 512
    return apparent, freed


def _modified(environment: Path) -> float:
    site = _site_packages(environment)
    return max(path.stat().st_mtime for path in (environment, *([site] if site else [])))


def plan(root: Path, scripts: Mapping[str, list[Path]], current: set[Path], min_age_s: float,
         now: float | None = None, sizes=measure) -> list[Environment]:
    """Every per-path environment under `root` that belongs to a CAD script, with its status and sizes."""
    moment = time.time() if now is None else now
    found = []
    for environment in sorted(root.iterdir()) if root.is_dir() else ():
        script = belongs(environment, scripts)
        if script is None:
            continue
        modified = _modified(environment)
        status = ("current" if environment in current else
                  "recent" if moment - modified < min_age_s else "stale")
        apparent, freed = sizes(environment)
        found.append(Environment(str(environment), script, modified, status, apparent, freed))
    return sorted(found, key=lambda env: (env.script, env.modified))


def delete(environments: Iterable[Environment]) -> tuple[list[str], list[str]]:
    """Remove each stale environment; (deleted paths, errors)."""
    deleted, errors = [], []
    for environment in environments:
        if environment.status != "stale":
            continue
        try:
            shutil.rmtree(environment.path)
        except OSError as error:
            errors.append(f"{environment.path}: {error}")
        else:
            deleted.append(environment.path)
    return deleted, errors


def _size(count: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if count < 1000 or unit == "GB":
            return f"{count:.0f} {unit}" if unit == "B" else f"{count:.1f} {unit}"
        count /= 1000
    return f"{count:.1f} GB"


def render_text(root: Path, environments: Sequence[Environment], min_age_hours: float,
                deleted: Sequence[str] | None, errors: Sequence[str]) -> str:
    counts = {status: sum(env.status == status for env in environments) for status in ("stale", "current", "recent")}
    lines = [f"{len(environments)} per-path environments of CAD scripts in {root}: {counts['stale']} stale, "
             f"{counts['current']} current in {CAD_ROOT}, {counts['recent']} modified within {min_age_hours:g} h."]
    for env in environments:
        stamp = datetime.fromtimestamp(env.modified).strftime("%Y-%m-%d %H:%M")
        lines.append(f"{env.status.upper():8} {Path(env.path).name:44} {env.script:24} {stamp}  "
                     f"apparent {_size(env.apparent_bytes):>9}  freed {_size(env.freed_bytes):>9}")
    by_script: dict[str, list[Environment]] = {}
    for env in environments:
        if env.status == "stale":
            by_script.setdefault(env.script, []).append(env)
    if by_script:
        lines.append("Stale by script:")
        for script, group in sorted(by_script.items(), key=lambda item: -sum(e.freed_bytes for e in item[1])):
            lines.append(f"  {script:24} {len(group):4}  apparent {_size(sum(e.apparent_bytes for e in group)):>9}  "
                         f"freed {_size(sum(e.freed_bytes for e in group)):>9}")
    stale = [env for env in environments if env.status == "stale"]
    lines.append(f"Stale total: {len(stale)} environments, apparent {_size(sum(e.apparent_bytes for e in stale))}, "
                 f"freed {_size(sum(e.freed_bytes for e in stale))}.")
    if deleted is None:
        lines.append(f"Dry run: nothing was deleted. Rerun with --delete to remove the {len(stale)} stale environments.")
    else:
        lines.append(f"Deleted {len(deleted)} environments.")
        lines.extend(f"Could not delete {error}" for error in errors)
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--min-age-hours", type=float, default=24.0,
                        help="keep environments modified more recently than this (default 24)")
    parser.add_argument("--delete", action="store_true", help="delete the stale environments (default: list only)")
    parser.add_argument("--json", action="store_true", help="print the listing as JSON")
    args = parser.parse_args(argv)
    uv = shutil.which("uv")
    if uv is None:
        print("clean_envs: uv is not on PATH", file=sys.stderr)
        return 2
    try:
        cache = subprocess.run([uv, "cache", "dir"], capture_output=True, text=True, timeout=60, check=True)
    except (OSError, subprocess.SubprocessError) as error:
        print(f"clean_envs: could not read the uv cache directory: {error}", file=sys.stderr)
        return 2
    root = Path(cache.stdout.strip()) / "environments-v2"
    scripts = shipped_scripts()
    current = current_environments(uv, (path for paths in scripts.values() for path in paths
                                        if path.is_relative_to(CAD_ROOT)), root)
    environments = plan(root, scripts, current, args.min_age_hours * 3600)
    deleted, errors = delete(environments) if args.delete else (None, [])
    if args.json:
        print(json.dumps({"root": str(root), "plugin": str(CAD_ROOT), "min_age_hours": args.min_age_hours,
                          "environments": [asdict(env) for env in environments],
                          "deleted": deleted, "errors": errors}, indent=2))
    else:
        print(render_text(root, environments, args.min_age_hours, deleted, errors))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
