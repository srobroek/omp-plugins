#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow==13.0.0"]
# ///
"""Compare two cad-render bundles or scratch directories by decisions and PNG pixel parity."""
from __future__ import annotations

import argparse
import importlib.util
import json
import math
import sys

from pathlib import Path
from typing import Any
from PIL import Image, ImageChops
def _render_data(directory: Path) -> dict[str, Any]:
    """Read the decision metadata from a published bundle or a scratch render directory."""
    data = json.loads((directory / "render.json").read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("views"), dict):
        raise ValueError(f"{directory / 'render.json'}: expected an object with a views map")
    for name, entry in data["views"].items():
        if not isinstance(entry, dict) or not isinstance(entry.get("png"), str):
            raise ValueError(f"{directory / 'render.json'}: view {name!r} has no PNG path")
        png = Path(entry["png"])
        if png.is_absolute() or ".." in png.parts:
            raise ValueError(f"{directory / 'render.json'}: view {name!r} has an unsafe PNG path")
    return data

_parity_spec = importlib.util.spec_from_file_location(
    "cad_render_parity_policy", Path(__file__).resolve().with_name("parity_policy.py"))
if _parity_spec is None or _parity_spec.loader is None:
    raise RuntimeError("cannot load parity_policy.py beside compare_renders.py")
_parity = importlib.util.module_from_spec(_parity_spec)
sys.modules[_parity_spec.name] = _parity
_parity_spec.loader.exec_module(_parity)
MAX_PIXEL_CHANNEL_DELTA = _parity.MAX_PIXEL_CHANNEL_DELTA
MIN_IDENTICAL_PIXEL_FRACTION = _parity.MIN_IDENTICAL_PIXEL_FRACTION


def decisions(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        name: {
            "status": entry["quality"]["status"],
            "failures": entry["quality"]["failures"],
            "warnings": entry["quality"]["warnings"],
            "strategy": entry["retry"]["strategy"],
            "attempts": [(attempt["strategy"], attempt["failures"], attempt["warnings"])
                         for attempt in entry["retry"]["attempts"]],
        }
        for name, entry in manifest["views"].items()
    }


def compare_images(left: Path, right: Path) -> dict[str, int | float | bool]:
    with Image.open(left) as left_image, Image.open(right) as right_image:
        if left_image.size != right_image.size:
            raise ValueError(f"image size mismatch: {left_image.size} vs {right_image.size}")
        left_image.load()
        right_image.load()
        left_image = left_image.convert("RGBA")
        right_image = right_image.convert("RGBA")
        difference = ImageChops.difference(left_image, right_image)
        channel_histogram = difference.histogram()
        max_channel_delta = max(
            delta
            for channel in range(4)
            for delta, count in enumerate(channel_histogram[channel * 256:(channel + 1) * 256])
            if count
        )

        pixel_delta = ImageChops.lighter(
            ImageChops.lighter(difference.getchannel("R"), difference.getchannel("G")),
            ImageChops.lighter(difference.getchannel("B"), difference.getchannel("A")),
        )
        pixel_histogram = pixel_delta.histogram()
        pixels = left_image.width * left_image.height
        differing_pixels = sum(pixel_histogram[MAX_PIXEL_CHANNEL_DELTA + 1:])
        percentile_rank = math.ceil(pixels * 0.999)
        cumulative = p999_pixel_max_channel_delta = 0
        for delta, count in enumerate(pixel_histogram):
            cumulative += count
            if cumulative >= percentile_rank:
                p999_pixel_max_channel_delta = delta
                break
        identical_fraction = 1 - differing_pixels / pixels
        return {
            "max_channel_delta": max_channel_delta,
            "p999_pixel_max_channel_delta": p999_pixel_max_channel_delta,
            "differing_pixels": differing_pixels,
            "differing_pixel_fraction": differing_pixels / pixels,
            "identical_pixel_fraction": identical_fraction,
            "pass": max_channel_delta <= MAX_PIXEL_CHANNEL_DELTA
            and identical_fraction >= MIN_IDENTICAL_PIXEL_FRACTION,
        }


def compare(left: Path, right: Path) -> dict[str, Any]:
    left_metadata = _render_data(left)
    right_metadata = _render_data(right)
    left_views = left_metadata["views"]
    right_views = right_metadata["views"]
    if set(left_views) != set(right_views):
        return {"pass": False, "reason": "view sets differ",
                "left_views": sorted(left_views), "right_views": sorted(right_views)}

    left_decisions = decisions(left_metadata)
    right_decisions = decisions(right_metadata)
    decision_mismatch = [name for name in left_views if left_decisions[name] != right_decisions[name]]
    reports = {name: compare_images(left / Path(left_views[name]["png"]),
                                    right / Path(right_views[name]["png"])) for name in left_views}
    return {"pass": not decision_mismatch and all(report["pass"] for report in reports.values()),
            "view_count": len(reports), "decision_mismatch_views": decision_mismatch, "views": reports}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("left", type=Path, help="first render directory")
    parser.add_argument("right", type=Path, help="second render directory")
    args = parser.parse_args(argv)
    try:
        result = compare(args.left, args.right)
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
        print(json.dumps({"pass": False, "error": str(exc)}))
        return 2
    print(json.dumps(result, indent=2))
    return 0 if result["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
