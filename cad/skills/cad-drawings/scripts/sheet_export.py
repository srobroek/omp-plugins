"""Export a checked drawing SVG to a sheet-sized PDF and PNG preview.

FreeCAD's bundled Qt renders graphics and PDF text. Osifont provides standard drawing lettering.
Symbols missing from it use explicit vector paths; all other unsupported glyphs fail instead of
falling back to the host's fonts and producing platform-dependent PDFs.
"""

from __future__ import annotations

import re
import zlib
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

from defusedxml import ElementTree as SafeET

import freecad_runtime
from layout_check import SVG_NS, parse_transform

EXPORT_JOB = Path(__file__).resolve().parent / "export_job.py"
PREVIEW_DPI = 144                 # the preview resolution the AppKit exporter used: 2 px per point
MIN_DARK_PIXELS = 200             # fewer non-white preview pixels than this is a blank render
PAGE_TOLERANCE_PT = 0.5           # Qt writes the page size in whole points
MM_PER_UNIT = {"mm": 1.0, "cm": 10.0, "in": 25.4}
TEXT = f"{{{SVG_NS}}}text"
TSPAN = f"{{{SVG_NS}}}tspan"
# Text properties a text chunk inherits from its ancestors.
TEXT_PROPERTIES = ("font-size", "font-family", "font-weight", "text-anchor", "fill")
_NUMBER = re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")
OSIFONT_CODEPOINTS = frozenset(range(0x20, 0x7f))
VECTOR_SYMBOLS = {
    "⟂": '<path d="M -3 3 H 3 M 0 3 V -3" fill="none" stroke="currentColor" stroke-width="1"/>',
    "⊥": '<path d="M -3 3 H 3 M 0 3 V -3" fill="none" stroke="currentColor" stroke-width="1"/>',
    "∥": '<path d="M -1.5 3 L 1.5 -3 M 0 3 L 3 -3" fill="none" stroke="currentColor" stroke-width="1"/>',
    "−": '<path d="M -3 0 H 3" fill="none" stroke="currentColor" stroke-width="1"/>',
    "×": '<path d="M -3 -3 L 3 3 M -3 3 L 3 -3" fill="none" stroke="currentColor" stroke-width="1"/>',
    "·": '<circle cx="0" cy="-1" r="1" fill="currentColor"/>',
}
VECTOR_ADVANCE = 70.0


class ExportError(Exception):
    """An export that failed: ``code`` is ``empty_drawing`` (blank, or text missing) or ``export_failed``."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def sheet_size_mm(root: ET.Element) -> tuple[float, float]:
    """The sheet size from the SVG root's ``width`` and ``height``."""
    size = []
    for name in ("width", "height"):
        match = re.fullmatch(rf"\s*({_NUMBER.pattern})\s*(mm|cm|in)\s*", root.get(name) or "")
        if not match:
            raise ExportError("export_failed", f"SVG {name} {root.get(name)!r} is not a length in mm, cm or in")
        size.append(float(match.group(1)) * MM_PER_UNIT[match.group(2)])
    return size[0], size[1]


def _properties(element: ET.Element, inherited: dict[str, str]) -> dict[str, str]:
    """Inherited text properties overridden by presentation attributes, then by the style attribute."""
    properties = dict(inherited)
    properties.update({name: element.get(name) for name in TEXT_PROPERTIES if element.get(name)})
    for declaration in (element.get("style") or "").split(";"):
        name, _, value = declaration.partition(":")
        if name.strip() in TEXT_PROPERTIES and value.strip():
            properties[name.strip()] = value.strip()
    return properties


def _first_number(value: str | None) -> float | None:
    match = _NUMBER.search(value or "")
    return float(match.group()) if match else None


@dataclass
class _Chunk:
    x: float
    y: float
    style: dict[str, str] | None = None
    content: str = ""


def _chunks(text: ET.Element, properties: dict[str, str]) -> Iterator[_Chunk]:
    """The text chunks of one text element: a new chunk starts at each x or y; one style per chunk.

    A chunk takes the properties of the node that supplies its first characters, and its content
    collapses whitespace as SVG does by default.
    """
    chunks: list[_Chunk] = []

    def add(content: str | None, style: dict[str, str]) -> None:
        if content and content.strip():
            chunks[-1].style = chunks[-1].style or style
            chunks[-1].content += content

    def visit(node: ET.Element, inherited: dict[str, str]) -> None:
        style = _properties(node, inherited)
        x, y = _first_number(node.get("x")), _first_number(node.get("y"))
        if node is text or x is not None or y is not None:
            previous = chunks[-1] if chunks else _Chunk(0.0, 0.0)
            chunks.append(_Chunk(previous.x if x is None else x, previous.y if y is None else y))
        add(node.text, style)
        for child in node:
            if child.tag == TSPAN:
                visit(child, style)
            add(child.tail, style)

    visit(text, properties)
    for chunk in chunks:
        if chunk.style is not None:
            yield _Chunk(chunk.x, chunk.y, chunk.style, " ".join(chunk.content.split()))


