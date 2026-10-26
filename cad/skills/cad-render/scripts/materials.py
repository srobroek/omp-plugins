"""Part appearance from assets/materials.json: part.yaml `material` and `finish` -> one PBR rule.

Stdlib only, so every consumer can import it without cad-render's browser stack: render.py
builds its three.js materials from the resolved rule, cad-viewer colours its parts with the
rule's `pbr.color`. Load it by path (importlib) and register it in `sys.modules` before running
it, as dataclasses need the module there.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

MATERIALS_PATH = Path(__file__).resolve().parent.parent / "assets" / "materials.json"
PBR_KEYS = {"color": str, "metalness": float, "roughness": float, "clearcoat": float,
            "clearcoatRoughness": float, "sheen": float, "sheenRoughness": float, "sheenColor": str,
            "transmission": float, "thickness": float, "ior": float, "specularIntensity": float}
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


class MaterialsError(RuntimeError):
    """materials.json is missing or malformed."""


@dataclass(frozen=True)
class MaterialRule:
    id: str
    label: str
    material: re.Pattern[str] | None
    finish: re.Pattern[str] | None
    pbr: dict[str, Any]

    def matches(self, material: str, finish: str) -> bool:
        if self.material is not None and not self.material.search(material):
            return False
        return self.finish is None or bool(self.finish.search(finish))


def _rule(entry: dict[str, Any], where: str) -> MaterialRule:
    pbr = entry.get("pbr")
    if not isinstance(pbr, dict) or "color" not in pbr:
        raise MaterialsError(f"{where}: pbr must be an object with a color")
    for key, value in pbr.items():
        kind = PBR_KEYS.get(key)
        if kind is None:
            raise MaterialsError(f"{where}: unknown pbr key {key!r}")
        if kind is str and not (isinstance(value, str) and HEX.match(value)):
            raise MaterialsError(f"{where}: {key} must be #rrggbb")
        if kind is float and not (isinstance(value, (int, float)) and value >= 0):
            raise MaterialsError(f"{where}: {key} must be a non-negative number")
    flags = re.IGNORECASE
    return MaterialRule(
        id=str(entry["id"]), label=str(entry["label"]),
        material=re.compile(entry["material"], flags) if "material" in entry else None,
        finish=re.compile(entry["finish"], flags) if "finish" in entry else None,
        pbr=dict(pbr))


@dataclass(frozen=True)
class MaterialTable:
    rules: list[MaterialRule]
    default: MaterialRule

    @classmethod
    def load(cls, path: Path = MATERIALS_PATH) -> MaterialTable:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            rules = [_rule(r, f"{path.name} rule {i}") for i, r in enumerate(data["rules"])]
            default = _rule(data["default"], f"{path.name} default")
        except (OSError, ValueError, KeyError, TypeError, re.error) as exc:
            raise MaterialsError(f"{path}: {exc}") from exc
        if any(r.material is None for r in rules):
            raise MaterialsError(f"{path}: every rule needs a material regex")
        return cls(rules, default)

    def resolve(self, material: str, finish: str) -> MaterialRule:
        """The first rule matching both, else the neutral default."""
        return next((r for r in self.rules if r.matches(material, finish)), self.default)
