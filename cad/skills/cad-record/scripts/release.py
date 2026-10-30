#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["jsonschema>=4.23", "pyyaml>=6.0"]
# ///
"""Seal a release package of the frozen version: byte copies and a v2 manifest under hw/releases/<REV>/.

    uv run --script release.py HW --rev A --version v3 --decision DR-007

The frozen version (product.yaml flow.frozen) defines what a release holds; release.py copies and
never builds. It refuses the release when any of these fails, and then writes nothing outside
.cad-work/:

- the frozen anchor, the approving decision, and a revision that is not yet used;
- validate.py on the current record, and the current record against the frozen snapshot;
- the manufacturing outputs of every custom-made part;
- the drawings, the analysis cases and the verification evidence, each a sealed bundle of that version;
- bom.csv quantities against the frozen assembly.

It stages the copies in .cad-work/release-<REV>/, writes and checks the manifest, then claims
hw/releases/<REV>/ and renames the stage onto it. Prints JSON: exit 0 released, 1 refused, 2 usage
or infrastructure error.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import posixpath
import re
import shutil
import sys
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml


def _load_module(name: str, path: Path) -> Any:
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, path)
        if spec is None or spec.loader is None:
            raise ImportError(f"cannot load {path}")
        sys.modules[name] = importlib.util.module_from_spec(spec)  # dataclasses look the module up here
        spec.loader.exec_module(sys.modules[name])
    return sys.modules[name]


validate = _load_module("cad_record_validate", Path(__file__).resolve().parent / "validate.py")
layout = validate.layout

MANIFEST = layout.MANIFEST
SCHEMA_VERSION = 2
WORKFLOW_KEYS = {"product.yaml": ("flow",)}  # workflow state; advancing it is not a design change
EVIDENCE_PATH = re.compile(r"hw/[^\s,;()\"'<>]+")  # a project-relative path inside a verification evidence cell


@dataclass(frozen=True)
class Copy:
    package: str  # path inside hw/releases/<REV>/
    original: str  # project-relative hw/ path it copies
    sha256: str  # what the original holds: its seal's hash, or its bytes when checked


@dataclass
class Release:
    """The package release.py assembles, and every reason it refuses it."""

    hw: Path
    rev: str
    version: str
    decision: str
    target_rel: str
    findings: list[dict[str, Any]] = field(default_factory=list)
    copies: dict[str, Copy] = field(default_factory=dict)
    manufacturing: dict[str, dict[str, Any]] = field(default_factory=dict)
    bundles: list[dict[str, str]] = field(default_factory=list)
    checks: dict[str, str] = field(default_factory=dict)
    considered: set[str] = field(default_factory=set)  # bundle paths already selected or refused

    def refuse(self, path: str, code: str, message: str) -> None:
        self.findings.append(validate.finding(path, message, code=f"release.{code}"))

    def copy(self, package: str, original: str, sha256: str) -> None:
        self.copies[package] = Copy(package, original, sha256)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _yaml(path: Path) -> Any:
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        return None


def _json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _record_names(root: Path) -> set[str]:
    """The record files a version snapshots that exist below `root` (hw/ or a version's record/),
    named as the version.record layout entry names them."""
    names = set()
    for spec in layout.load().entry("version.record").files:
        pattern = re.sub(r"\{[A-Z_]+\}", "*", spec.name)
        names.update(path.relative_to(root).as_posix() for path in root.glob(pattern) if path.is_file())
    return names


def _domain(name: str, data: Any) -> Any:
    if isinstance(data, dict):
        return {key: value for key, value in data.items() if key not in WORKFLOW_KEYS.get(name, ())}
    return data


def check_record(release: Release, record: Path, manifest: dict[str, Any]) -> None:
    """The current record against the frozen snapshot: the same record files with the same content,
    workflow state aside, and the same part models."""
    hw, version = release.hw, release.version
    snapshot, current = _record_names(record), _record_names(hw)
    for name in sorted(current - snapshot):
        release.refuse(f"hw/{name}", "changed", f"hw/{name} is new since {version} was frozen")
    for name in sorted(snapshot - current):
        release.refuse(f"hw/{name}", "changed", f"hw/{name} was removed after {version} was frozen")
    for name in sorted(snapshot & current):
        if _domain(name, _yaml(hw / name)) != _domain(name, _yaml(record / name)) or _yaml(hw / name) is None:
            release.refuse(f"hw/{name}", "changed", f"hw/{name} differs from {version}/record/{name}, the frozen snapshot")
    built = manifest.get("parts") if isinstance(manifest.get("parts"), dict) else {}
    models = {path.parent.name for path in (hw / "parts").glob("*/model.py") if path.is_file()}
    for pn in sorted(models | set(built)):
        model = hw / "parts" / pn / "model.py"
        source = (built.get(pn) or {}).get("source_sha256")
        if not model.is_file() or source is None or sha256(model) != source:
            release.refuse(f"hw/parts/{pn}/model.py", "changed", f"hw/parts/{pn}/model.py is not the model {version} built")
    release.checks["record"] = "pass"


def snapshot_parts(record: Path) -> dict[str, dict[str, Any]]:
    parts = {}
    for path in sorted((record / "parts").glob("*/part.yaml")):
        data = _yaml(path)
        if isinstance(data, dict):
            parts[path.parent.name] = data
    return parts


def check_manufacturing(release: Release, folder: Path, manifest: dict[str, Any], parts: dict[str, dict[str, Any]],
                        quantities: dict[str, int]) -> None:
    """Every custom-made part of the frozen snapshot has its process outputs, sealed in the version
    and passing every manufacturing check. A catalogue buy has none."""
    version = release.version
    made = manifest.get("manufacturing") if isinstance(manifest.get("manufacturing"), dict) else {}
    sealed = manifest.get("files") if isinstance(manifest.get("files"), dict) else {}
    for pn, part in sorted(parts.items()):
        if not layout.custom_made(part):
            continue
        directory = layout.manufacturing_dir(release.hw, version, pn)
        rel = layout.relative(release.hw, directory)
        inside = directory.relative_to(folder).as_posix()
        try:
            policy = layout.manufacture_policy(part)
        except layout.LayoutError as error:
            release.refuse(rel, "failed", f"{pn}: {error}")
            continue
        entry = made.get(pn)
        if not isinstance(entry, dict):
            release.refuse(rel, "missing", f"{version} has no manufacturing output for custom-made {pn}; "
                                           "build a new version with cad-model run")
            continue
        missing = [name for name in policy.outputs if f"{inside}/{name}" not in sealed]
        for name in missing:
            release.refuse(f"{rel}/{name}", "missing", f"{rel}/{name} is missing; a {part.get('process')} part needs "
                                                       f"{', '.join(policy.outputs)}")
        sidecar = _json(directory / "manufacturing.json")
        rows = [entry] + ([sidecar] if isinstance(sidecar, dict) else [])
        failed = sorted({name for row in rows for name, check in (row.get("checks") or {}).items()
                         if isinstance(check, dict) and check.get("status") != "pass"}
                        | {name for row in rows for name in row.get("blocking_failures") or []})
        if failed or any(row.get("status") != "pass" or row.get("complete") is not True for row in rows):
            release.refuse(f"{rel}/manufacturing.json", "failed",
                           f"{pn} manufacturing is not a complete pass" + (f": {', '.join(failed)} failed" if failed else ""))
        elif isinstance(sidecar, dict) and list(sidecar.get("outputs") or []) != list(policy.outputs):
            release.refuse(f"{rel}/manufacturing.json", "stale", f"{pn} manufacturing.json lists outputs "
                                                                 f"{sidecar.get('outputs')}, not {list(policy.outputs)}")
        quantity = quantities.get(pn, 0)
        if quantity < 1:
            release.refuse(f"hw/versions/{version}/record/assembly.yaml", "missing",
                           f"custom-made {pn} has no occurrence in the frozen assembly")
        if missing:
            continue
        files = []
        for name in policy.outputs:
            files.append(f"manufacturing/{pn}/{name}")
            release.copy(files[-1], f"{rel}/{name}", sealed[f"{inside}/{name}"])
        release.manufacturing[pn] = {"process": part["process"], "quantity": quantity, "files": files}
        release.checks[f"manufacturing/{pn}"] = "pass"


def select_bundle(release: Release, kind: str, subject: str, version_sha: str, why: str) -> None:
    """A required bundle of the frozen version: sealed, unchanged, bound to that version and passing."""
    hw = release.hw
    directory = layout.bundle_dir(hw, kind, release.version, subject)
    rel = layout.relative(hw, directory)
    if rel in release.considered:
        return
    release.considered.add(rel)
    if not (directory / MANIFEST).is_file():
        release.refuse(rel, "missing", f"{rel} is missing: {why}")
        return
    problems = layout.verify(directory)
    if problems:
        release.refuse(rel, "tampered", f"{rel} fails its manifest: {'; '.join(problems)}")
        return
    manifest = _json(directory / MANIFEST)
    if manifest.get("layout") != f"bundle.{kind}" or manifest.get("path") != rel:
        release.refuse(rel, "tampered", f"{rel}/manifest.json names {manifest.get('layout')} at {manifest.get('path')}")
        return
    if manifest.get("version_manifest_sha256") != version_sha:
        release.refuse(rel, "stale", f"{rel} is not bound to the frozen {release.version} manifest; produce it again")
        return
    if manifest.get("status") != "pass":
        release.refuse(rel, "failed", f"{rel} records status {manifest.get('status')!r}, not pass")
        return
    manifest_sha = sha256(directory / MANIFEST)
    release.bundles.append({"layout": f"bundle.{kind}", "path": rel, "manifest_sha256": manifest_sha})
    release.checks[f"{kind}/{subject}"] = "pass"
    package = f"{kind}/{subject}"
    found = layout.classify(f"{release.target_rel}/{package}/{MANIFEST}")
    if found is None or found.entry.id != "release.package":
        return  # a review bundle (renders, captures): selected by its manifest sha256, not copied
    for name, sha in sorted(manifest["files"].items()):
        release.copy(f"{package}/{name}", f"{rel}/{name}", sha)
    release.copy(f"{package}/{MANIFEST}", f"{rel}/{MANIFEST}", manifest_sha)


def check_evidence(release: Release, rows: list[dict[str, str]], version_sha: str) -> None:
    """Every hw/ path a verification row cites exists; a cited bundle or version is the frozen version's."""
    for index, row in enumerate(rows, start=2):
        where = f"hw/verification.csv:{index}"
        for token in EVIDENCE_PATH.findall(row.get("evidence") or ""):
            rel = token.rstrip(".").rstrip("/")
            sealing = validate.sealed_owner(rel)
            if sealing is not None and "V" in sealing[1]:
                entry, params = sealing
                if params["V"] != release.version:
                    release.refuse(where, "stale", f"{row.get('requirement_id')} evidence {rel} belongs to "
                                                   f"{params['V']}, not the frozen {release.version}")
                    continue
                if entry.manifest == "bundle":
                    select_bundle(release, entry.id.split(".", 1)[1], params["S"], version_sha,
                                  f"{row.get('requirement_id')} cites it as evidence")
            try:
                present = layout.locate(release.hw, rel).exists()
            except layout.LayoutError:
                present = False
            if not present:
                release.refuse(where, "missing", f"{row.get('requirement_id')} evidence {rel} does not exist")
        release.checks[f"verification/{row.get('requirement_id')}"] = row.get("result") or ""


def check_bom(release: Release, rows: list[dict[str, str]], quantities: dict[str, int],
              parts: dict[str, dict[str, Any]]) -> None:
    """bom.csv rolls up to the frozen assembly: each part's total is its occurrence count."""
    levels: list[int | None] = []
    for row in rows:
        try:
            levels.append(int(row["level"]))
        except (TypeError, ValueError, KeyError):
            levels.append(None)
    totals = validate.bom_totals(rows, levels)
    for pn in sorted(set(quantities) | (set(totals) & set(parts))):
        if totals.get(pn, 0) != quantities.get(pn, 0):
            release.refuse("hw/bom.csv", "stale", f"bom.csv gives {pn} a quantity of {totals.get(pn, 0)}; the frozen "
                                                  f"{release.version} assembly places it {quantities.get(pn, 0)} times")
    release.checks["bom"] = "pass"


def assemble(hw: Path, rev: str, version: str, decision: str) -> tuple[Release, dict[str, Any] | None]:
    """Every check and the copy list, without writing anything. LayoutError for a malformed argument."""
    target_rel = layout.load().path("release.package", {"REV": rev})
    layout.version_dir(hw, version)
    decision_path = layout.resolve(hw, "record.decision", DR=decision)
    release = Release(hw, rev, version, decision, target_rel)
    if os.path.lexists(layout.locate(hw, target_rel)):
        release.refuse(target_rel, "exists", f"{target_rel} exists; a used revision is never overwritten")
    if not decision_path.is_file():
        release.refuse(layout.relative(hw, decision_path), "decision",
                       f"{decision} does not exist at {layout.relative(hw, decision_path)}; record the release approval")
    product = _yaml(hw / "product.yaml")
    flow = product.get("flow") if isinstance(product, dict) and isinstance(product.get("flow"), dict) else {}
    frozen = flow.get("frozen")
    if not isinstance(frozen, dict):
        release.refuse("hw/product.yaml", "frozen", "product.yaml has no flow.frozen; freeze a version first")
    elif frozen.get("version") != version:
        release.refuse("hw/product.yaml", "frozen", f"flow.frozen names {frozen.get('version')}, not {version}")
    release.findings.extend(validate.blocking(validate.validate_project(hw)))
    try:
        _, folder, record = layout.built_version(hw, version)
    except layout.LayoutError as error:
        release.refuse(f"hw/versions/{version}", "version", str(error))
        return release, None
    manifest = _json(folder / MANIFEST)
    version_sha = sha256(folder / MANIFEST)  # validate.py's check_flow holds flow.frozen to it
    check_record(release, record, manifest)

    parts = snapshot_parts(record)
    assembly = _yaml(record / "assembly.yaml")
    snapshot_findings: list[dict[str, Any]] = []
    records = {pn: (part, f"hw/versions/{version}/record/parts/{pn}/part.yaml") for pn, part in parts.items()}
    inventory = validate.assembly_inventory(assembly, f"hw/versions/{version}/record/assembly.yaml", records,
                                            snapshot_findings)
    if inventory is not None:
        # a version's attach entries are cad-model's `--attach REF=PARENT_REF` options; a PN endpoint
        # with no occurrence is its identity singleton, an `@id` endpoint an occurrence already listed
        attached = [ref for spec in manifest.get("attach") or [] for ref in spec.split("=", 1) if not ref.startswith("@")]
        inventory = inventory.extended(attached)
    quantities = inventory.quantities() if inventory is not None else {}
    release.findings.extend(snapshot_findings)
    check_manufacturing(release, folder, manifest, parts, quantities)

    for pn, part in sorted(parts.items()):
        if part.get("drawing") is not None:
            select_bundle(release, "drawings", pn, version_sha, f"{pn} declares drawing intent")
    if isinstance(assembly, dict) and assembly.get("drawing") is not None:
        select_bundle(release, "drawings", "assembly", version_sha, "assembly.yaml declares an assembly drawing")
    for case in sorted((hw / "analysis" / "cases").glob("*/case.yaml")):
        case_id = case.parent.name
        try:
            layout.bundle_dir(hw, "analysis", version, case_id)
        except layout.LayoutError:
            continue  # validate.py reports a case folder outside the layout
        select_bundle(release, "analysis", case_id, version_sha, f"analysis case {case_id} has no result for {version}")

    verification = validate.read_csv(hw / "verification.csv", validate.CSV_COLUMNS["verification.csv"], release.findings)
    validate.check_release_readiness(hw, verification, records, "hw/verification.csv", release.findings)
    check_evidence(release, verification, version_sha)
    bom = validate.read_csv(hw / "bom.csv", validate.CSV_COLUMNS["bom.csv"], release.findings)
    check_bom(release, bom, quantities, parts)

    sealed = manifest.get("files") or {}
    if "assembly.step" in sealed:
        release.copy("definition/assembly.step", f"hw/versions/{version}/assembly.step", sealed["assembly.step"])
    else:
        release.refuse(f"hw/versions/{version}/assembly.step", "missing", f"{version} has no assembly.step")
    for name, sha in sorted(sealed.items()):
        if name.startswith("record/"):
            release.copy(f"definition/{name}", f"hw/versions/{version}/{name}", sha)
    for pn, part in sorted(parts.items()):
        specification = (part.get("procurement") or {}).get("specification") or {}
        if isinstance(specification.get("artifact"), str):
            artifact = posixpath.normpath(specification["artifact"])
            release.copy(f"definition/{artifact}", f"hw/{artifact}", specification.get("sha256", ""))
    for name, path in (("bom.csv", hw / "bom.csv"), ("verification.csv", hw / "verification.csv")):
        if path.is_file():
            release.copy(name, f"hw/{name}", sha256(path))
    docs = hw / "docs"
    for path in sorted(docs.rglob("*")) if docs.is_dir() else []:
        if path.is_file() and not path.is_symlink():
            release.copy(f"docs/{path.relative_to(docs).as_posix()}", layout.relative(hw, path), sha256(path))
    # validate.py and the release rules can report one fact twice; keep the first
    release.findings = list({(item["path"], item["message"]): item for item in release.findings}.values())
    return release, {"product_id": product.get("id") if isinstance(product, dict) else None, "frozen": frozen}


def stage(release: Release, facts: dict[str, Any]) -> Path:
    """Byte copies plus manifest.json in a new folder under .cad-work/release-<REV>/; findings when a
    copy does not hold what its original was checked to hold."""
    hw = release.hw
    root = hw.parent / layout.SCRATCH / f"release-{release.rev}"
    root.mkdir(parents=True, exist_ok=True)
    staged = Path(tempfile.mkdtemp(prefix="stage-", dir=root))
    files = {}
    for package, item in sorted(release.copies.items()):
        found = layout.classify(f"{release.target_rel}/{package}")
        if found is None or found.entry.id != "release.package":
            release.refuse(item.original, "layout", f"{package} is not a path release.package holds")
            continue
        target = staged / package
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.copyfile(layout.locate(hw, item.original), target)
        except OSError as error:
            release.refuse(item.original, "missing", f"cannot copy {item.original}: {error.strerror}")
            continue
        copied = sha256(target)
        if copied != item.sha256:
            release.refuse(item.original, "tampered", f"{item.original} does not hold the bytes its seal or record names")
        files[package] = {"sha256": copied, "original": item.original}
    manifest = {
        "schema_version": SCHEMA_VERSION, "product_id": facts["product_id"], "rev": release.rev,
        "released_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "frozen": facts["frozen"], "approval": release.decision, "files": files,
        "manufacturing": release.manufacturing, "bundles": release.bundles, "checks": release.checks,
    }
    path = staged / MANIFEST
    validate.validate_document(manifest, "release-manifest.schema.json", layout.relative(hw, path), release.findings)
    path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    for problem in layout.verify(staged):
        release.refuse(layout.relative(hw, staged), "tampered", problem)
    return staged


def run(hw: Path, rev: str, version: str, decision: str) -> tuple[int, dict[str, Any]]:
    hw = hw.resolve()
    release, facts = assemble(hw, rev, version, decision)
    report: dict[str, Any] = {"rev": rev, "version": version, "package": release.target_rel}
    if release.findings or facts is None:
        return 1, {"status": "refused", **report, "findings": release.findings}
    staged = stage(release, facts)
    report["stage"] = layout.relative(hw, staged)
    if release.findings:
        return 1, {"status": "refused", **report, "findings": release.findings}
    target = layout.locate(hw, release.target_rel)
    try:
        layout.claim(staged, target, release.target_rel)
    except layout.PublishConflict as error:
        release.refuse(release.target_rel, "exists", f"{error}; a used revision is never overwritten")
        return 1, {"status": "refused", **report, "findings": release.findings}
    return 0, {"status": "released", **report, "stage": None, "manifest_sha256": sha256(target / MANIFEST),
               "files": len(release.copies), "manufacturing": release.manufacturing, "bundles": release.bundles}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("hw", type=Path, help="the record's hw/ directory")
    parser.add_argument("--rev", required=True, help="the release revision letter, A to Y without I, O, Q, S, X")
    parser.add_argument("--version", required=True, help="the frozen version, as product.yaml flow.frozen names it")
    parser.add_argument("--decision", required=True, help="DR-### approving this release, in hw/decisions/")
    args = parser.parse_args(argv)
    if not args.hw.is_dir():
        print(json.dumps({"status": "error", "message": f"{args.hw} is not a directory"}))
        return 2
    try:
        code, report = run(args.hw, args.rev, args.version, args.decision)
    except layout.LayoutError as error:
        print(json.dumps({"status": "error", "message": str(error)}))
        return 2
    print(json.dumps(report, indent=2))
    return code


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 - one JSON report for any infrastructure failure
        print(json.dumps({"status": "error", "message": f"infrastructure error: {error}"}))
        raise SystemExit(2)