def split_text(root: ET.Element, supported_codepoints: frozenset[int] | None = None) -> list[dict[str, Any]]:
    """Split SVG text into font runs and registered vector glyphs; reject unhandled characters."""
    supported = OSIFONT_CODEPOINTS if supported_codepoints is None else supported_codepoints
    runs: list[dict[str, Any]] = []

    def walk(element: ET.Element, transform: str, inherited: dict[str, str]) -> None:
        transform = f"{transform} {element.get('transform') or ''}"
        properties = _properties(element, inherited)
        for child in list(element):
            if child.tag != TEXT:
                walk(child, transform, properties)
                continue
            element.remove(child)
            matrix = parse_transform(f"{transform} {child.get('transform') or ''}")
            for chunk in _chunks(child, properties):
                style = chunk.style or {}
                if style.get("fill", "#000000") == "none":
                    continue
                size = _first_number(style.get("font-size"))
                if size is None:
                    raise ExportError("export_failed", f"SVG text {chunk.content!r} has no font size")
                weight = style.get("font-weight", "normal")
                segments = []
                pending = []
                for character in chunk.content:
                    if character in VECTOR_SYMBOLS:
                        if pending:
                            segments.append({"text": "".join(pending)})
                            pending.clear()
                        segments.append({"vector": character})
                    elif ord(character) in supported:
                        pending.append(character)
                    else:
                        raise ExportError("unsupported_glyph",
                                          f"SVG text contains unsupported glyph {character!r} (U+{ord(character):04X})")
                if pending:
                    segments.append({"text": "".join(pending)})

                runs.append({"segments": segments, "vector_advance": VECTOR_ADVANCE, "vector_markup": VECTOR_SYMBOLS,
                             "x": chunk.x, "y": chunk.y, "anchor": style.get("text-anchor", "start"),
                             "size": size, "family": "osifont",
                             "bold": weight == "bold" or (weight.isdigit() and int(weight) >= 600),
                             "fill": style.get("fill", "#000000"), "matrix": list(matrix)})

    walk(root, "", {})
    return runs
@dataclass(frozen=True)
class PdfContent:
    page_sizes_pt: list[tuple[float, float]]
    fonts: list[str]
    text: str


def _to_unicode(cmap: bytes) -> dict[int, str]:
    """Glyph code to text from a ToUnicode CMap's bfchar and bfrange entries."""
    def chars(hexadecimal: bytes) -> str:
        return bytes.fromhex(hexadecimal.decode()).decode("utf-16-be")

    mapping: dict[int, str] = {}
    for block in re.findall(rb"beginbfchar(.*?)endbfchar", cmap, re.S):
        for source, target in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>", block):
            mapping[int(source, 16)] = chars(target)
    for block in re.findall(rb"beginbfrange(.*?)endbfrange", cmap, re.S):
        for low, high, target in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]*>|\[[^\]]*\])", block):
            first, last = int(low, 16), int(high, 16)
            if target.startswith(b"["):
                for code, value in zip(range(first, last + 1), re.findall(rb"<([0-9A-Fa-f]*)>", target)):
                    mapping[code] = chars(value)
            else:
                start = int(target[1:-1], 16)
                mapping.update({code: chr(start + code - first) for code in range(first, last + 1)})
    return mapping


