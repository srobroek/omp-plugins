# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["cadquery-ocp-novtk==8.0.1.1.0", "pyyaml>=6.0"]
# ///
"""Engineering BOM roll-up from a STEP AP242 assembly and the hw/ design record.

Usage: uv run --script skill://cad-flow/scripts/run.py cad-bom/scripts/bom.py ASSEMBLY.step --hw HW_DIR [--out HW_DIR/bom.csv]

Reads the STEP product tree through OCP XDE, groups the components of every
assembly by the product they instance, and writes an indented BOM:

    level   0 for a numbered top-level product, parent depth + 1 below it; the
            children of an unnumbered top assembly start at level 1
    PN      the product name's leading part number (^[A-Z]{2,5}-\\d{4}), so a
            product named "PIN-0001" or "PIN-0001 Dowel pin" is PIN-0001
    qty     instances per one parent; a repeated subassembly is listed once
            with its qty, and its children once beneath it
    rev, title, material, process, make_buy, supplier, mass
            from hw/parts/<PN>/part.yaml; mass is mass_target verbatim
    unit    "pcs": qty counts STEP instances
    designation, manufacturer, manufacturer_part_number, supplier_part_number
            from part.yaml `procurement`
    specification_ref, specification_rev
            from part.yaml `procurement.specification` reference and revision

An assembly product whose name carries no part number is a phantom grouping:
its children roll up into the nearest numbered ancestor with multiplied qty.
An assembly product needs no part.yaml; a leaf part does. OCP and PyYAML are
imported inside the readers so `roll_up` stays importable by plain unit tests.

stdout: JSON summary. stderr: diagnostics (OCCT translator output included).
Exit 0 = BOM complete, 1 = record mismatch (leaf part without part.yaml,
part.yaml absent from STEP, or a leaf product without a part number; bom.csv
is still written), 2 = usage or infrastructure error.
"""

from __future__ import annotations

