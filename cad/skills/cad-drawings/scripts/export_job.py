"""FreeCAD-side sheet export for sheet_export.py; freecadcmd runs this file headless.

CAD_DRAWING_JOB names JSON input and output paths; the job payload includes an SVG, vector text
runs, and sheet dimensions. FreeCAD's bundled Qt paints that output with its shipped TechDraw font.
"""

import json
import os
import traceback

import FreeCAD as App
import numpy
from PySide6.QtCore import QByteArray, QMarginsF, QPointF, QRectF, QSizeF
from PySide6.QtGui import (QColor, QFont, QFontDatabase, QFontMetricsF, QGuiApplication, QImage, QPageLayout,
                           QPageSize, QPainter, QPdfWriter, QRawFont, QTransform)
from PySide6.QtSvg import QSvgRenderer

LETTERING_FONT = os.path.join("Mod", "TechDraw", "Resources", "fonts", "osifont-lgpl3fe.ttf")
FONT_PIXELS = 100
ANCHOR_SHIFT = {"start": 0.0, "middle": 0.5, "end": 1.0}
DARK_LEVEL = 245


def _lettering_family():
    font_id = QFontDatabase.addApplicationFont(os.path.join(App.getResourceDir(), LETTERING_FONT))
    families = QFontDatabase.applicationFontFamilies(font_id) if font_id >= 0 else []
    if not families:
        raise RuntimeError(f"cannot load the TechDraw lettering font {LETTERING_FONT}")
    return families[0]

def _lettering_codepoints(lettering, codepoints):
    raw = QRawFont.fromFont(QFont(lettering))
    return frozenset(codepoint for codepoint in codepoints if raw.supportsCharacter(codepoint))

def _paint(painter, renderer, runs, lettering, width, height):
    """Paint the sheet into the device rectangle (0, 0, width, height)."""
    for hint in (QPainter.RenderHint.Antialiasing, QPainter.RenderHint.TextAntialiasing,
                 QPainter.RenderHint.SmoothPixmapTransform):
        painter.setRenderHint(hint)
    renderer.render(painter, QRectF(0, 0, width, height))
    box = renderer.viewBoxF()
    page = QTransform()
    page.scale(width / box.width(), height / box.height())
    page.translate(-box.x(), -box.y())
    for run in runs:
        font = QFont(lettering)
        font.setPixelSize(FONT_PIXELS)
        font.setBold(run["bold"])
        font.setHintingPreference(QFont.HintingPreference.PreferNoHinting)
        segments = run["segments"]
        segment_advances = [QFontMetricsF(font).horizontalAdvance(segment["text"]) if "text" in segment else
                            run["vector_advance"] for segment in segments]
        total_advance = sum(segment_advances)
        painter.save()
        painter.setWorldTransform(QTransform(*run["matrix"]) * page)
        painter.translate(run["x"], run["y"])
        painter.scale(run["size"] / FONT_PIXELS, run["size"] / FONT_PIXELS)
        painter.setFont(font)
        painter.setPen(QColor(run["fill"]))
        offset = -total_advance * ANCHOR_SHIFT.get(run["anchor"], 0.0)
        for segment, advance in zip(segments, segment_advances):
            if "text" in segment:
                painter.drawText(QPointF(offset, 0.0), segment["text"])
            else:
                markup = run["vector_markup"][segment["vector"]]
                renderer = QSvgRenderer(QByteArray(("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"-4 -4 8 8\">" +
                                                    markup + "</svg>").encode("utf-8")))
                painter.save()
                painter.translate(offset + advance / 2.0, -FONT_PIXELS / 2.0)
                painter.scale(FONT_PIXELS / 8.0, FONT_PIXELS / 8.0)
                renderer.render(painter, QRectF(-4, -4, 8, 8))
                painter.restore()
            offset += advance
        painter.restore()


def _write_pdf(job, renderer, lettering):
    width, height = job["page_mm"]
    writer = QPdfWriter(job["pdf"])
    writer.setCreator("cad-drawings")
    size = QPageSize(QSizeF(width, height), QPageSize.Unit.Millimeter, "", QPageSize.SizeMatchPolicy.ExactMatch)
    layout = QPageLayout(size, QPageLayout.Orientation.Portrait, QMarginsF(0, 0, 0, 0), QPageLayout.Unit.Millimeter)
    if not writer.setPageLayout(layout):
        raise RuntimeError(f"Qt rejected a {width} x {height} mm PDF page")
    painter = QPainter(writer)
    try:
        dots = writer.resolution() / 25.4
        _paint(painter, renderer, job["texts"], lettering, width * dots, height * dots)
    finally:
        painter.end()


def _write_png(job, renderer, lettering):
    width, height = job["page_mm"]
    dots = job["dpi"] / 25.4
    image = QImage(round(width * dots), round(height * dots), QImage.Format.Format_RGB32)
    image.setDotsPerMeterX(round(dots * 1000))
    image.setDotsPerMeterY(round(dots * 1000))
    image.fill(QColor("white"))
    painter = QPainter(image)
    try:
        _paint(painter, renderer, job["texts"], lettering, image.width(), image.height())
    finally:
        painter.end()
    if not image.save(job["png"], "PNG"):
        raise RuntimeError(f"cannot write {job['png']}")
    rows = numpy.frombuffer(image.constBits(), numpy.uint8).reshape(image.height(), image.bytesPerLine())
    pixels = rows[:, :image.width() * 4].reshape(image.height(), image.width(), 4)[..., :3]  # B, G, R of 0xffRRGGBB
    dark = int(numpy.count_nonzero(pixels.min(axis=2) < DARK_LEVEL))
    return {"width": image.width(), "height": image.height(), "dark_pixels": dark}


def export(job):
    renderer = QSvgRenderer(QByteArray(job["svg_markup"].encode("utf-8")))
    if not renderer.isValid():
        raise RuntimeError("Qt cannot render the drawing SVG")
    lettering = _lettering_family()
    supported = _lettering_codepoints(lettering, job["codepoints"])
    if "texts" not in job:
        return {"status": "pass", "supported_codepoints": sorted(supported)}
    _write_pdf(job, renderer, lettering)
    preview = _write_png(job, renderer, lettering)
    return {"status": "pass", "supported_codepoints": sorted(supported), "png": preview}


def main():
    with open(os.environ["CAD_DRAWING_JOB"], encoding="utf-8") as handle:
        job = json.load(handle)
    # Painting and font loading need a GUI application object; this one lives until main returns.
    application = QGuiApplication.instance() or QGuiApplication(["export_job", "-platform", "offscreen"])  # noqa: F841
    try:
        result = export(job)
    except Exception as exc:
        result = {"status": "error", "error": str(exc), "traceback": traceback.format_exc()}
    with open(job["result"], "w", encoding="utf-8") as handle:
        json.dump(result, handle)


main()
