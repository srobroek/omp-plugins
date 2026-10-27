"""FreeCAD-side sheet export for sheet_export.py; freecadcmd runs this file headless.

The CAD_DRAWING_JOB environment variable names a JSON job file: the drawing SVG without its text
elements, the text runs taken out of it, the page size in mm, the preview resolution, and the PDF
and PNG paths. FreeCAD's bundled Qt paints on the offscreen platform: QSvgRenderer draws the
graphics and QPainter.drawText draws each run, which keeps the text as text in the PDF. One
painting goes to a QPdfWriter page of exactly the sheet size, one to a white PNG preview.

Runs in osifont, the TechDraw lettering font the templates name, or in a generic sans-serif family
use the osifont that FreeCAD ships, so the sheet looks the same on every host.

The result reports the preview size and its count of non-white pixels.
"""

import json
import os
import traceback

import FreeCAD as App
import numpy
from PySide6.QtCore import QByteArray, QMarginsF, QPointF, QRectF, QSizeF
from PySide6.QtGui import (QColor, QFont, QFontDatabase, QFontMetricsF, QGuiApplication, QImage, QPageLayout,
                           QPageSize, QPainter, QPdfWriter, QTransform)
from PySide6.QtSvg import QSvgRenderer

LETTERING_FONT = os.path.join("Mod", "TechDraw", "Resources", "fonts", "osifont-lgpl3fe.ttf")
GENERIC_FAMILIES = {"sans-serif", "sans"}
ANCHOR_SHIFT = {"start": 0.0, "middle": 0.5, "end": 1.0}
FONT_PIXELS = 100   # runs are laid out at this pixel size and scaled to their font size
DARK_LEVEL = 245    # a preview pixel with any channel below this is not white


def _lettering_family():
    font_id = QFontDatabase.addApplicationFont(os.path.join(App.getResourceDir(), LETTERING_FONT))
    families = QFontDatabase.applicationFontFamilies(font_id) if font_id >= 0 else []
    if not families:
        raise RuntimeError(f"cannot load the TechDraw lettering font {LETTERING_FONT}")
    return families[0]


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
        family = lettering if run["family"] in GENERIC_FAMILIES else run["family"]
        font = QFont(family)
        font.setPixelSize(FONT_PIXELS)
        font.setBold(run["bold"])
        font.setHintingPreference(QFont.HintingPreference.PreferNoHinting)
        advance = QFontMetricsF(font).horizontalAdvance(run["text"])
        painter.save()
        painter.setWorldTransform(QTransform(*run["matrix"]) * page)
        painter.translate(run["x"], run["y"])
        painter.scale(run["size"] / FONT_PIXELS, run["size"] / FONT_PIXELS)
        painter.setFont(font)
        painter.setPen(QColor(run["fill"]))
        painter.drawText(QPointF(-advance * ANCHOR_SHIFT.get(run["anchor"], 0.0), 0.0), run["text"])
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
    _write_pdf(job, renderer, lettering)
    return {"status": "pass", "png": _write_png(job, renderer, lettering)}


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