import argparse
import contextlib
import csv
import ctypes
import functools
import importlib.util
import json
import os
import re
import sys
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
LAYOUT_PATH = Path(__file__).resolve().parents[2] / "cad-record" / "scripts" / "layout.py"
_SPEC = importlib.util.spec_from_file_location("cad_record_layout", LAYOUT_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise ImportError(f"{LAYOUT_PATH} not found")
LAYOUT = sys.modules.get("cad_record_layout")
if LAYOUT is None:
    LAYOUT = importlib.util.module_from_spec(_SPEC)
    sys.modules["cad_record_layout"] = LAYOUT
    _SPEC.loader.exec_module(LAYOUT)

COLUMNS = ("level", "PN", "rev", "qty", "title", "material", "process", "make_buy", "supplier", "mass",
           "unit", "designation", "manufacturer", "manufacturer_part_number", "supplier_part_number",
           "specification_ref", "specification_rev")
PART_FIELDS = ("rev", "title", "material", "process", "make_buy", "supplier")
PROCUREMENT_FIELDS = ("designation", "manufacturer", "manufacturer_part_number", "supplier_part_number")
PN_PREFIX = re.compile(r"^([A-Z]{2,5}-\d{4})(?![0-9])")
PN_EXACT = re.compile(r"^[A-Z]{2,5}-\d{4}$")


class BomError(RuntimeError):
    """The inputs cannot be read; maps to exit 2."""


@dataclass
class Node:
    """One product of the STEP tree: a part, or an assembly of other products."""

    name: str
    is_assembly: bool
    children: list[tuple["Node", int]] = field(default_factory=list)  # (product, instances), first-seen order

    @property
    def pn(self) -> str | None:
        match = PN_PREFIX.match(self.name)
        return match.group(1) if match else None


@contextlib.contextmanager
def _stdout_to_stderr() -> Iterator[None]:
    """Route OCCT's console output away from the JSON channel.

    OCCT prints through C stdio, which holds the bytes when stdout is a pipe (fully buffered), so
    the buffers are flushed on both sides of the swap: what OCCT prints inside reaches stderr, not
    fd 1 at exit after the JSON."""
    _flush_stdout()
    saved = os.dup(1)
    try:
        os.dup2(2, 1)
        yield
    finally:
        _flush_stdout()
        os.dup2(saved, 1)
        os.close(saved)


def _flush_stdout() -> None:
    sys.stdout.flush()
    _c_library().fflush(None)  # NULL: every C stdio output stream


@functools.cache
def _c_library() -> ctypes.CDLL:
    return ctypes.CDLL(None) if os.name == "posix" else ctypes.CDLL("ucrtbase")


def read_step_tree(path: Path) -> list[Node]:
    """Return the top-level products of a STEP file as a product tree."""
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.STEPCAFControl import STEPCAFControl_Reader
    from OCP.TCollection import TCollection_AsciiString, TCollection_ExtendedString
    from OCP.TDataStd import TDataStd_Name
    from OCP.TDF import TDF_Label, TDF_Tool
    from OCP.TDocStd import TDocStd_Document
    from OCP.XCAFApp import XCAFApp_Application
    from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ShapeTool
    from OCP.collections import Sequence_TDF_Label

    with _stdout_to_stderr():
        doc = TDocStd_Document(TCollection_ExtendedString("MDTV-XCAF"))
        XCAFApp_Application.GetApplication_s().InitDocument(doc)
        reader = STEPCAFControl_Reader()
        reader.SetNameMode(True)
        if reader.ReadFile(str(path)) != IFSelect_RetDone:
            raise BomError(f"cannot read STEP file {path}")
        if not reader.Transfer(doc):
            raise BomError(f"STEP transfer failed for {path}")
    tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())

    def label_name(label: Any) -> str:
        attribute = TDataStd_Name()
        if label.FindAttribute(TDataStd_Name.GetID_s(), attribute):
            return attribute.Get().ToExtString()
        return ""

    products: dict[str, Node] = {}  # label entry -> product, so repeated instances share one node

    def product(label: Any) -> Node:
        key = TCollection_AsciiString()
        TDF_Tool.Entry_s(label, key)
        entry = key.ToCString()
        cached = products.get(entry)
        if cached is not None:
            return cached
        node = Node(label_name(label), XCAFDoc_ShapeTool.IsAssembly_s(label))
        products[entry] = node
        if node.is_assembly:
            components = Sequence_TDF_Label()
            XCAFDoc_ShapeTool.GetComponents_s(label, components, False)
            counts: dict[int, list[Any]] = {}
            for index in range(1, components.Length() + 1):
                referred = TDF_Label()
                if not XCAFDoc_ShapeTool.GetReferredShape_s(components.Value(index), referred):
                    continue
                child = product(referred)
                slot = counts.setdefault(id(child), [child, 0])
                slot[1] += 1
            node.children = [(child, qty) for child, qty in counts.values()]
        return node

    roots = Sequence_TDF_Label()
    tool.GetFreeShapes(roots)
    return [product(roots.Value(index)) for index in range(1, roots.Length() + 1)]


def load_parts(hw: Path, record_hw: Path | None = None) -> dict[str, dict[str, Any]]:
    """Return part.yaml mappings keyed by their parts/<PN> directory name."""
    import yaml

    parts: dict[str, dict[str, Any]] = {}
    root = (record_hw or hw) / "parts"
    if not root.is_dir():
        return parts
    for part_yaml in sorted(root.glob("*/part.yaml")):
        pn = part_yaml.parent.name
        if not PN_EXACT.match(pn):
            print(f"bom: skipping {part_yaml}: directory {pn!r} is not a part number", file=sys.stderr)
            continue
        try:
            data = yaml.safe_load(part_yaml.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError) as error:
            raise BomError(f"cannot read {part_yaml}: {error}") from error
        if not isinstance(data, dict):
            raise BomError(f"{part_yaml} must be a mapping")
        parts[pn] = data
    return parts


def _cell(value: Any) -> str:
    return "" if value is None else str(value)


