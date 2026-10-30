"""Drawing inputs as one verified context: the design record and one built model version, bound by hashes.

``load_context(hw, version_dir)`` is the first proof stage of every drawing: the record passes
cad-record's validator, and every file the version's manifest lists still has its recorded hash.
The context then names each built part's record, STEP, metrics and ``drawing_features`` locators,
plus the assembly STEP, interfaces and BOM rows, so part and assembly drawings read the same
evidence and their packages record the same provenance.

A version is stale when ``assembly.yaml`` or a part's ``model.py`` changed after the build: the
drawing would show geometry the record no longer produces, so loading fails with
``source_mismatch``. Rebuild under the next label instead.
"""

from __future__ import annotations

import csv
import hashlib
import importlib.util
import json
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

import yaml

VALIDATOR = Path(__file__).resolve().parents[2] / "cad-record" / "scripts" / "validate.py"
LAYOUT = VALIDATOR.with_name("layout.py")


class ContractError(ValueError):
    """Drawing inputs that cannot be trusted: ``code`` is ``invalid_drawing_intent`` or ``source_mismatch``."""

    def __init__(self, code: str, message: str, findings: tuple[Mapping[str, str], ...] = ()) -> None:
        super().__init__(message)
        self.code = code
        self.findings = findings


@dataclass(frozen=True)
class PartContext:
    """One built part: its record, its model source hash and the version's evidence for it."""

    pn: str
    record: Mapping[str, Any]
    record_sha256: str
    model_sha256: str
    step: Path
    step_sha256: str
    metrics: Mapping[str, Any]
    features: Mapping[str, Any] | None  # semantic ID -> FeatureLocator; None when model.py has no hook


@dataclass(frozen=True)
class DrawingContext:
    """The record and one built version, verified together; treat every mapping as read-only."""

    hw: Path
    version_dir: Path
    label: str
    manifest: Mapping[str, Any]
    manifest_sha256: str
    product: Mapping[str, Any]
    product_sha256: str
    interfaces: tuple[Mapping[str, Any], ...]
    interfaces_sha256: str
    assembly: Mapping[str, Any]
    bom: tuple[Mapping[str, str], ...]
    assembly_step: Path
    assembly_step_sha256: str
    features_sha256: str | None
    parts: Mapping[str, PartContext]

    def part(self, pn: str) -> PartContext:
        try:
            return self.parts[pn]
        except KeyError:
            raise ContractError("source_mismatch", f"{pn} is not a built part of {self.label}") from None

    def provenance(self, drawing_number: str) -> dict[str, Any]:
        """The hashes a drawing package of ``drawing_number`` (a part PN or an assembly number) rests on."""
        common = {"subject": drawing_number, "version": self.label, "manifest_sha256": self.manifest_sha256,
                  "product_sha256": self.product_sha256}
        part = self.parts.get(drawing_number)
        if part is None:
            return {**common, "assembly_step": self._relative(self.assembly_step),
                    "assembly_step_sha256": self.assembly_step_sha256,
                    "interfaces_sha256": self.interfaces_sha256,
                    "part_records_sha256": {pn: p.record_sha256 for pn, p in sorted(self.parts.items())}}
        spec = (part.record.get("procurement") or {}).get("specification") or {}
        # a specification known only by url and hash: the package rests on a copy the record does not hold
        sourcing = ([{"input": "specification", **{k: spec[k] for k in ("reference", "revision", "url", "sha256")},
                      "frozen_copy": "outside the record"}] if spec and "artifact" not in spec else [])
        return {**common, "part_record_sha256": part.record_sha256, "model_sha256": part.model_sha256,
                "step": self._relative(part.step), "step_sha256": part.step_sha256,
                "interfaces_sha256": self.interfaces_sha256,
                "drawing_features_sha256": self.features_sha256 if part.features is not None else None,
                "sourcing_inputs": sourcing}
    def _relative(self, path: Path) -> str:
        return str(path.relative_to(self.hw))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@cache
