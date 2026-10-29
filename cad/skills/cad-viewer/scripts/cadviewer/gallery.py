"""The preview gallery: what one hardware record holds to look at, per cad-model version.

The host serves it read-only beside the panel (`/gallery`, `/api/gallery`, `/gallery/file`). One
project is open at a time: the `hw/` folder named by `viewer.py gallery`, `show`, or `compare`.
A page can only ask for files by their path relative to that folder, and `resolve` refuses any
path that is absolute, climbs out with `..`, enters a dot folder, leaves `hw/` through a symlink,
or is not a PNG, JPEG, or PDF.

Sections, each read from the files the producing skill writes:

- renders: `hw/renders/<vN>/manifest.json` (cad-render): every view with its quality status,
  failures, warnings, retry strategy, and the materials of the PNs it shows.
- captures: PNGs under `hw/captures/` (cad-viewer `capture --out hw/captures/<vN>/<view>.png`).
- drawings: cad-drawings outputs anywhere under `hw/` (a `package.json` drawing package or a
  `drawing_<run>.complete.json` single drawing) and every other PNG under `hw/drawings/`, each
  with its PDF.
- concept: `hw/concept/screenshots/*.png` (cad-concept), with the scene and variant of its pose JSON.

A capture or drawing belongs to version vN when vN is a folder on its path or, for a drawing
package, its provenance names vN. One that names no version is listed for every version and
says so.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import quote

from . import ViewerError, record

MEDIA = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".pdf": "application/pdf"}
IMAGES = (".png", ".jpg", ".jpeg")
FILE_ROUTE = "/gallery/file"


class Forbidden(ViewerError):
    """A file request outside the open project's hw/, or of a type the gallery does not serve; HTTP 403."""


class NotFound(ViewerError):
    """No such file or version in the open project; HTTP 404."""


def _label_pattern() -> Any:
    return record._layout().load().tokens["V"]["pattern"]  # noqa: SLF001 - canonical grammar owner


class Gallery:
    """The open project and the read-only views of it the host serves."""

    def __init__(self) -> None:
        self.hw: Path | None = None

    def open(self, hw: str | Path) -> Path:
        """Make `hw` the open project: an absolute hardware record folder (product.yaml or versions/)."""
        path = Path(hw)
        if not path.is_absolute():
            raise ViewerError(f"hw must be an absolute path, got {str(hw)!r}")
        path = path.resolve()
        if not ((path / "product.yaml").is_file() or (path / "versions").is_dir()):
            raise ViewerError(f"{path} is not a hardware record folder (no product.yaml or versions/)")
        self.hw = path
        return path

    def project(self) -> Path:
        if self.hw is None:
            raise ViewerError("no gallery project open; run `viewer.py gallery HW` or `viewer.py show HW`")
        return self.hw

    def file(self, rel: str) -> Path:
        return resolve(self.project(), rel)

    def index(self, version: str = "latest", showing: str | None = None) -> dict[str, Any]:
        return index(self.project(), version, showing)


def media_type(path: Path) -> str:
    return MEDIA[path.suffix.lower()]


def resolve(hw: Path, rel: str) -> Path:
    """The file `rel` names inside `hw` (an already resolved folder); Forbidden or NotFound otherwise."""
    if not isinstance(rel, str) or not rel or "\x00" in rel or "\\" in rel:
        raise Forbidden(f"path must be a file path relative to {hw}, got {rel!r}")
    candidate = PurePosixPath(rel)
    if candidate.is_absolute() or any(part == ".." or part.startswith(".") for part in candidate.parts):
        raise Forbidden(f"{rel!r} leaves {hw} or enters a hidden folder")
    if candidate.suffix.lower() not in MEDIA:
        raise Forbidden(f"{rel!r}: the gallery serves only {', '.join(sorted(MEDIA))} files")
    try:
        real = (hw / candidate).resolve(strict=True)
    except (FileNotFoundError, NotADirectoryError) as error:
        raise NotFound(f"{hw / candidate} does not exist") from error
    if not real.is_relative_to(hw):
        raise Forbidden(f"{rel!r} resolves to {real}, outside {hw}")
    if not real.is_file():
        raise NotFound(f"{real} is not a file")
    return real


def versions(hw: Path) -> tuple[list[str], str | None]:
    """Built version labels from cad-record layout and its validated latest pointer."""
    api = record._layout()
    labels = api.versions(hw)
    try:
        latest = api.latest(hw)
    except api.LayoutError:
        latest = None
    return labels, latest or (labels[-1] if labels else None)


