"""Remove the versions a sealed release supersedes, with their version-bound bundles, recoverably.

release.py calls this only after hw/releases/<REV>/ is sealed. `plan` lists what stays and why, what goes,
and a digest of that plan; `after_release` applies the plan only when the caller names that digest and a
fresh plan still has it. A version stays when it is not older than the released one, released, the
latest, frozen in product.yaml, the baseline of the open change, named by a decision record (a gate
approval or a design decision about that build), or referenced by a surviving manifest: by a path below
it, its label, or the sha256 of one of its manifests.

Applying writes .cad-work/prune-<REV>-<digest>/journal.json, renames each folder into that directory (one
atomic rename on the same filesystem, so hw/ never holds a half-deleted folder), deletes the moved
folders, runs `cad_model.py store gc` and removes the journal last. A rerun with the same digest finishes
an interrupted prune: while folders are still moving, it first moves every one back, plans afresh and
continues only when that plan has the same digest; otherwise it refuses with everything restored.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterator

import yaml

if "cad_record_layout" not in sys.modules:
    _SPEC = importlib.util.spec_from_file_location("cad_record_layout", Path(__file__).resolve().parent / "layout.py")
    if _SPEC is None or _SPEC.loader is None:
        raise ImportError("cannot load layout.py beside prune.py")
    sys.modules["cad_record_layout"] = importlib.util.module_from_spec(_SPEC)  # dataclasses look the module up here
    _SPEC.loader.exec_module(sys.modules["cad_record_layout"])
layout = sys.modules["cad_record_layout"]

JOURNAL = "journal.json"
LABEL = re.compile(r"(?<![A-Za-z0-9])v[1-9][0-9]*(?![A-Za-z0-9])")  # a version label inside prose
CAD_MODEL = Path(__file__).resolve().parents[2] / "cad-model" / "scripts" / "cad_model.py"


def _number(label: str) -> int:
    return int(label[1:])  # the V grammar is v<number>


def _json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write_json(path: Path, value: Any) -> None:
    """Replace `path` whole: a reader sees the previous document or this one, never a partial write."""
    staged = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    staged.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(staged, path)


def _sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def roots(label: str) -> list[str]:
    """The folders that belong to version `label`, in removal order: each bundle root `hw/<kind>/<label>`
    (layout bundle.<kind> is hw/<kind>/{V}/{S}), then the version itself last."""
    return [*(f"hw/{kind}/{label}" for kind in layout.bundle_kinds()), layout.load().path("version.core", {"V": label})]


def releases(hw: Path) -> dict[str, str]:
    """The frozen version of each release package by revision. A version 1 manifest names none; the
    reference scan keeps the versions its file list names."""
    found = {}
    for path in sorted((hw / "releases").glob(f"*/{layout.MANIFEST}")):
        manifest = _json(path)
        if not isinstance(manifest, dict):
            raise layout.LayoutError(f"cannot read {layout.relative(hw, path)} before pruning")
        frozen = manifest.get("frozen")
        if isinstance(frozen, dict) and isinstance(frozen.get("version"), str):
            found[path.parent.name] = frozen["version"]
    return found


def milestones(hw: Path) -> dict[str, list[str]]:
    """Why the record marks a version as a milestone: frozen in product.yaml, the baseline of its open
    change, or named by a decision record, which is how a gate approval or a design decision is kept."""
    reasons: dict[str, list[str]] = defaultdict(list)
    try:
        product = yaml.safe_load((hw / "product.yaml").read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as error:
        raise layout.LayoutError(f"cannot read hw/product.yaml before pruning: {error}") from error
    flow = product.get("flow") if isinstance(product, dict) else None
    flow = flow if isinstance(flow, dict) else {}
    for key, field, why in (("frozen", "version", "frozen in product.yaml flow.frozen"),
                            ("change", "baseline_version", "baseline of product.yaml flow.change")):
        value = flow.get(key)
        if isinstance(value, dict) and isinstance(value.get(field), str):
            reasons[value[field]].append(why)
    for path in sorted((hw / "decisions").glob("DR-[0-9][0-9][0-9].md")):
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as error:  # it might name a version: never prune blind
            raise layout.LayoutError(f"cannot read {layout.relative(hw, path)} before pruning: {error}") from error
        for label in sorted(set(LABEL.findall(text)), key=_number):
            reasons[label].append(f"named by {path.stem}")
    return reasons


def _unmovable(hw: Path, rel: str) -> str | None:
    """Why `rel` cannot be renamed into .cad-work/ in one step, or None."""
    path = layout.locate(hw, rel)
    if path.is_symlink():
        return f"{rel} is a symbolic link"
    if os.path.realpath(path) != str(hw / os.path.relpath(path, hw)):
        return f"{rel} lies behind a symbolic link"
    if not path.is_dir():
        return f"{rel} is not a directory"
    scratch = hw.parent / layout.SCRATCH
    if path.stat().st_dev != (scratch if scratch.exists() else hw.parent).stat().st_dev:
        return f"{rel} is on another filesystem than {layout.SCRATCH}/, so it cannot move there in one rename"
    return None


def _documents(hw: Path, skip: set[Path]) -> Iterator[tuple[str, Any]]:
    """Every surviving manifest.json that seals a version, bundle or release package, and versions/latest.json."""
    latest = layout.load().path("version.latest", {})
    for root, dirnames, filenames in os.walk(hw):  # never follows a link
        folder = Path(root)
        dirnames[:] = sorted(name for name in dirnames if folder / name not in skip)
        for name in sorted(filenames):
            path = folder / name
            rel = layout.relative(hw, path)
            if path.is_symlink():
                continue
            if name == layout.MANIFEST:
                match = layout.classify(rel)
                if match is None or match.entry.manifest is None:
                    continue
            elif rel != latest:
                continue
            document = _json(path)
            if document is None:
                raise layout.LayoutError(f"cannot read {rel} before pruning: it might reference a version")
            yield rel, document


def _strings(document: Any) -> Iterator[str]:
    """Every key and string a manifest holds, but the sha256 of each file its own `files` inventory seals."""
    def walk(value: Any) -> Iterator[str]:
        if isinstance(value, str):
            yield value
        elif isinstance(value, dict):
            for key, child in value.items():
                yield key
                yield from walk(child)
        elif isinstance(value, list):
            for child in value:
                yield from walk(child)

    if not isinstance(document, dict):
        yield from walk(document)
        return
    for key, value in document.items():
        if key == "files" and isinstance(value, dict):
            for item in value.values():  # a v2 release manifest lists {sha256, original}
                if isinstance(item, dict):
                    yield from walk({name: child for name, child in item.items() if name != "sha256"})
        else:
            yield key
            yield from walk(value)


def references(hw: Path, targets: dict[str, list[str]]) -> dict[str, list[str]]:
    """Each version of `targets` that a surviving manifest references, with the manifests that do."""
    skip = {layout.locate(hw, rel) for rels in targets.values() for rel in rels}
    hashes: dict[str, str] = {}
    for label, rels in targets.items():
        for rel in rels:
            for root, _, filenames in os.walk(layout.locate(hw, rel)):
                if layout.MANIFEST in filenames:
                    hashes[_sha256(Path(root) / layout.MANIFEST)] = label
    folders = "|".join(re.escape(kind) for kind in ("versions", *layout.bundle_kinds()))
    path = re.compile(rf"(?<![A-Za-z0-9_.-])(?:{folders})/(v[1-9][0-9]*)(?![A-Za-z0-9])")
    found: dict[str, list[str]] = defaultdict(list)
    for rel, document in _documents(hw, skip):
        for value in _strings(document):
            labels = {match.group(1) for match in path.finditer(value)}
            labels |= {value} | ({hashes[value]} if value in hashes else set())
            for label in labels & targets.keys():
                if f"referenced by {rel}" not in found[label]:
                    found[label].append(f"referenced by {rel}")
    return found


def plan(hw: Path, rev: str, version: str) -> dict[str, Any]:
    """What pruning after release `rev` of `version` keeps and why, the versions it prunes, the folders
    it removes in order, and the sha256 `digest` of all of that, which --yes must name."""
    hw = Path(hw).resolve()
    built = layout.versions(hw)
    keep: dict[str, list[str]] = {label: [] for label in built}
    for label in built:
        if _number(label) >= _number(version):
            keep[label].append(f"not older than the released {version}")
    for package, base in releases(hw).items():
        if base in keep:
            keep[base].append(f"released as {package}")
    latest = layout.latest(hw)
    if latest in keep:
        keep[latest].append("latest: versions/latest.json names it")
    for label, why in milestones(hw).items():
        if label in keep:
            keep[label].extend(why)
    targets: dict[str, list[str]] = {}
    for label in built:
        if keep[label]:
            continue
        present = [rel for rel in roots(label) if os.path.lexists(layout.locate(hw, rel))]
        refused = [problem for rel in present if (problem := _unmovable(hw, rel)) is not None]
        if refused:
            keep[label].extend(f"refused: {problem}; resolve it by hand to prune {label}" for problem in refused)
        else:
            targets[label] = present
    while targets:  # a kept version's manifests may reference another target in turn
        referenced = references(hw, targets)
        if not referenced:
            break
        for label, why in referenced.items():
            keep[label].extend(why)
            del targets[label]
    pruned = sorted(targets, key=_number)
    body = {"rev": rev, "version": version,
            "keep": {label: list(dict.fromkeys(why)) for label, why in keep.items() if why},
            "prune": pruned, "remove": [rel for label in pruned for rel in targets[label]]}
    return {**body, "digest": hashlib.sha256(layout.canonical_json(body)).hexdigest()}


def store_gc(hw: Path) -> dict[str, Any]:
    """`cad_model.py store gc`: drop part-store objects that no surviving manifest references."""
    try:
        result = subprocess.run([sys.executable, str(CAD_MODEL), "store", "gc", str(hw)],
                                capture_output=True, text=True, check=False, timeout=300)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise layout.LayoutError(f"store gc did not run: {error}") from error
    if result.returncode != 0:
        raise layout.LayoutError(f"store gc failed ({result.returncode}): {result.stderr.strip() or result.stdout.strip()}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise layout.LayoutError(f"store gc returned invalid JSON: {result.stdout!r}") from error


def _journals(hw: Path) -> list[Path]:
    return sorted((hw.parent / layout.SCRATCH).glob(f"prune-*/{JOURNAL}"))


def _restore(hw: Path, folder: Path, removed: list[str]) -> tuple[list[str], list[str]]:
    """Move every folder a prune moved out of hw/ back. (restored, left in `folder` because hw/ holds
    that path again)."""
    restored, left = [], []
    for rel in reversed(removed):
        moved, home = folder / rel, layout.locate(hw, rel)
        if not os.path.lexists(moved):
            continue
        if os.path.lexists(home):
            left.append(rel)
            continue
        home.parent.mkdir(parents=True, exist_ok=True)
        os.rename(moved, home)
        restored.append(rel)
    return restored, left


def _advance(path: Path, journal: dict[str, Any], phase: str) -> dict[str, Any]:
    """The journal at its next phase, written before that phase starts; `phase` stays its last key."""
    journal = {**{key: value for key, value in journal.items() if key != "phase"}, "phase": phase}
    _write_json(path, journal)
    return journal


def _finish(hw: Path, path: Path, journal: dict[str, Any]) -> dict[str, Any]:
    """Carry the journal at `path` through its phases (moving, deleting, gc); the journal goes last."""
    folder, digest, remove = path.parent, journal["digest"], journal["remove"]
    pending = {"journal": layout.relative(hw, folder), "digest": digest}
    rerun = f"rerun with --prune --yes {digest} to finish"
    if journal["phase"] == "moving":
        for rel in remove:
            source = layout.locate(hw, rel)
            if not os.path.lexists(source):
                continue  # moved before an interruption
            target = folder / rel
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                os.rename(source, target)
            except OSError as error:
                return {**pending, "remove": remove,
                        "message": f"cannot move {rel} into {pending['journal']}: {error}; {rerun}",
                        "status": "incomplete"}
        journal = _advance(path, journal, "deleting")
    if journal["phase"] == "deleting":
        try:
            if (folder / layout.HW).exists():
                shutil.rmtree(folder / layout.HW)
        except OSError as error:
            return {**pending, "remove": remove,
                    "message": f"cannot delete the folders moved into {pending['journal']}: {error}; {rerun}",
                    "status": "incomplete"}
        journal = _advance(path, journal, "gc")
    try:
        collected = store_gc(hw)
    except layout.LayoutError as error:
        return {**pending, "removed": remove,
                "message": f"the folders are removed but {error}; fix that, then {rerun}", "status": "incomplete"}
    shutil.rmtree(folder)
    return {"removed": remove, "store_gc": collected, "status": "pruned"}


def after_release(hw: Path, rev: str, version: str, digest: str | None) -> dict[str, Any]:
    """Without `digest`, the plan (or the interrupted prune still pending). With it, apply the plan whose
    digest it is, or finish the interrupted prune that digest started."""
    hw = Path(hw).resolve()
    journals = _journals(hw)
    if journals:
        pending = []
        for path in journals:
            journal = _json(path)
            if not isinstance(journal, dict) or not {"rev", "version", "digest", "remove", "phase"} <= journal.keys():
                raise layout.LayoutError(f"cannot read the prune journal {layout.relative(hw, path)}; "
                                         "inspect it and its folder by hand")
            pending.append((path, journal))
        mine = [(path, journal) for path, journal in pending if journal["digest"] == digest
                and (journal["rev"], journal["version"]) == (rev, version)]
        if len(pending) > 1 or not mine:
            first = pending[0][1]
            return {"journal": layout.relative(hw, pending[0][0].parent), "digest": first["digest"],
                    "message": f"an interrupted prune after release {first['rev']} of {first['version']} is pending; "
                               f"rerun that release command with --prune --yes {first['digest']} to finish it",
                    "status": "incomplete"}
        path, journal = mine[0]
        if journal["phase"] == "moving":  # nothing deleted yet: put every moved folder back, then plan afresh
            folder = layout.relative(hw, path.parent)
            try:
                restored, left = _restore(hw, path.parent, journal["remove"])
            except OSError as error:
                return {"journal": folder, "digest": digest,
                        "message": f"cannot move the folders in {folder} back into hw/: {error}; rerun with "
                                   f"--prune --yes {digest}", "status": "incomplete"}
            if left:
                return {"journal": folder, "restored": restored, "left": left,
                        "message": f"hw/ holds {', '.join(left)} again, so their moved copies stay in {folder}; "
                                   "resolve them by hand", "status": "refused"}
            current = plan(hw, rev, version)
            if current["digest"] != digest:
                shutil.rmtree(path.parent)
                return {"plan": current, "restored": restored,
                        "message": "the record changed since the interrupted prune; every moved folder is back in "
                                   "hw/; review this plan and rerun with --prune --yes "
                                   f"{current['digest']}", "status": "refused"}
        return _finish(hw, path, journal)
    current = plan(hw, rev, version)
    if digest is None:
        return {"plan": current, "status": "plan"}
    if digest != current["digest"]:
        return {"plan": current, "message": f"the plan changed since digest {digest}; review this plan and rerun "
                                            f"with --prune --yes {current['digest']}", "status": "refused"}
    folder = hw.parent / layout.SCRATCH / f"prune-{rev}-{digest[:16]}"
    folder.mkdir(parents=True, exist_ok=True)
    journal = {"rev": rev, "version": version, "digest": digest, "remove": current["remove"], "plan": current,
               "phase": "moving"}
    _write_json(folder / JOURNAL, journal)
    return _finish(hw, folder / JOURNAL, journal)