def _validator() -> Any:
    """cad-record's validate.py, the single record validator; it needs jsonschema and PyYAML."""
    spec = importlib.util.spec_from_file_location("cad_record_validate", VALIDATOR)
    if spec is None or spec.loader is None:
        raise ContractError("invalid_drawing_intent", f"cannot load the record validator at {VALIDATOR}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module

@cache
def layout_api() -> Any:
    """Load cad-record's authoritative path and bundle API once per process."""
    name = "cad_record_layout"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, LAYOUT)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load cad-record layout API at {LAYOUT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        del sys.modules[name]
        raise
    return module


def _json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ContractError("source_mismatch", f"cannot read {path}: {exc}") from exc


def _yaml(path: Path) -> Any:
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise ContractError("invalid_drawing_intent", f"cannot read {path}: {exc}") from exc


def _verify_files(version_dir: Path, manifest: Mapping[str, Any]) -> dict[str, str]:
    """Every file the manifest lists, by name, with its hash; each must still equal the manifest's."""
    verified = {}
    for name, expected in sorted(manifest.get("files", {}).items()):
        path = version_dir / name
        if not path.is_file():
            raise ContractError("source_mismatch", f"{path} is missing")
        actual = sha256(path)
        if actual != expected:
            raise ContractError("source_mismatch", f"{path} changed after the build: sha256 {actual} != {expected}")
        verified[name] = actual
    return verified


def load_context(hw: Path, version_dir: Path) -> DrawingContext:
    """Validate the record, verify ``version_dir`` against its manifest and the record, and bind them."""
    hw, version_dir = hw.resolve(), version_dir.resolve()
    if version_dir.parent != hw / "versions":
        raise ContractError("source_mismatch", f"{version_dir} is not a version folder of {hw}/versions")
    failures = tuple(_validator().blocking(_validator().validate_project(hw)))
    if failures:
        raise ContractError("invalid_drawing_intent", f"the design record has {len(failures)} validation findings",
                            failures)

    manifest_path = version_dir / "manifest.json"
    manifest = _json(manifest_path)
    verified = _verify_files(version_dir, manifest)

    def listed(name: str) -> tuple[Path, str]:
        if name not in verified:
            raise ContractError("source_mismatch", f"{version_dir.name}/manifest.json does not list {name}")
        return version_dir / name, verified[name]

    product_path = hw / "product.yaml"
    product = _yaml(product_path)
    if manifest.get("product_id") != product["id"]:
        raise ContractError("source_mismatch", f"{version_dir.name} was built for product {manifest.get('product_id')!r}, "
                                               f"not {product['id']!r}")
    if sha256(hw / "assembly.yaml") != manifest.get("assembly_yaml_sha256"):
        raise ContractError("source_mismatch", f"assembly.yaml changed after {version_dir.name} was built")

    metrics = _json(listed("metrics.json")[0])["parts"]
    features_name = manifest.get("drawing_features")
    features_sha256 = None
    located: Mapping[str, Any] = {}
    if features_name is not None:
        features_path, features_sha256 = listed(features_name)
        located = _json(features_path)["parts"]
    assembly_step, assembly_step_sha256 = listed("assembly.step")

    parts: dict[str, PartContext] = {}
    for pn, built in sorted(manifest["parts"].items()):
        record_path = hw / "parts" / pn / "part.yaml"
        if not record_path.is_file():
            raise ContractError("source_mismatch", f"{pn} was built in {version_dir.name} but has no {record_path}")
        model = hw / built["model"]
        if not model.is_file() or sha256(model) != built["source_sha256"]:
            raise ContractError("source_mismatch", f"{model} changed after {version_dir.name} was built")
        step, step_sha256 = listed(built["step"])
        parts[pn] = PartContext(pn=pn, record=_yaml(record_path), record_sha256=sha256(record_path),
                                model_sha256=built["source_sha256"], step=step, step_sha256=step_sha256,
                                metrics=metrics[pn], features=located.get(pn))
    with (hw / "bom.csv").open(newline="", encoding="utf-8") as stream:
        bom = tuple(csv.DictReader(stream))
    interfaces_path = version_dir / "record" / "interfaces.yaml"
    interfaces_sha256 = verified["record/interfaces.yaml"]
    interfaces = _yaml(interfaces_path)["interfaces"]
    assembly = _yaml(version_dir / "record" / "assembly.yaml")
    return DrawingContext(
        hw=hw, version_dir=version_dir, label=manifest["label"], manifest=manifest,
        manifest_sha256=sha256(manifest_path), product=product, product_sha256=sha256(product_path),
        interfaces=tuple(interfaces), interfaces_sha256=interfaces_sha256, assembly=assembly,
        assembly_step=assembly_step, assembly_step_sha256=assembly_step_sha256, bom=bom,
        features_sha256=features_sha256, parts=parts)