"""How a manufactured part sits on the printer bed: the one owner of build orientation, for run and check.

A placement is a proper rigid transform: rotation rows with determinant +1, then a translation. It is
never a reflection, a scaling or a shear. A permutation name such as `xzy` says which part axis each
printer axis takes; alone it can describe a mirror, so `permutation_rotation` reverses the printer X
row whenever the plain permutation has determinant -1.
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass
from typing import Any, Mapping

from cadmodel import occ
from cadmodel.motion import load_pose

ORIENTATIONS = ("xyz", "xzy", "yxz", "yzx", "zxy", "zyx")
FIT_SLACK_MM = 1e-9  # a size within this of a usable axis fits
PROPER_TOL = 1e-9    # allowed |det - 1| and |(R R^T - I) entry| of a proper rotation

Vec = tuple[float, float, float]
Rot = tuple[Vec, Vec, Vec]
IDENTITY: Rot = ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))


@dataclass(frozen=True)
class BuildVolume:
    """product.yaml `build_volume`: the printer envelope, the margin reserved at both ends of each axis,
    and the permutations a part may be printed in."""

    size_mm: Vec
    margin_mm: float
    orientations: tuple[str, ...]

    @property
    def usable_mm(self) -> Vec:
        return tuple(dimension - 2.0 * self.margin_mm for dimension in self.size_mm)  # type: ignore[return-value]

    @staticmethod
    def declared(product: Any) -> BuildVolume | None:
        """The volume a product record declares; None when it declares none; ValueError when malformed."""
        block = product.get("build_volume") if isinstance(product, Mapping) else None
        if not isinstance(block, Mapping):
            return None
        try:
            size = tuple(float(block[axis]) for axis in ("x_mm", "y_mm", "z_mm"))
            margin = float(block.get("margin_mm", 0.0))
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(f"build_volume needs numeric x_mm, y_mm and z_mm: {error}") from error
        allowed = block.get("orientations", ORIENTATIONS)
        orientations = tuple(name for name in allowed if name in ORIENTATIONS) if isinstance(allowed, list) else ORIENTATIONS
        return BuildVolume(size, margin, orientations)  # type: ignore[arg-type]

    def describe(self) -> dict[str, Any]:
        return {"size_mm": list(self.size_mm), "margin_mm": self.margin_mm, "usable_mm": list(self.usable_mm),
                "orientations": list(self.orientations)}


@dataclass(frozen=True)
class Fit:
    """A proper rotation under which the part's box fits the usable volume."""

    method: str  # axis_aligned (an allowed permutation) or oriented (the minimum-volume oriented box)
    orientation: str  # the permutation name, or "oriented"
    rotation: Rot  # printer axis i = rotation[i] . part coordinates
    size_mm: Vec  # the box of the rotated shape, measured after rotating it


def determinant(rot: Rot) -> float:
    (a, b, c), (d, e, f), (g, h, i) = rot
    return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)


def is_proper(rot: Rot) -> bool:
    """Orthonormal with determinant +1, within PROPER_TOL."""
    orthonormal = all(abs(sum(rot[r][k] * rot[s][k] for k in range(3)) - (1.0 if r == s else 0.0)) <= PROPER_TOL
                      for r in range(3) for s in range(3))
    return orthonormal and abs(determinant(rot) - 1.0) <= PROPER_TOL


def _signed(rows: list[Vec]) -> Rot:
    """Rows of a rotation: the printer X row reversed when the rows as given would mirror."""
    if determinant((rows[0], rows[1], rows[2])) < 0:
        rows = [tuple(-v + 0.0 for v in rows[0]), rows[1], rows[2]]  # type: ignore[list-item]
    return (rows[0], rows[1], rows[2])


def permutation_rotation(orientation: str) -> Rot:
    """The proper rotation of a permutation name: printer axis i takes part axis orientation[i]."""
    if orientation not in ORIENTATIONS:
        raise ValueError(f"orientation must be one of {list(ORIENTATIONS)}, got {orientation!r}")
    return _signed([IDENTITY["xyz".index(axis)] for axis in orientation])


def _canonical(axis: Vec) -> Vec:
    """The axis with its largest-magnitude component positive (the first such component on a tie)."""
    lead = max(range(3), key=lambda i: (abs(axis[i]), -i))
    return axis if axis[lead] > 0 else tuple(-v + 0.0 for v in axis)  # type: ignore[return-value]


def fits(size: Vec, usable: Vec) -> bool:
    return all(size[i] <= usable[i] + FIT_SLACK_MM for i in range(3))


def _clearance(size: Vec, usable: Vec) -> float:
    return min(usable[i] - size[i] for i in (0, 1))


def turned_box(shape: Any, rotation: Rot) -> tuple[Vec, Vec]:
    """The exact axis-aligned box of `shape` rotated by `rotation` about the origin."""
    pose = load_pose()
    return occ.bbox(pose.placed(shape, pose.Rigid(rotation, (0.0, 0.0, 0.0))))


def _size(box: tuple[Vec, Vec]) -> Vec:
    low, high = box
    return tuple(high[i] - low[i] for i in range(3))  # type: ignore[return-value]


def fit(shape: Any, volume: BuildVolume) -> tuple[Vec, Fit | None, Vec | None]:
    """(model-frame box size, the chosen fit or None, the oriented box extents when they were tried).

    The allowed permutations come first: `xyz` when it fits, else the lowest print height, then the
    largest XY clearance, then the name. Only when none fits does the minimum-volume oriented box
    get a turn, with its axes assigned to the printer axes in every order under the same preference.
    Each candidate is rotated and measured again, and only a measured fit counts.
    """
    usable = volume.usable_mm
    model = _size(occ.bbox(shape))
    ranked = []
    for name in volume.orientations:
        size = tuple(model["xyz".index(axis)] for axis in name)
        if fits(size, usable):  # type: ignore[arg-type]
            ranked.append(((name != "xyz", size[2], -_clearance(size, usable), name), "axis_aligned", name,  # type: ignore[arg-type]
                           permutation_rotation(name)))
    for _, method, name, rotation in sorted(ranked):
        measured = _size(turned_box(shape, rotation))
        if fits(measured, usable):
            return model, Fit(method, name, rotation, measured), None
    extents, axes = occ.oriented_bbox(shape)
    axes = tuple(_canonical(axis) for axis in axes)
    ranked = []
    for order in itertools.permutations(range(3)):
        size = tuple(extents[i] for i in order)
        if fits(size, usable):  # type: ignore[arg-type]
            ranked.append(((size[2], -_clearance(size, usable), order), "oriented", "oriented",  # type: ignore[arg-type]
                           _signed([axes[i] for i in order])))
    for _, method, name, rotation in sorted(ranked):
        measured = _size(turned_box(shape, rotation))
        if fits(measured, usable):
            return model, Fit(method, name, rotation, measured), None
    return model, None, extents


def bed_placement(shape: Any, rotation: Rot, volume: BuildVolume | None) -> Any:
    """The placement that rotates `shape` and sets it on the bed: its lowest point at Z 0 and its box
    centred on the bed in X and Y, or with its box corner at the origin when no volume is declared.
    The margin reserves size; it never lifts the part off the bed."""
    pose = load_pose()
    low, high = turned_box(shape, rotation)
    if volume is None:
        shift = (-low[0], -low[1], -low[2])
    else:
        shift = (volume.size_mm[0] / 2 - (low[0] + high[0]) / 2, volume.size_mm[1] / 2 - (low[1] + high[1]) / 2, -low[2])
    return pose.Rigid(rotation, shift)