def index(hw: Path, version: str = "latest", showing: str | None = None) -> dict[str, Any]:
    """The gallery page model for one version: four sections of tiles, each with absolute paths."""
    known, latest = versions(hw)
    chosen = latest if version == "latest" else version
    if chosen is None:
        raise NotFound(f"{hw} has no built or rendered version; run cad-model run first")
    if chosen not in known:
        raise NotFound(f"version {version!r} not found in {hw}; versions: {', '.join(known) or 'none'}")
    product = _product_title(hw)
    return {"hw": str(hw), "product": product, "version": chosen, "latest": latest, "versions": known,
            "viewer": {"url": "/", "showing": showing},
            "sections": [_renders(hw, chosen), _captures(hw, chosen), _drawings(hw, chosen), _concept(hw)]}


def summary(model: dict[str, Any]) -> dict[str, Any]:
    """The CLI's view of an index: counts and every absolute file path, per section."""
    return {"hw": model["hw"], "version": model["version"], "versions": model["versions"],
            "files": {s["id"]: [p for t in s["tiles"] for p in (t["path"], (t.get("pdf") or {}).get("path")) if p]
                      for s in model["sections"]}}


# --------------------------------------------------------------------------- sections


def _section(sid: str, title: str, source: Path, tiles: list[dict[str, Any]], empty: str,
             notes: list[str] | None = None) -> dict[str, Any]:
    return {"id": sid, "title": title, "source": str(source), "tiles": tiles, "empty": empty, "notes": notes or []}


def _renders(hw: Path, version: str) -> dict[str, Any]:
    api = record._layout()
    root = api.bundle_dir(hw, "renders", version, "assembly").parent
    tiles: list[dict[str, Any]] = []
    notes: list[str] = []
    folders = record.version_bundles(hw, "renders", version)
    for folder in folders:
        data_path, manifest_path = folder / "render.json", folder / "manifest.json"
        if not manifest_path.is_file():
            continue
        problems = api.verify(folder)
        if problems:
            notes.append(f"{folder} fails its bundle inventory: {'; '.join(problems)}")
            continue
        metadata = _json(data_path) if data_path.is_file() else {}
        if not isinstance(metadata, dict):
            metadata = {}
        views = metadata.get("views") if isinstance(metadata.get("views"), dict) else {}
        materials = metadata.get("materials") if isinstance(metadata.get("materials"), dict) else {}
        listed: set[str] = set()
        for name, entry in views.items():
            entry = entry if isinstance(entry, dict) else {}
            png = folder / str(entry.get("png") or f"{name}.png")
            listed.add(png.name)
            tile = _tile(hw, png, name)
            if tile is None:
                continue
            quality = entry.get("quality") if isinstance(entry.get("quality"), dict) else {}
            subject = entry.get("subject") if isinstance(entry.get("subject"), list) else None
            if subject is not None and set(materials) <= set(subject):
                subject = None
            shown = [pn for pn in (subject or sorted(materials)) if pn in materials]
            tile.update({"status": str(quality.get("status") or "unknown"),
                         "failures": [str(f) for f in quality.get("failures") or []],
                         "warnings": [str(w) for w in quality.get("warnings") or []],
                         "retry": _retry(entry.get("retry")), "subject": subject,
                         "materials": [{"pn": pn, "label": str(materials[pn].get("label") or ""),
                                        "rule": str(materials[pn].get("rule") or "")} for pn in shown
                                       if isinstance(materials[pn], dict)], "bundle": str(folder)})
            tiles.append(tile)
        for png in sorted(folder.glob("*.png")):
            if png.name not in listed and (tile := _tile(hw, png, png.stem)) is not None:
                tiles.append({**tile, "status": "unknown", "note": "not listed in render.json",
                              "bundle": str(folder)})
        if metadata.get("status"):
            notes.append(f"{folder.name}: {metadata['status']}")
    empty = f"No renders for {version}: run cad-render `render.py {hw} --version {version}`."
    return _section("renders", "Renders", root, tiles, empty, notes)