def read_pdf(path: Path) -> PdfContent:
    """Read the page sizes, font names and text of a PDF written by Qt's QPdfWriter.

    Qt writes plain object dictionaries, Flate-compressed content streams, a ``Tf`` per text item, a
    ``<glyph> Tj`` per glyph, a ToUnicode CMap per font, and repeats glyphs inside an empty
    ActualText span for synthetic bold. This reader handles that output, not PDF in general. Each
    text item becomes one line with its whitespace collapsed to single spaces: a font may map its
    space glyph back to a tab.
    """
    data = path.read_bytes()
    objects: dict[int, tuple[bytes, bytes]] = {}
    for number, body in re.findall(rb"(?m)^(\d+) 0 obj\b(.*?)\bendobj", data, re.S):
        head, marker, rest = body.partition(b"stream")
        rest = rest[2:] if rest.startswith(b"\r\n") else rest[1:]  # the stream keyword's end of line
        stream = rest.rsplit(b"endstream", 1)[0] if marker else b""
        if stream and b"/FlateDecode" in head:
            stream = zlib.decompress(stream)
        objects[int(number)] = (head, stream)

    def reference(head: bytes, key: bytes) -> tuple[bytes, bytes]:
        match = re.search(rb"/" + key + rb"\s+(\d+)\s+0\s+R", head)
        if not match or int(match.group(1)) not in objects:
            raise ValueError(f"PDF object lacks a resolvable /{key.decode()}")
        return objects[int(match.group(1))]

    sizes, fonts, texts = [], [], []
    for head, _ in objects.values():
        if not re.search(rb"/Type\s*/Page(?![A-Za-z])", head):
            continue
        box = re.search(rb"/MediaBox\s*\[([^\]]*)\]", head)
        x0, y0, x1, y1 = (float(value) for value in _NUMBER.findall(box.group(1).decode())) if box else (0, 0, 0, 0)
        sizes.append((x1 - x0, y1 - y0))
        resources, _ = reference(head, b"Resources")
        font_block = re.search(rb"/Font\s*<<(.*?)>>", resources, re.S)
        maps: dict[bytes, dict[int, str]] = {}
        for name, number in re.findall(rb"/(\w+)\s+(\d+)\s+0\s+R", font_block.group(1) if font_block else b""):
            if int(number) not in objects:
                raise ValueError(f"PDF font /{name.decode()} has no object {number.decode()}")
            font, _ = objects[int(number)]
            base = re.search(rb"/BaseFont\s*/(\S+)", font)
            fonts.append(base.group(1).decode() if base else name.decode())
            maps[name] = _to_unicode(reference(font, b"ToUnicode")[1])
        _, content = reference(head, b"Contents")
        content = re.sub(rb"/Span\s*<<\s*/ActualText\s*<>\s*>>\s*BDC.*?EMC", b"", content, flags=re.S)
        for block in re.findall(rb"\bBT\b(.*?)\bET\b", content, re.S):
            font_name = re.search(rb"/(\w+)\s+[-+.\d]+\s+Tf", block)
            glyphs = maps.get(font_name.group(1), {}) if font_name else {}
            chars = "".join(glyphs.get(int(code, 16), "") for code in re.findall(rb"<([0-9A-Fa-f]+)>\s*Tj", block))
            texts.append(" ".join(chars.split()))
    return PdfContent(page_sizes_pt=sizes, fonts=sorted(set(fonts)), text="\n".join(texts))


def export_sheet(freecadcmd: Path, svg: Path, pdf: Path, png: Path, required_text: Sequence[str],
                 timeout: float) -> dict[str, Any]:
    """Write ``pdf`` and the ``png`` preview from a checked drawing ``svg``; raise ExportError on failure.

    Returns the preview size and dark pixel count, the page size in mm, and the PDF's fonts.
    """
    try:
        root = SafeET.parse(str(svg), forbid_dtd=True).getroot()
    except Exception as exc:
        raise ExportError("export_failed", f"invalid or unsafe SVG output: {exc}") from exc
    width, height = sheet_size_mm(root)
    codepoints = frozenset(map(ord, "".join("".join(element.itertext()) for element in root.iter(TEXT))))
    job: dict[str, Any] = {"svg_markup": ET.tostring(root, encoding="unicode"), "page_mm": [width, height],
                           "codepoints": sorted(codepoints), "vector_symbols": VECTOR_SYMBOLS,
                           "vector_advance": VECTOR_ADVANCE}
    for stale in (pdf, png):
        stale.unlink(missing_ok=True)
    result, message = freecad_runtime.run_job(freecadcmd, EXPORT_JOB, job, svg.parent, timeout)
    if result is None:
        raise ExportError("export_failed", message)
    job["texts"] = split_text(root, frozenset(result["supported_codepoints"]))
    job["svg_markup"] = ET.tostring(root, encoding="unicode")
    job.update(dpi=PREVIEW_DPI, pdf=str(pdf), png=str(png))
    result, message = freecad_runtime.run_job(freecadcmd, EXPORT_JOB, job, svg.parent, timeout)
    if result is None:
        raise ExportError("export_failed", message)
    if result["png"]["dark_pixels"] < MIN_DARK_PIXELS:
        raise ExportError("empty_drawing", f"PNG preview appears blank: {result['png']['dark_pixels']} dark pixels")
    try:
        content = read_pdf(pdf)
    except (OSError, ValueError, zlib.error) as exc:
        raise ExportError("export_failed", f"cannot read the written PDF: {exc}") from exc
    expected = (width * 72 / 25.4, height * 72 / 25.4)
    if len(content.page_sizes_pt) != 1 or any(abs(got - want) > PAGE_TOLERANCE_PT
                                              for got, want in zip(content.page_sizes_pt[0], expected)):
        raise ExportError("export_failed", f"PDF pages {content.page_sizes_pt} pt do not match one "
                                           f"{expected[0]:.1f} x {expected[1]:.1f} pt sheet")
    missing = [value for value in required_text
               if " ".join("".join(character for character in value if character not in VECTOR_SYMBOLS).split())
               not in content.text]
    if missing:
        raise ExportError("empty_drawing", f"PDF text layer missing required fields: {missing}")
    return {"png": result["png"], "page_mm": [width, height], "pdf_fonts": content.fonts}