def roll_up(roots: list[Node], parts: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Flatten the product tree into indented BOM rows and record mismatches."""
    rows: list[dict[str, str]] = []
    totals: dict[str, int] = {}
    in_step: set[str] = set()
    missing_part_yaml: set[str] = set()
    unidentified: set[str] = set()

    def numbered_children(node: Node, factor: int) -> list[tuple[Node, int]]:
        """Children of `node`, with phantom assemblies expanded in place."""
        merged: dict[int, list[Any]] = {}
        for child, qty in node.children:
            if child.pn is None and child.is_assembly:
                expanded = numbered_children(child, factor * qty)
            else:
                expanded = [(child, factor * qty)]
            for grandchild, count in expanded:
                merged.setdefault(id(grandchild), [grandchild, 0])[1] += count
        return [(child, qty) for child, qty in merged.values()]

    def emit(node: Node, level: int, qty: int, multiplier: int) -> None:
        pn = node.pn
        if pn is None:
            unidentified.add(node.name or "<unnamed>")
            return
        in_step.add(pn)
        totals[pn] = totals.get(pn, 0) + qty * multiplier
        meta = parts.get(pn)
        if meta is None and not node.is_assembly:
            missing_part_yaml.add(pn)
        meta = meta or {}
        title = meta.get("title")
        if title is None:
            title = node.name[len(pn):].strip(" _-:") or None
        row = {"level": str(level), "PN": pn, "qty": str(qty), "mass": _cell(meta.get("mass_target")), "unit": "pcs"}
        row.update({key: _cell(meta.get(key)) for key in PART_FIELDS})
        procurement = meta.get("procurement") if isinstance(meta.get("procurement"), dict) else {}
        specification = procurement.get("specification") if isinstance(procurement.get("specification"), dict) else {}
        row.update({key: _cell(procurement.get(key)) for key in PROCUREMENT_FIELDS})
        row["specification_ref"] = _cell(specification.get("reference"))
        row["specification_rev"] = _cell(specification.get("revision"))
        row["title"] = _cell(title)
        rows.append(row)
        for child, count in numbered_children(node, 1):
            emit(child, level + 1, count, qty * multiplier)

    for root in roots:
        if root.pn is None and root.is_assembly:  # unnumbered top assembly: its children stay at level 1
            for child, count in numbered_children(root, 1):
                emit(child, 1, count, 1)
        else:
            emit(root, 0, 1, 1)

    return {
        "rows": rows,
        "total_qty": dict(sorted(totals.items())),
        "missing_part_yaml": sorted(missing_part_yaml),
        "missing_in_step": sorted(set(parts) - in_step),
        "unidentified": sorted(unidentified),
    }


def write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=COLUMNS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="EBOM roll-up from a STEP AP242 assembly")
    parser.add_argument("step", type=Path, help="STEP AP242 assembly file")
    parser.add_argument("--hw", type=Path, required=True, help="hardware design record directory (hw/)")
    parser.add_argument("--version", help="built version snapshot to reconcile against")
    parser.add_argument("--out", type=Path, help="BOM path; only hw/bom.csv or .cad-work destinations are allowed")
    args = parser.parse_args(argv)
    record_hw = args.hw
    version = None
    if args.version:
        try:
            version, _, record_hw = LAYOUT.built_version(args.hw, args.version)
        except LAYOUT.LayoutError as error:
            print(f"bom: {error}", file=sys.stderr)
            return 2
    try:
        if args.out and args.out.resolve() == (args.hw / "bom.csv").resolve():
            out = args.out.resolve()
        else:
            out = LAYOUT.scratch_path(args.hw, args.out, "--out") if args.out else (args.hw / "bom.csv").resolve()
    except LAYOUT.LayoutError as error:
        print(f"bom: {error}", file=sys.stderr)
        return 2
    if not args.step.is_file():
        print(f"bom: STEP file not found: {args.step}", file=sys.stderr)
        return 2
    try:
        result = roll_up(read_step_tree(args.step), load_parts(args.hw, record_hw))
        write_csv(out, result["rows"])
    except (BomError, OSError) as error:
        print(f"bom: {error}", file=sys.stderr)
        return 2
    failed = bool(result["missing_part_yaml"] or result["missing_in_step"] or result["unidentified"])
    summary = {"status": "fail" if failed else "pass", "bom_csv": str(out), **result}
    if version:
        summary["reconciled_against"] = version
    json.dump(summary, sys.stdout, indent=2)
    sys.stdout.write("\n")
    for key in ("missing_part_yaml", "missing_in_step", "unidentified"):
        if result[key]:
            print(f"bom: {key}: {', '.join(result[key])}", file=sys.stderr)
    return 1 if failed else 0



if __name__ == "__main__":
    sys.exit(main())