def _retry(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    attempts = value.get("attempts") if isinstance(value.get("attempts"), list) else []
    return {"strategy": str(value.get("strategy") or "unknown"), "attempts": len(attempts),
            "note": str(value["note"]) if value.get("note") else None}


def _captures(hw: Path, version: str) -> dict[str, Any]:
    api = record._layout()
    root = api.bundle_dir(hw, "captures", version, "assembly").parent
    tiles: list[dict[str, Any]] = []
    notes: list[str] = []
    for folder in record.version_bundles(hw, "captures", version):
        metadata_path, manifest_path = folder / "capture.json", folder / "manifest.json"
        if not manifest_path.is_file():
            continue
        problems = api.verify(folder)
        if problems:
            notes.append(f"{folder} fails its bundle inventory: {'; '.join(problems)}")
            continue
        data = _json(metadata_path) if metadata_path.is_file() else None
        if not isinstance(data, dict):
            notes.append(f"{folder} has no readable capture.json")
            continue
        view = data.get("view")
        if not isinstance(view, str):
            notes.append(f"{folder} capture.json has no view")
            continue
        png = folder / f"{view.replace(':', '-')}.png"
        if tile := _tile(hw, png, view):
            tiles.append({**tile, "version_recorded": data.get("version") == version,
                          "state": data.get("viewer_state"), "bundle": str(folder)})
    empty = f"No viewer captures for {version}: run `viewer.py capture --view iso` to publish a bundle."
    return _section("captures", "Viewer captures", root, tiles, empty, notes)


def _drawings(hw: Path, version: str) -> dict[str, Any]:
    api = record._layout()
    root = api.bundle_dir(hw, "drawings", version, "assembly").parent
    tiles: list[dict[str, Any]] = []
    notes: list[str] = []
    for bundle in record.version_bundles(hw, "drawings", version):
        manifest = bundle / "manifest.json"
        if not manifest.is_file():
            continue
        problems = api.verify(bundle)
        if problems:
            notes.append(f"{bundle} fails its bundle inventory: {'; '.join(problems)}")
            continue
        package_path = bundle / "package.json"
        package = _json(package_path) if package_path.is_file() else None
        if not isinstance(package, dict):
            continue
        png = bundle / "sheet-1.png"
        pdf = bundle / "sheet-1.pdf"
        tile = _tile(hw, png, f"{bundle.name} sheet 1")
        if tile is None:
            notes.append(f"{bundle} preview PNG resolves outside hw")
            continue
        tile.update({"status": package.get("status", "unknown"), "kind": "package",
                     "source": str(package_path), "version_recorded": True,
                     "pdf": _link(hw, pdf) if pdf.is_file() else None, "bundle": str(bundle),
                     "scale": package.get("scale"),
                     "projection": package.get("projection") or package.get("projection_method")})
        tiles.append(tile)
    empty = f"No drawing bundles for {version}: run cad-drawings drawing.py or assembly_drawing.py."
    return _section("drawings", "Drawings", root, tiles, empty, notes)


def _concept(hw: Path) -> dict[str, Any]:
    folder = hw / "concept" / "screenshots"
    tiles = []
    for png in sorted(_files(folder, IMAGES), key=lambda p: p.stat().st_mtime, reverse=True):
        meta = _json(png.with_suffix(".json"))
        meta = meta if isinstance(meta, dict) else {}
        scene = str(meta.get("scene") or "").removesuffix(".scene.json") or png.stem
        title = " ".join(str(v) for v in (scene, meta.get("variant")) if v)
        if (tile := _tile(hw, png, title)) is not None:
            tiles.append(tile)
    empty = f"No concept screenshots in {folder}: save one from the cad-concept viewer."
    return _section("concept", "Concept screenshots", folder, tiles, empty)


# --------------------------------------------------------------------------- helpers


def _product_title(hw: Path) -> str:
    try:
        data = record.read_yaml(hw / "product.yaml")
    except ViewerError:
        return hw.parent.name
    data = data if isinstance(data, dict) else {}
    return str(data.get("title") or data.get("id") or hw.parent.name)


def _files(folder: Path, endings: tuple[str, ...], names: bool = False) -> list[Path]:
    """Files under `folder` whose name (names=True) or lowercased ending matches, outside dot folders."""
    if not folder.is_dir():
        return []
    found = []
    for path in folder.rglob("*"):
        rel = path.relative_to(folder).parts
        if any(part.startswith(".") for part in rel) or not path.is_file():
            continue
        if (path.name in endings) if names else path.name.lower().endswith(endings):
            found.append(path)
    return sorted(found)


def _path_version(hw: Path, path: Path, known: list[str]) -> str | None:
    try:
        parts = path.resolve().relative_to(hw).parts
    except ValueError:
        return None
    return next((part for part in parts if part in known), None)


def _json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _link(hw: Path, path: Path) -> dict[str, str] | None:
    """The served URL and absolute path of a file inside `hw`, or None when it may not be served."""
    try:
        real = path.resolve(strict=True)
        rel = real.relative_to(hw).as_posix()
        resolve(hw, rel)
    except (OSError, ValueError, ViewerError):
        return None
    return {"path": str(real), "url": f"{FILE_ROUTE}?path={quote(rel)}"}


def _tile(hw: Path, image: Path, title: str) -> dict[str, Any] | None:
    link = _link(hw, image)
    if link is None:
        return None
    modified = datetime.fromtimestamp(Path(link["path"]).stat().st_mtime, timezone.utc)
    return {"title": title, **link, "modified": modified.strftime("%Y-%m-%dT%H:%M:%SZ")}
