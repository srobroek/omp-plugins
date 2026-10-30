"""Whether a part sheet states every recognised manufacturing feature: located and sized, never overall only.

``feature_recognition`` finds the features on the STEP without the drawing intent; this module checks
the drawing's measured characteristics against them, so a sheet whose intent dimensions only the
envelope, or hides a pocket inside a controlled-model surface, fails with one finding per feature
that names it, its faces and everything about it the sheet leaves out:

- every face of a recognised feature is bound to a drawing feature;
- a prismatic feature (planes normal to a frame axis, cylinders and cones on one) is dimensioned, not
  only defined by the model: none of those faces sits in a ``surface`` feature unless the recognised
  feature has a freeform face of its own;
- its size dimensions are stated directly, as their own dimension (ISO 129-1 §5: functional
  dimensions are indicated directly): a wall's, rib's or shell's thickness, a pocket's, cutout's,
  notch's, slot's or groove's width, length and depth, a hole's or shaft's diameter, a contour
  radius. A size callout, a separation between its two face sets, or a location measured from a
  datum plane that holds one of them states it; the difference of two baseline locations does not;
- heights (a boss's, a step's) and a hole's depth may also be located baseline: both their faces
  located in the one datum frame;
- a size between two planes that are not parallel (a drafted wall's thickness, a width between
  inclined flanks) is stated only by a characteristic measured at a reference plane (``at``) on one
  plane of each side; the angle of a drafted or flank face then needs its own dimension, and a
  spherical recess its SR and depth, where a controlled-model profile states neither;
- a hole, boss, shaft, slot or contour arc is located: its axis has a location, a pattern, or lies on
  a datum axis;
- a round or chamfer (an edge fillet or edge break) states its size in a callout or in the general
  note (feature ``presentation: general_note``).

Pure Python over the measured characteristics; ``rows`` go into coverage.json beside the
characteristic rows.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import feature_geometry as fg
from drawing_intent import Characteristic, DatumFrame, Measured, finding
from feature_geometry import Binding, Face
from feature_recognition import Recognition, Recognized, Size

TOLERANCE_MM = 1e-3
SEPARATIONS = ("width", "length", "depth", "thickness", "height")
SEPARATION_OPERATIONS = ("width", "length", "depth", "thickness", "plane_separation", "distance", "across_flats",
                         "extent", "height")
LOCATIONS = ("location", "floor_location")
POSITIONS = ("axis_location", "pattern", "slot_location", "location")
LOCATED = ("hole", "boss", "shaft", "slot", "arc")
NOT_DIMENSIONED = ("outline",)
MODEL_DEFINED = ("dish", "taper", "engraving", "outline")   # freeform or defined by its own kind's callout
SIZED_ONLY = ("round", "chamfer")   # an edge blend needs only its size stated, wherever its faces are bound


def baseline(item: Recognized, size: Size) -> bool:
    """Sizes that may be located baseline from one datum frame rather than dimensioned directly."""
    return size.name == "height" or (size.name == "depth" and item.category == "hole")


@dataclass(frozen=True)
class Coverage:
    rows: tuple[Mapping[str, Any], ...]
    findings: tuple[Mapping[str, Any], ...]


class _Checker:
    def __init__(self, recognition: Recognition, binding: Binding, measured: Measured, faces: Mapping[int, Face],
                 placed: Mapping[str, Any] | None) -> None:
        self.recognition = recognition
        self.binding = binding
        self.frame: DatumFrame | None = measured.frame
        self.located = measured.located
        self.faces = faces
        # only what the sheet shows states a size; before layout every measured characteristic counts
        self.chars = [c for c in measured.characteristics if not c.reference and (placed is None or c.id in placed)]

    def kinds(self, faces: Sequence[int]) -> dict[int, str | None]:
        return {i: (self.binding.features[self.binding.owner[i]].kind if i in self.binding.owner else None)
                for i in faces}

    def dimensionable(self, index: int) -> bool:
        """A face the sheet can dimension: a plane normal to a frame axis, a cylinder or cone on a frame axis."""
        face = self.faces[index]
        if self.frame is None:
            return face.support_type in ("plane", "cylinder", "cone")
        if face.support_type == "plane":
            return self.frame.axis_of(face.normal) is not None
        if face.support_type in ("cylinder", "cone"):
            return self.frame.axis_of(face.axis_dir) is not None
        return False

    def on(self, char: Characteristic, faces: Sequence[int]) -> bool:
        own = set(char.faces)
        for name in char.details.get("features", ()) or ():
            if name in self.binding.features:
                own.update(self.binding.features[name].faces)
        return bool(own & set(faces))

    # sizes ------------------------------------------------------------------------------------------
    def direct(self, size: Size) -> str | None:
        """The characteristic that states the size's value on its faces."""
        value = size.value
        faces = (*size.faces, *(size.between[0] if size.between else ()), *(size.between[1] if size.between else ()))
        for char in self.chars:
            v = abs(char.value)
            if size.name == "diameter":
                ok = (char.operation == "diameter" and abs(v - value) < TOLERANCE_MM) or \
                     (char.operation == "radius" and abs(v - value / 2) < TOLERANCE_MM)
            elif size.name == "radius":
                ok = (char.operation == "radius" and abs(v - value) < TOLERANCE_MM) or \
                     (char.operation == "diameter" and abs(v - 2 * value) < TOLERANCE_MM)
            elif size.name == "chamfer":
                ok = char.operation == "chamfer" and abs(v - value) < TOLERANCE_MM
            elif size.name == "angle":
                ok = char.operation == "angle" and min(abs(v - value), abs(v - (90 - value)), abs(v - (180 - value))) < 1e-3
            else:
                ok = char.operation in SEPARATION_OPERATIONS and abs(v - value) < TOLERANCE_MM
            if ok and self.on(char, faces):
                return char.id
        return None

    def from_datum(self, size: Size) -> str | None:
        """A location of one side measured from a datum plane that holds the other side."""
        if self.frame is None or not size.between:
            return None
        for char in self.chars:
            if char.operation not in LOCATIONS or char.axis is None or abs(abs(char.value) - size.value) > TOLERANCE_MM:
                continue
            for here, there in ((size.between[0], size.between[1]), (size.between[1], size.between[0])):
                if here and self.on(char, there) and self.on_origin(here[0], char.axis):
                    return char.id
        return None

    def on_origin(self, index: int, axis: str) -> bool:
        face = self.faces[index]
        return face.support_type == "plane" and abs(self.frame.coords(face.point)["xyz".index(axis)]) < TOLERANCE_MM

    def plane_located(self, index: int) -> bool:
        face = self.faces[index]
        if self.frame is None or face.support_type != "plane":
            return False
        axis = self.frame.axis_of(face.normal)
        if axis is None:
            return False
        coordinate = self.frame.coords(face.point)["xyz".index(axis[0])]
        return abs(coordinate) < TOLERANCE_MM or any(abs(coordinate - v) < TOLERANCE_MM for v in self.located[axis[0]])

    def at_plane(self, size: Size) -> str | None:
        """A size between non-parallel planes is stated only at a reference plane: a characteristic measured at
        a stated plane (``at``) on a pair of planes, one from each of the size's face sets."""
        first, second = (set(side) for side in size.between)
        for char in self.chars:
            if char.operation in SEPARATION_OPERATIONS and char.details.get("at") and any(
                    (a in first and b in second) or (a in second and b in first) for a, b in char.details["pairs"]):
                return char.id
        return None

    def stated(self, item: Recognized, size: Size) -> str | None:
        if size.at:
            return self.at_plane(size)
        by = self.direct(size) or (self.from_datum(size) if size.name in SEPARATIONS else None)
        if by is None and size.name in SEPARATIONS and baseline(item, size) and size.between \
                and all(any(self.plane_located(i) for i in side) for side in size.between):
            by = "baseline"
        if by is None and size.name == "depth" and size.between is None:
            # a curved or inclined entry: the floor's own location states the depth
            by = next((c.id for c in self.chars if c.operation in (*LOCATIONS, "depth") and self.on(c, size.faces)), None)
        if by is None and size.name == "angle" and not any(s.at for s in item.sizes) \
                and all(self.kinds(size.faces)[i] == "surface" for i in size.faces):
            # an inclined face that the controlled model defines within its profile tolerance; a drafted wall's
            # or an inclined flank's angle goes with its size at the reference plane, so it is stated too
            by = "profile"
        return by

    def positioned(self, item: Recognized) -> str | None:
        for char in self.chars:
            if (char.operation in POSITIONS or char.details.get("axis_dimension")) and self.on(char, item.faces):
                return char.id
        if self.frame is None:
            return None
        points = item.details.get("axes") or [self.faces[i].axis_point for i in item.faces
                                              if self.faces[i].axis_point is not None][:1]
        for axis_point in points:
            coords = self.frame.coords(axis_point)
            along = self.frame.axis_of(item.direction) if item.direction else None
            across = [k for k, name in enumerate("xyz") if along is None or name != along[0]]
            if all(abs(coords[k]) < TOLERANCE_MM for k in across):
                return "datum axis"
            if any(d.role == "axis" and d.direction is not None and fg.parallel(d.direction, item.direction or d.direction)
                   and fg.axis_distance(axis_point, d.point, d.direction) < TOLERANCE_MM for d in self.frame.datums.values()):
                return "datum axis"
        return None

    def slot_end(self, item: Recognized) -> str | None:
        """A round that is a slot's end radius: the slot's width states it."""
        owners = {self.binding.owner.get(i) for i in item.faces}
        kinds = {self.binding.features[o].kind for o in owners if o in self.binding.features}
        return next(iter(o for o in owners if o is not None), None) if kinds == {"slot"} else None

    # one feature ------------------------------------------------------------------------------------
    def check(self, item: Recognized) -> tuple[list[dict[str, Any]], list[str]]:
        """Its coverage rows and what the sheet leaves out of it, as short phrases."""
        rows, missing = [], []
        kinds = self.kinds(item.faces)
        unbound = sorted(i for i, k in kinds.items() if k is None)
        if unbound:
            missing.append(f"faces {unbound} bound to no drawing feature")
        hidden = sorted(i for i, k in kinds.items() if k == "surface" and self.dimensionable(i))
        if hidden and item.prismatic and item.category not in (*MODEL_DEFINED, *SIZED_ONLY):
            owners = sorted({self.binding.owner[i] for i in hidden})
            missing.append(f"faces {hidden} only defined by the controlled-model surface {', '.join(owners)}")
        for size in item.sizes:
            if size.name == "radius" and item.category not in ("round", "arc", "dish"):
                continue   # pocket corners and slot ends: their rounds and slots state them
            if not item.prismatic and size.name not in ("depth", "radius"):
                continue
            by = self.stated(item, size)
            if by is None and item.category == "round":
                by = self.slot_end(item)
            rows.append({"feature": item.id, "category": item.category, "requirement": size.name,
                         "value_mm": round(size.value, 6), "faces": list(size.faces),
                         "between": [list(s) for s in size.between] if size.between else None,
                         **({"at": list(size.at)} if size.at else {}),
                         "stated_by": by, "status": "pass" if by else "fail"})
            if by is None:
                sides = f" between faces {list(size.between[0])} and {list(size.between[1])}" if size.between else ""
                plane = f" at the plane of face {list(size.at)}" if size.at else ""
                missing.append(f"{'SR' if item.category == 'dish' and size.name == 'radius' else size.name} "
                               f"{size.value:g}{sides}{plane}")
        if item.category in LOCATED and item.prismatic:
            by = self.positioned(item)
            rows.append({"feature": item.id, "category": item.category, "requirement": "position", "value_mm": None,
                         "faces": list(item.faces), "between": None, "stated_by": by, "status": "pass" if by else "fail"})
            if by is None:
                missing.append("axis location")
        return rows, missing

    def run(self) -> Coverage:
        rows, findings = [], []
        for item in self.recognition.features:
            if item.category in NOT_DIMENSIONED:
                continue
            r, missing = self.check(item)
            rows.extend(r)
            if missing:
                findings.append(finding("dimension_coverage_incomplete", f"{describe(item)}: not dimensioned: "
                                        f"{'; '.join(missing)}", feature=item.id, missing=missing))
        return Coverage(tuple(rows), tuple(findings))


def describe(item: Recognized) -> str:
    return f"{item.describe()}, faces {list(item.faces)[:12]}{' …' if len(item.faces) > 12 else ''}"


def check(recognition: Recognition, binding: Binding, measured: Measured, faces: Mapping[int, Face],
          placed: Mapping[str, Any] | None = None) -> Coverage:
    return _Checker(recognition, binding, measured, faces, placed).run()


def undimensioned(recognition: Recognition, reason: str) -> list[dict[str, Any]]:
    """With no locators or no intent nothing is dimensioned: one finding per recognised feature, and the faces left."""
    found = [finding("dimension_coverage_incomplete", f"{describe(item)}: undimensioned, {reason}", feature=item.id)
             for item in recognition.features if item.category not in NOT_DIMENSIONED]
    if recognition.unrecognized:
        found.append(finding("dimension_coverage_incomplete", f"{len(recognition.unrecognized)} faces match no feature "
                             f"pattern: {[u['face'] for u in recognition.unrecognized][:20]}"))
    return found
