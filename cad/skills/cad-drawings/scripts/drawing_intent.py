"""Part drawing intent: the record's datums, features and requests, measured against the bound STEP.

``part.yaml`` ``drawing`` names datum features, a coordinate frame, views, per-feature intent,
extra dimension requests, geometrical tolerances and notes; it never carries a dimension value.
This module turns that intent plus the features ``feature_geometry.resolve`` bound into
``Characteristic`` rows: each required size, location, depth, chamfer, radius, angle, pattern,
profile or thread of a feature (drawing architecture §5.2), with the value measured from the STEP
faces and the tolerance that controls it:

- fits from ``interfaces.yaml`` feature endpoints, limits from cad-fits' ISO 286 tables (Decimal);
- heat-set seats from ``limits.heat_set`` (``hole_d``, ``hole_tol``, ``depth_min``) bound by ``feature``;
- explicit request tolerances, or the part's general tolerance policy (ISO 2768-1 or ``limits``);
- a location that a position tolerance controls is a theoretically exact (basic) dimension.

Findings carry the architecture's failure codes (§8.2). Pure Python: no FreeCAD.
"""

from __future__ import annotations

import importlib.util
import math
import re
import sys
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from decimal import Decimal
from functools import cache
from pathlib import Path
from typing import Any

import feature_geometry as fg
from feature_geometry import Face, ResolvedFeature, Vector

FITS = Path(__file__).resolve().parents[2] / "cad-fits" / "scripts" / "fits.py"
EPS = fg.GEOMETRY_EPS
FIT_KEYS = ("press_fit", "running_fit", "locating_fit")
VENDOR_TYPES = ("vendor_specification", "source_control")
DIMENSIONED_KINDS = ("plane_face", "bore", "shaft", "slot", "chamfer", "round", "groove", "socket", "taper",
                     "surface", "engraving")
# ISO 2768-1:1989 Table 1 (linear) and Table 2 (external radii and chamfer heights): range upper bounds in mm
# and permissible deviations (±mm) per class; below 0.5 mm the standard gives no general value.
ISO2768_LINEAR_BOUNDS = (3, 6, 30, 120, 400, 1000, 2000, 4000)
ISO2768_LINEAR = {"f": (0.05, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, None), "m": (0.1, 0.1, 0.2, 0.3, 0.5, 0.8, 1.2, 2.0),
                  "c": (0.2, 0.3, 0.5, 0.8, 1.2, 2.0, 3.0, 4.0), "v": (None, 0.5, 1.0, 1.5, 2.5, 4.0, 6.0, 8.0)}
ISO2768_RADIUS_BOUNDS = (3, 6, math.inf)
ISO2768_RADIUS = {"f": (0.2, 0.5, 1.0), "m": (0.2, 0.5, 1.0), "c": (0.4, 1.0, 2.0), "v": (0.4, 1.0, 2.0)}
# ISO 2768-1:1989 Table 3 (angular): shorter leg upper bounds in mm and deviations in degrees.
ISO2768_ANGLE_BOUNDS = (10, 50, 120, 400, math.inf)
ISO2768_ANGLE = {"f": (1.0, 0.5, 1 / 3, 1 / 6, 1 / 12), "m": (1.0, 0.5, 1 / 3, 1 / 6, 1 / 12),
                 "c": (1.5, 1.0, 0.5, 0.25, 1 / 6), "v": (3.0, 2.0, 1.0, 0.5, 1 / 3)}
SIZE_OPERATIONS = ("diameter", "radius", "width", "length", "chamfer", "across_flats", "depth", "thickness",
                   "plane_separation", "axis_distance", "distance", "extent")
LOCATION_OPERATIONS = ("location", "axis_location", "pattern", "slot_location")
# between two features' nearest parallel planes; a width is a callout that also counts its equal pairs
SEPARATION_REQUESTS = ("plane_separation", "thickness", "distance", "width")
THREAD = re.compile(r"^M(?P<d>[0-9]+(?:\.[0-9]+)?)x(?P<p>[0-9]+(?:\.[0-9]+)?)-(?P<cls>[0-9][a-hA-H](?:[0-9][a-hA-H])?)$")


@cache
def _fits() -> Any:
    """cad-fits' fits.py, the single ISO 286 implementation."""
    spec = importlib.util.spec_from_file_location("cad_fits_fits", FITS)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load cad-fits at {FITS}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def finding(code: str, message: str, **where: Any) -> dict[str, Any]:
    return {"code": code, "message": message, **where}


# --- tolerances ------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Tolerance:
    """What controls a characteristic: deviations from a nominal (mm), or a basic dimension."""

    kind: str                      # fit, heat_set, explicit, general, basic, vendor
    lower: Decimal = Decimal(0)
    upper: Decimal = Decimal(0)
    nominal: Decimal | None = None # interface nominal (fits, heat-set seats); None: the measured value is nominal
    designation: str | None = None # ISO 286 class, policy name or "basic"
    source: str = ""

    def limits(self, measured: float) -> tuple[Decimal, Decimal]:
        nominal = self.nominal if self.nominal is not None else Decimal(str(round(measured, 6)))
        return nominal + self.lower, nominal + self.upper

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "lower_mm": str(self.lower), "upper_mm": str(self.upper),
                "nominal_mm": None if self.nominal is None else str(self.nominal), "designation": self.designation,
                "source": self.source}


@dataclass(frozen=True)
class Policy:
    name: str
    kind: str                       # standard (ISO 2768-1) or limits
    applies_to: tuple[str, ...]
    iso_class: str | None = None
    linear_mm: float | None = None
    angular_deg: float | None = None
    reference: str = ""

    @property
    def label(self) -> str:
        if self.kind == "standard":
            return f"ISO 2768-{self.iso_class}"
        return f"±{self.linear_mm:g}" + (f", ±{self.angular_deg:g}°" if self.angular_deg else "")

    def linear(self, size: float) -> Decimal | None:
        if self.kind == "limits":
            return Decimal(str(self.linear_mm))
        if size < 0.5:
            return None
        return _iso2768(ISO2768_LINEAR_BOUNDS, ISO2768_LINEAR[self.iso_class], size)

    def radius(self, size: float) -> Decimal | None:
        if self.kind == "limits":
            return Decimal(str(self.linear_mm))
        if size < 0.5:
            return None
        return _iso2768(ISO2768_RADIUS_BOUNDS, ISO2768_RADIUS[self.iso_class], size)

    def angle(self, leg: float) -> Decimal | None:
        if self.kind == "limits":
            return None if self.angular_deg is None else Decimal(str(self.angular_deg))
        return _iso2768(ISO2768_ANGLE_BOUNDS, ISO2768_ANGLE[self.iso_class], leg)


def _iso2768(bounds: Sequence[float], values: Sequence[float | None], size: float) -> Decimal | None:
    for bound, value in zip(bounds, values):
        if size <= bound:
            return None if value is None else Decimal(str(round(value, 4)))
    return None


def policies(product: Mapping[str, Any]) -> dict[str, Policy]:
    found = {}
    for name, data in ((product.get("drawing") or {}).get("tolerance_policies") or {}).items():
        found[name] = Policy(name=name, kind=data["kind"], applies_to=tuple(data["applies_to"]),
                             iso_class=data.get("class"), linear_mm=data.get("linear_mm"),
                             angular_deg=data.get("angular_deg"), reference=data.get("reference", data.get("standard", "")))
    return found


# --- frame ------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Datum:
    label: str
    feature: str
    role: str
    point: Vector
    direction: Vector | None        # plane: outward normal; axis: axis direction


@dataclass(frozen=True)
class DatumFrame:
    origin: Vector
    x: Vector
    y: Vector
    z: Vector
    axisymmetric: bool
    datums: Mapping[str, Datum]

    def coords(self, point: Sequence[float]) -> Vector:
        offset = fg.sub(point, self.origin)
        return (fg.dot(offset, self.x), fg.dot(offset, self.y), fg.dot(offset, self.z))

    def axis_of(self, direction: Sequence[float]) -> tuple[str, int] | None:
        for name, axis in (("x", self.x), ("y", self.y), ("z", self.z)):
            cosine = fg.dot(fg.unit(direction), axis)
            if 1.0 - abs(cosine) < fg.DIRECTION_EPS:
                return name, 1 if cosine > 0 else -1
        return None

    def vector(self, name: str) -> Vector:
        return {"x": self.x, "y": self.y, "z": self.z}[name]

    def to_dict(self) -> dict[str, Any]:
        return {"origin": list(self.origin), "x": list(self.x), "y": list(self.y), "z": list(self.z),
                "axisymmetric": self.axisymmetric,
                "datums": {k: {"feature": d.feature, "role": d.role, "point": list(d.point),
                               "direction": None if d.direction is None else list(d.direction)}
                           for k, d in sorted(self.datums.items())}}


class IntentError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Instance:
    """One coaxial cylinder group of a bore, shaft or groove root: a single physical hole or diameter."""

    axis_point: Vector
    axis_dir: Vector
    radius: float
    faces: tuple[int, ...]
    t0: float
    t1: float
    ends: tuple[str, str] | None

    def point_at(self, t: float) -> Vector:
        return fg.add(self.axis_point, fg.scale(self.axis_dir, t))


def cylinder_instances(faces: Sequence[Face]) -> list[Instance]:
    """Group cylinder faces by axis line and radius; the axis direction keeps the first face's sense."""
    groups: list[list[Face]] = []
    for face in faces:
        if face.support_type != "cylinder":
            continue
        for group in groups:
            first = group[0]
            if (fg.parallel(face.axis_dir, first.axis_dir) and abs(face.radius - first.radius) < EPS
                    and fg.axis_distance(face.axis_point, first.axis_point, first.axis_dir) < EPS):
                group.append(face)
                break
        else:
            groups.append([face])
    instances = []
    for group in groups:
        base, direction = group[0].axis_point, fg.unit(group[0].axis_dir)
        spans = []
        for face in group:
            shift = fg.dot(fg.sub(face.axis_point, base), direction)
            sense = 1.0 if fg.dot(face.axis_dir, direction) > 0 else -1.0
            a, b = (shift + sense * face.axial[0], shift + sense * face.axial[1])
            ends = face.ends if sense > 0 or face.ends is None else (face.ends[1], face.ends[0])
            spans.append((min(a, b), max(a, b), ends))
        spans.sort()
        t0, t1 = spans[0][0], max(s[1] for s in spans)
        first_end = spans[0][2][0] if spans[0][2] else None
        last = max(spans, key=lambda s: s[1])
        last_end = last[2][1] if last[2] else None
        instances.append(Instance(base, direction, group[0].radius, tuple(f.index for f in group), t0, t1,
                                  (first_end, last_end) if first_end and last_end else None))
    return instances


GRID_MIN_INSTANCES = 4   # fewer holes are located one by one


def _grid_pattern(instances: Sequence[Instance], frame: DatumFrame, across: Sequence[str]) -> dict[str, Any] | None:
    """Instances that fill one regular grid inside a circle: stated once (ISO 129-1 equally spaced features).

    The grid is the shortest offset between centres and the shortest one not parallel to it, both measured from
    the instance nearest the centroid (the reference, the only instance located from the datums). It is a grid
    only when every centre is a grid node and every node within the farthest centre's distance is a centre, so
    the pitch, the angle and that circle state the whole set; otherwise each instance keeps its own location.
    """
    if len(instances) < GRID_MIN_INSTANCES:
        return None
    a, b = ("xyz".index(across[0]), "xyz".index(across[1]))
    points = [(frame.coords(i.axis_point)[a], frame.coords(i.axis_point)[b]) for i in instances]
    cu, cv = (sum(p[0] for p in points) / len(points), sum(p[1] for p in points) / len(points))
    reference = min(range(len(points)), key=lambda k: (round(math.hypot(points[k][0] - cu, points[k][1] - cv), 6), k))
    ru, rv = points[reference]
    offsets = [(u - ru, v - rv) for u, v in points]

    def angle(o: tuple[float, float]) -> float:
        return round(math.degrees(math.atan2(o[1], o[0])) % 180.0, 6)

    ordered = sorted((o for o in offsets if math.hypot(*o) > EPS), key=lambda o: (round(math.hypot(*o), 6), angle(o)))
    first = ordered[0]
    if first[1] < -EPS or (abs(first[1]) <= EPS and first[0] < 0):
        first = (-first[0], -first[1])
    pitch = math.hypot(*first)
    second = next((o for o in ordered if abs(first[0] * o[1] - first[1] * o[0]) > EPS * pitch), None)
    if second is None:
        return None
    if first[0] * second[1] - first[1] * second[0] < 0:
        second = (-second[0], -second[1])
    det = first[0] * second[1] - first[1] * second[0]
    for u, v in offsets:
        i, j = round((u * second[1] - v * second[0]) / det), round((first[0] * v - first[1] * u) / det)
        if math.hypot(i * first[0] + j * second[0] - u, i * first[1] + j * second[1] - v) > 10 * EPS:
            return None
    reach = max(math.hypot(*o) for o in offsets)
    span = int(reach / min(pitch, math.hypot(*second)) * 2) + 2
    nodes = sum(1 for i in range(-span, span + 1) for j in range(-span, span + 1)
                if math.hypot(i * first[0] + j * second[0], i * first[1] + j * second[1]) <= reach + EPS)
    if nodes != len(instances):
        return None
    turn = (math.degrees(math.atan2(second[1], second[0])) - math.degrees(math.atan2(first[1], first[0]))) % 360.0
    return {"grid": True, "pitch": pitch, "second_pitch": math.hypot(*second), "angle_deg": turn,
            "first_angle_deg": math.degrees(math.atan2(first[1], first[0])) % 360.0, "from_axis": across[0],
            "within_diameter": 2 * reach, "reference": reference, "centres": [inst.axis_point for inst in instances]}


def _datum(label: str, feature: ResolvedFeature, role: str, faces: Mapping[int, Face]) -> Datum:
    own = [faces[i] for i in feature.faces]
    if not own:
        raise IntentError("datum_invalid", f"datum {label} ({feature.id}) bound no geometry")
    if role == "plane":
        planes = [f for f in own if f.support_type == "plane"]
        if len(planes) != len(own) or any(not fg.parallel(p.normal, planes[0].normal) or
                                          abs(fg.dot(fg.sub(p.point, planes[0].point), planes[0].normal)) > EPS
                                          for p in planes):
            raise IntentError("datum_invalid", f"datum {label} ({feature.id}) is not one plane")
        return Datum(label, feature.id, role, planes[0].point, fg.unit(planes[0].normal))
    if role == "axis":
        instances = cylinder_instances(own)
        if len(instances) != 1:
            raise IntentError("datum_invalid", f"datum {label} ({feature.id}) has {len(instances)} cylinder axes, not one")
        return Datum(label, feature.id, role, instances[0].axis_point, instances[0].axis_dir)
    if role == "center_plane":
        planes = [f for f in own if f.support_type == "plane"]
        pairs = [(a, b) for i, a in enumerate(planes) for b in planes[i + 1:] if fg.dot(a.normal, b.normal) < -1 + 1e-6]
        if not pairs:
            raise IntentError("datum_invalid", f"datum {label} ({feature.id}) has no opposed plane pair")
        a, b = pairs[0]
        return Datum(label, feature.id, role, fg.scale(fg.add(a.point, b.point), 0.5), fg.unit(a.normal))
    centre = feature_centre(feature, faces)
    instances = cylinder_instances(own)
    direction = instances[0].axis_dir if len(instances) == 1 else None
    return Datum(label, feature.id, role, centre, direction)


def feature_centre(feature: ResolvedFeature, faces: Mapping[int, Face]) -> Vector:
    """An axis point for a single cylinder feature, else the centre of the feature's boundary points."""
    own = [faces[i] for i in feature.faces]
    instances = cylinder_instances(own)
    if len(instances) == 1 and len(own) == len(instances[0].faces):
        inst = instances[0]
        return inst.point_at((inst.t0 + inst.t1) / 2)
    points = [p for f in own for p in f.boundary_points()]
    lo = [min(p[k] for p in points) for k in range(3)]
    hi = [max(p[k] for p in points) for k in range(3)]
    return tuple((lo[k] + hi[k]) / 2 for k in range(3))


def resolve_frame(drawing: Mapping[str, Any], features: Mapping[str, ResolvedFeature],
                  faces: Mapping[int, Face]) -> DatumFrame:
    """The datum frame of ``drawing.coordinate_frame`` from bound datums; raise IntentError datum_invalid."""
    datums: dict[str, Datum] = {}
    for label, spec in sorted((drawing.get("datum_features") or {}).items()):
        feature = features.get(spec["feature"])
        if feature is None:
            raise IntentError("datum_invalid", f"datum {label} names feature {spec['feature']}, which is not bound")
        datums[label] = _datum(label, feature, spec["role"], faces)

    def ref(name: str) -> Datum:
        if name in datums:
            return datums[name]
        feature = features.get(name)
        if feature is None:
            raise IntentError("datum_invalid", f"coordinate frame reference {name} is neither a datum nor a bound feature")
        role = {"plane_face": "plane", "bore": "axis", "shaft": "axis"}.get(feature.kind, "point")
        return _datum(name, feature, role, faces)

    frame_spec = drawing.get("coordinate_frame")
    if not frame_spec:
        raise IntentError("datum_invalid", "drawing.coordinate_frame is missing")
    origin_spec = frame_spec["origin"]
    if "at" in origin_spec:
        origin = ref(origin_spec["at"]).point
    else:
        origin = _intersection([ref(name) for name in origin_spec["intersection"]])
    axes: dict[str, Vector] = {}
    # axes a plane or axis fixes come first, so an axis aimed toward a point is squared to them
    declared = [name for name in ("z", "x", "y") if frame_spec.get(name)]
    for name in sorted(declared, key=lambda n: not ({"normal_to", "parallel_to"} & set(frame_spec[n]))):
        spec = frame_spec[name]
        if "normal_to" in spec or "parallel_to" in spec:
            target = ref(spec.get("normal_to") or spec.get("parallel_to"))
            if target.direction is None:
                raise IntentError("datum_invalid", f"frame {name} needs a plane or axis, {target.label} has no direction")
            direction = target.direction
        else:
            toward = ref(spec.get("toward") or spec.get("toward_axis"))
            direction = fg.sub(toward.point, origin)
        for other in axes.values():  # Gram-Schmidt against axes already fixed
            direction = fg.sub(direction, fg.scale(other, fg.dot(direction, other)))
        if fg.norm(direction) < EPS:
            raise IntentError("datum_invalid", f"frame axis {name} is degenerate")
        direction = fg.unit(direction)
        sense = spec.get("toward") or spec.get("toward_axis")
        if sense and ("normal_to" in spec or "parallel_to" in spec):
            target = ref(sense)
            if fg.dot(fg.sub(target.point, origin), direction) < 0:
                direction = fg.scale(direction, -1.0)
        axes[name] = direction
    axisymmetric = len(axes) == 1
    if axisymmetric:
        only = next(iter(axes.values()))
        seed = (1.0, 0.0, 0.0) if abs(only[0]) < 0.9 else (0.0, 1.0, 0.0)
        other = fg.unit(fg.sub(seed, fg.scale(only, fg.dot(seed, only))))
        name = next(iter(axes))
        if name == "z":
            axes["x"] = other
        elif name == "x":
            axes["y"] = other
        else:
            axes["z"] = other
    if "z" not in axes:
        axes["z"] = fg.unit(fg.cross(axes["x"], axes["y"]))
    if "x" not in axes:
        axes["x"] = fg.unit(fg.cross(axes["y"], axes["z"]))
    if "y" not in axes:
        axes["y"] = fg.unit(fg.cross(axes["z"], axes["x"]))
    if abs(fg.dot(fg.cross(axes["x"], axes["y"]), axes["z"]) - 1.0) > 1e-6:
        raise IntentError("datum_invalid", "the coordinate frame axes are not a right-handed orthonormal set")
    return DatumFrame(origin, axes["x"], axes["y"], axes["z"], axisymmetric, datums)


def _intersection(refs: Sequence[Datum]) -> Vector:
    planes = [d for d in refs if d.role == "plane"]
    axes = [d for d in refs if d.role in ("axis",) and d.direction is not None]
    if len(planes) == 1 and len(axes) == 1:
        plane, axis = planes[0], axes[0]
        denominator = fg.dot(axis.direction, plane.direction)
        if abs(denominator) < 1e-9:
            raise IntentError("datum_invalid", f"axis {axis.label} is parallel to plane {plane.label}")
        t = fg.dot(fg.sub(plane.point, axis.point), plane.direction) / denominator
        return fg.add(axis.point, fg.scale(axis.direction, t))
    if len(planes) == 3:
        n = [p.direction for p in planes]
        d = [fg.dot(p.point, p.direction) for p in planes]
        det = fg.dot(n[0], fg.cross(n[1], n[2]))
        if abs(det) < 1e-9:
            raise IntentError("datum_invalid", "the three origin planes do not meet in one point")
        total = fg.add(fg.add(fg.scale(fg.cross(n[1], n[2]), d[0]), fg.scale(fg.cross(n[2], n[0]), d[1])),
                       fg.scale(fg.cross(n[0], n[1]), d[2]))
        return fg.scale(total, 1.0 / det)
    if len(axes) == 2:
        a, b = axes
        w = fg.sub(a.point, b.point)
        dd = fg.dot(a.direction, b.direction)
        denominator = 1 - dd * dd
        if denominator < 1e-9:
            raise IntentError("datum_invalid", f"axes {a.label} and {b.label} are parallel")
        s = (dd * fg.dot(w, b.direction) - fg.dot(w, a.direction)) / denominator
        t = (fg.dot(w, b.direction) - dd * fg.dot(w, a.direction)) / denominator
        pa, pb = fg.add(a.point, fg.scale(a.direction, s)), fg.add(b.point, fg.scale(b.direction, t))
        if fg.norm(fg.sub(pa, pb)) > EPS:
            raise IntentError("datum_invalid", f"axes {a.label} and {b.label} do not intersect")
        return pa
    raise IntentError("datum_invalid", f"cannot intersect {[d.label for d in refs]} into one origin point")


# --- characteristics ---------------------------------------------------------------------------------

@dataclass(frozen=True)
class Characteristic:
    """One required (or requested) characteristic of a feature with its measured value and control."""

    id: str
    feature: str
    operation: str
    value: float                              # mm, or degrees for angles; pattern: PCD
    faces: tuple[int, ...]
    quantity: int = 1
    axis: str | None = None                   # frame axis of a location
    tolerance: Tolerance | None = None
    presentation: str = "auto"
    reference: bool = False
    requested: bool = False                   # from drawing.dimensions rather than the feature type
    details: Mapping[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "feature": self.feature, "operation": self.operation, "value": self.value,
                "faces": list(self.faces), "quantity": self.quantity, "axis": self.axis,
                "tolerance": None if self.tolerance is None else self.tolerance.to_dict(),
                "presentation": self.presentation, "reference": self.reference, "requested": self.requested,
                "details": _plain(self.details)}


def _plain(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, Decimal):
        return str(value)
    return value


@dataclass
class Measured:
    """The measurement stage's result for one part."""

    frame: DatumFrame | None
    characteristics: list[Characteristic] = field(default_factory=list)
    findings: list[dict[str, Any]] = field(default_factory=list)
    located: dict[str, list[float]] = field(default_factory=lambda: {"x": [], "y": [], "z": []})
    geometric: list[Mapping[str, Any]] = field(default_factory=list)


class Measurer:
    """Measures every feature of one part in its datum frame and attaches the controlling tolerance."""

    def __init__(self, pn: str, part: Mapping[str, Any], product: Mapping[str, Any],
                 interfaces: Sequence[Mapping[str, Any]], binding: fg.Binding, faces: Sequence[Face]) -> None:
        self.pn = pn
        self.part = part
        self.drawing = part.get("drawing") or {}
        self.product = product
        self.interfaces = interfaces
        self.binding = binding
        self.faces = {f.index: f for f in faces}
        self.policies = policies(product)
        self.intents: Mapping[str, Mapping[str, Any]] = self.drawing.get("features") or {}
        # a vendor or source-control sheet controls only what the item's specification states
        self.vendor = self.drawing.get("type") in VENDOR_TYPES
        self.result = Measured(frame=None)
        self.positioned: set[str] = set()     # features a position tolerance locates (basic dimensions)
        self.coaxial: set[str] = set()
        for tolerance in self.drawing.get("geometric_tolerances", []):
            if tolerance["characteristic"] == "position":
                self.positioned.update(tolerance["features"])

    # policy -------------------------------------------------------------------------------------
    def policy(self, feature: str | None) -> Policy | None:
        intent = self.intents.get(feature or "", {})
        name = intent.get("tolerance_policy") or self.drawing.get("tolerance_policy") or \
            (self.product.get("drawing") or {}).get("general_tolerance_policy")
        if name is None:
            return None
        policy = self.policies.get(name)
        if policy is None or self.part["process"] not in policy.applies_to:
            self.add(finding("tolerance_policy_inapplicable",
                             f"policy {name} {'is undefined' if policy is None else 'does not apply to process ' + self.part['process']}",
                             feature=feature))
            return None
        return policy

    def general(self, feature: str, operation: str, value: float, leg: float | None = None) -> Tolerance | None:
        if self.vendor:
            return None
        policy = self.policy(feature)
        if policy is None:
            return None
        if operation in ("angle",):
            deviation = policy.angle(leg if leg is not None else value)
        elif operation in ("radius", "chamfer"):
            deviation = policy.radius(value)
        else:
            deviation = policy.linear(abs(value))
        if deviation is None:
            return None
        return Tolerance("general", -deviation, deviation, designation=policy.label, source=policy.name)

    def add(self, item: Mapping[str, Any]) -> None:
        self.result.findings.append(dict(item))

    def own(self, feature: ResolvedFeature) -> list[Face]:
        return [self.faces[i] for i in feature.faces]

    # characteristic helper ---------------------------------------------------------------------
    def char(self, feature: ResolvedFeature, operation: str, value: float, faces: Iterable[int], *,
             suffix: str = "", quantity: int = 1, axis: str | None = None, tolerance: Tolerance | None = None,
             details: Mapping[str, Any] | None = None, leg: float | None = None) -> Characteristic:
        intent = self.intents.get(feature.id, {})
        if tolerance is None and operation in LOCATION_OPERATIONS and feature.id in self.positioned:
            tolerance = Tolerance("basic", designation="basic", source="position tolerance")
        if tolerance is None and operation != "profile":
            tolerance = self.general(feature.id, operation, value, leg)
        item = Characteristic(id=f"{feature.id}.{operation}{('.' + suffix) if suffix else ''}", feature=feature.id,
                              operation=operation, value=value, faces=tuple(faces), quantity=quantity, axis=axis,
                              tolerance=tolerance, presentation=intent.get("presentation", "auto"),
                              details=details or {})
        self.result.characteristics.append(item)
        return item

    def locate(self, axis: str, value: float) -> None:
        self.result.located[axis].append(value)

    # top level -------------------------------------------------------------------------------------
    def run(self) -> Measured:
        features = self.binding.features
        try:
            frame = resolve_frame(self.drawing, features, self.faces)
        except IntentError as exc:
            self.add(finding(exc.code, str(exc)))
            return self.result
        self.result.frame = frame
        for label, datum in frame.datums.items():
            if datum.role == "plane":
                axis = frame.axis_of(datum.direction)
                if axis:
                    self.locate(axis[0], frame.coords(datum.point)["xyz".index(axis[0])])
        for feature_id in sorted(features):
            feature = features[feature_id]
            if self.vendor:
                self._vendor_thread(feature, frame)
                continue
            if feature_id not in self.intents:
                self.add(finding("dimension_coverage_incomplete", f"feature {feature_id} has no drawing intent in "
                                 f"part.yaml drawing.features", feature=feature_id))
                continue
            handler = getattr(self, f"_{feature.kind}", None)
            if self.intents[feature_id].get("presentation") == "general_note" and feature.kind not in ("round", "chamfer"):
                self.add(finding("invalid_drawing_intent", f"feature {feature_id}: only edge fillets and edge breaks "
                                 f"(round, chamfer) may go in the general note", feature=feature_id))
            if handler is None:
                self.add(finding("invalid_drawing_intent", f"feature {feature_id} kind {feature.kind!r} is not one of "
                                 f"{', '.join(DIMENSIONED_KINDS)}", feature=feature_id))
                continue
            try:
                handler(feature, frame)
            except IntentError as exc:
                self.add(finding(exc.code, f"{feature_id}: {exc}", feature=feature_id))
        for feature_id in sorted(set(self.intents) - set(features)):
            self.add(finding("feature_not_found", f"drawing.features names {feature_id}, which the model's "
                             f"drawing_features hook did not locate", feature=feature_id))
        self._requests(frame)
        self._geometric(frame)
        if not self.vendor:  # the vendor envelope is illustrative: its ends need no location
            self._closure(frame)
        return self.result

    def _vendor_thread(self, feature: ResolvedFeature, frame: DatumFrame) -> None:
        """On a vendor sheet only a declared thread and the dimension requests are characteristics."""
        thread = self.intents.get(feature.id, {}).get("thread")
        if not thread:
            return
        cylinders = [f for f in self.own(feature) if f.support_type == "cylinder"]
        instances = cylinder_instances(cylinders)
        if len(instances) != 1:
            self.add(finding("thread_spec_incomplete", f"{feature.id}: a thread needs one cylinder axis",
                             feature=feature.id))
            return
        self._thread(feature, frame, instances[0], thread, inward=bool(cylinders[0].inward))

    # feature kinds ---------------------------------------------------------------------------------
    def _plane_face(self, feature: ResolvedFeature, frame: DatumFrame) -> None:
        planes = self.own(feature)
        if any(f.support_type != "plane" for f in planes):
            raise IntentError("invalid_drawing_intent", "a plane_face feature binds non-planar faces")
        first = planes[0]
        if any(not fg.parallel(f.normal, first.normal) or abs(fg.dot(fg.sub(f.point, first.point), first.normal)) > EPS
               for f in planes):
            raise IntentError("measurement_mismatch", "its faces are not coplanar")
        axis = frame.axis_of(first.normal)
        if axis is None:
            raise IntentError("dimension_coverage_incomplete", "the plane is not normal to a frame axis; "
                              "request an angle and location or make it a controlled-model surface")
        value = frame.coords(first.point)["xyz".index(axis[0])]
        self.locate(axis[0], value)
        if abs(value) < EPS:
            return
        self.char(feature, "location", value, feature.faces, axis=axis[0], details={"normal": first.normal})

    @staticmethod
    def _on_datum_axis(feature_id: str, inst: Instance, frame: DatumFrame) -> bool:
        """A feature on another datum feature's axis shares its centre line; that datum's location covers it."""
        return any(d.role == "axis" and d.feature != feature_id and fg.parallel(d.direction, inst.axis_dir)
                   and fg.axis_distance(inst.axis_point, d.point, d.direction) < EPS for d in frame.datums.values())

    def _axis_location(self, feature: ResolvedFeature, frame: DatumFrame, instances: Sequence[Instance]) -> None:
        axes = [frame.axis_of(inst.axis_dir) for inst in instances]
        if any(a is None for a in axes):
            raise IntentError("dimension_coverage_incomplete", "its axis is not parallel to a frame axis")
        if len(instances) == 1 and self._on_datum_axis(feature.id, instances[0], frame):
            return
        along = axes[0][0]
        across = [a for a in "xyz" if a != along]
        if len(instances) > 1:
            pattern = self._circular_pattern(instances, frame)
            if pattern is not None:
                self.char(feature, "pattern", pattern["pcd"], feature.faces, quantity=len(instances),
                          axis=along, details=pattern)
                return
            grid = _grid_pattern(instances, frame, across)
            if grid is not None:   # stated once by its pitch and boundary; only its reference instance is located
                self.char(feature, "pattern", grid["pitch"], feature.faces, quantity=len(instances), axis=along,
                          details=grid)
                instances = [instances[grid["reference"]]]
        for number, inst in enumerate(instances):
            coords = frame.coords(inst.axis_point)
            for name in across:
                value = coords["xyz".index(name)]
                if abs(value) < EPS:
                    continue
                if frame.axisymmetric:
                    raise IntentError("datum_invalid", "an off-axis feature needs a clocking datum for an x or y frame axis")
                self.char(feature, "axis_location", value, inst.faces, axis=name,
                          suffix=f"{number}.{name}" if len(instances) > 1 else name,
                          details={"axis_point": inst.axis_point, "axis_dir": inst.axis_dir, "instance": number})

    def _circular_pattern(self, instances: Sequence[Instance], frame: DatumFrame) -> dict[str, Any] | None:
        for datum in frame.datums.values():
            if datum.role != "axis" or not fg.parallel(datum.direction, instances[0].axis_dir):
                continue
            radii = [fg.axis_distance(inst.axis_point, datum.point, datum.direction) for inst in instances]
            if max(radii) - min(radii) > EPS or radii[0] < EPS:
                continue
            u = frame.x if fg.perpendicular(frame.x, datum.direction) else frame.y
            v = fg.unit(fg.cross(datum.direction, u))
            angles = sorted(math.degrees(math.atan2(fg.dot(fg.sub(inst.axis_point, datum.point), v),
                                                    fg.dot(fg.sub(inst.axis_point, datum.point), u))) % 360.0
                            for inst in instances)
            steps = [(angles[(i + 1) % len(angles)] - angles[i]) % 360.0 for i in range(len(angles))]
            equal = max(steps) - min(steps) < 1e-4
            from_axis = "x" if u == frame.x else "y"
            spec = (self.drawing.get("coordinate_frame") or {}).get(from_axis) or {}
            reference = spec.get("toward") or spec.get("toward_axis") or spec.get("normal_to") or spec.get("parallel_to")
            return {"about": datum.label, "pcd": 2 * radii[0], "angles_deg": angles, "equal_spacing": equal,
                    "from_axis": from_axis, "reference": reference,
                    "centres": [inst.axis_point for inst in instances]}
        return None

    def _cylinders(self, feature: ResolvedFeature, inward: bool) -> list[Instance]:
        cylinders = [f for f in self.own(feature) if f.support_type == "cylinder"]
        if not cylinders:
            raise IntentError("invalid_drawing_intent", "binds no cylinder")
        if any(bool(f.inward) != inward for f in cylinders):
            raise IntentError("invalid_drawing_intent", f"a {feature.kind} binds a cylinder whose material is "
                              f"{'inside' if inward else 'outside'} it")
        return cylinder_instances(cylinders)

    def _size_tolerance(self, feature: ResolvedFeature, side: str, diameter: float) -> Tolerance | None:
        intent = self.intents.get(feature.id, {})
        bound = self._fit_tolerance(feature, side, diameter)
        if intent.get("size") == "interface":
            if bound is None:
                self.add(finding("fit_binding_missing", f"{feature.id} is an interface size but no fit or heat-set "
                                 f"declaration in interfaces.yaml binds {self.pn}:{feature.id}", feature=feature.id))
            return bound
        return bound

    def _fit_tolerance(self, feature: ResolvedFeature, side: str, measured: float) -> Tolerance | None:
        found: list[Tolerance] = []
        for interface in self.interfaces:
            limits = interface.get("limits") or {}
            for key in FIT_KEYS:
                fit = limits.get(key)
                endpoint = (fit or {}).get(side)
                if not isinstance(endpoint, Mapping) or endpoint.get("PN") != self.pn or endpoint.get("feature") != feature.id:
                    continue
                nominal_text, _, classes = fit["fit"].partition(" ")
                hole_class, _, shaft_class = classes.partition("/")
                if not shaft_class:  # a single class names the shaft when it is a shaft class
                    hole_class, shaft_class = (classes, "") if classes[:1] == "H" else ("", classes)
                cls = hole_class if side == "hole" else shaft_class
                if not cls:
                    continue
                nominal = Decimal(nominal_text)
                limits_ = _fits().tolerance_class(nominal, cls)
                micron = Decimal("0.001")
                found.append(Tolerance("fit", limits_.lower * micron, limits_.upper * micron, nominal=nominal,
                                       designation=cls, source=f"{interface['id']} {key} {fit['fit']}"))
            if side == "hole":
                for heat in limits.get("heat_set") or []:
                    if heat["pair"][0] == self.pn and heat.get("feature") == feature.id:
                        low, high = heat.get("hole_tol", (0.0, 0.0))
                        found.append(Tolerance("heat_set", Decimal(str(low)), Decimal(str(high)),
                                               nominal=Decimal(str(heat["hole_d"])), designation=None,
                                               source=f"{interface['id']} heat_set {heat['insert']}"))
            ring = limits.get("retaining_ring")
            if side == "shaft" and isinstance(ring, Mapping) and ring.get("pair", [None])[0] == self.pn \
                    and ring.get("feature") == feature.id:
                nominal_text, _, cls = str(ring["groove_d"]).partition(" ")
                limits_ = _fits().tolerance_class(Decimal(nominal_text), cls)
                micron = Decimal("0.001")
                found.append(Tolerance("fit", limits_.lower * micron, limits_.upper * micron,
                                       nominal=Decimal(nominal_text), designation=cls,
                                       source=f"{interface['id']} retaining_ring {ring['ring']}"))
        if not found:
            return None
        if len({(t.nominal, t.lower, t.upper) for t in found}) > 1:
            self.add(finding("dimension_conflict", f"{feature.id} has conflicting size controls: "
                             f"{[t.source for t in found]}", feature=feature.id))
        tolerance = found[0]
        low, high = tolerance.limits(measured)
        if not (low - Decimal("1e-6") <= Decimal(str(measured)) <= high + Decimal("1e-6")):
            self.add(finding("fit_geometry_mismatch", f"{feature.id} measures {measured:.4f} mm, outside its "
                             f"{tolerance.source} limits {low}/{high}", feature=feature.id))
        self._post_process_check(feature, tolerance)
        return tolerance

    def _post_process_check(self, feature: ResolvedFeature, tolerance: Tolerance) -> None:
        if self.part["process"] != "fdm":
            return
        policy = self.policy(feature.id)
        manufacturing = self.drawing.get("manufacturing") or {}
        if policy is None or policy.kind != "limits":
            return
        if (tolerance.upper - tolerance.lower) < Decimal(str(2 * policy.linear_mm)) and \
                manufacturing.get("interface_condition", "as_printed") == "as_printed":
            self.add(finding("fit_geometry_mismatch", f"{feature.id}: {tolerance.source} is tighter than the "
                             f"{policy.name} process ({policy.label}) and drawing.manufacturing leaves the interface "
                             f"as printed", feature=feature.id))

    def _bore(self, feature: ResolvedFeature, frame: DatumFrame) -> None:
        self._round_feature(feature, frame, inward=True)

    def _shaft(self, feature: ResolvedFeature, frame: DatumFrame) -> None:
        self._round_feature(feature, frame, inward=False)

    def _round_feature(self, feature: ResolvedFeature, frame: DatumFrame, inward: bool) -> None:
        instances = self._cylinders(feature, inward)
        radii = {round(inst.radius, 6) for inst in instances}
        if len(radii) > 1:
            raise IntentError("measurement_mismatch", f"instances have different diameters {sorted(2 * r for r in radii)}")
        diameter = 2 * instances[0].radius
        partial = all((self.faces[i].span_deg or 360.0) < 359.0 for inst in instances for i in inst.faces)
        tolerance = self._size_tolerance(feature, "hole" if inward else "shaft", diameter)
        operation = "radius" if partial else "diameter"
        value = instances[0].radius if partial else diameter
        self.char(feature, operation, value, feature.faces, quantity=len(instances), tolerance=tolerance,
                  details={"instances": len(instances), "regions": sorted(set(feature.regions.values())),
                           "axis_dir": instances[0].axis_dir, "inward": inward,
                           "ends": [inst.ends for inst in instances]})
        self._axis_location(feature, frame, instances)
        axis = frame.axis_of(instances[0].axis_dir)
        floors = [f for f in self.own(feature) if f.support_type == "plane" and fg.parallel(f.normal, instances[0].axis_dir)]
        cones = [f for f in self.own(feature) if f.support_type == "cone"]
        if inward and (floors or cones):
            depth = max(inst.t1 - inst.t0 for inst in instances)
            heat = self._heat_depth(feature)
            tolerance = None
            if heat is not None:
                if depth + 1e-6 < heat:
                    self.add(finding("fit_geometry_mismatch", f"{feature.id} is {depth:.3f} mm deep, less than the "
                                     f"heat-set minimum {heat} mm", feature=feature.id))
                # the insert's minimum depth is the lower limit; the process policy gives the upper deviation
                general = self.general(feature.id, "depth", depth)
                tolerance = Tolerance("heat_set", min(Decimal(0), Decimal(str(heat)) - Decimal(str(round(depth, 6)))),
                                      general.upper if general else Decimal(0), source=f"heat_set depth_min {heat}")
            self.char(feature, "depth", depth, [f.index for f in floors] + list(instances[0].faces),
                      quantity=len(instances), tolerance=tolerance, details={"floor": True})
            if axis is not None:
                for inst in instances:
                    for t in (inst.t0, inst.t1):
                        self.locate(axis[0], frame.coords(inst.point_at(t))["xyz".index(axis[0])])
        thread = self.intents.get(feature.id, {}).get("thread")
        if thread:
            self._thread(feature, frame, instances[0], thread, inward)

    def _heat_depth(self, feature: ResolvedFeature) -> float | None:
        for interface in self.interfaces:
            for heat in (interface.get("limits") or {}).get("heat_set") or []:
                if heat["pair"][0] == self.pn and heat.get("feature") == feature.id and "depth_min" in heat:
                    return float(heat["depth_min"])
        return None

    def _thread(self, feature: ResolvedFeature, frame: DatumFrame, inst: Instance, thread: Mapping[str, Any],
                inward: bool) -> None:
        match = THREAD.match(thread["designation"])
        if match is None:
            self.add(finding("thread_spec_incomplete", f"{feature.id}: thread {thread['designation']!r} names no "
                             f"metric size, pitch and tolerance class", feature=feature.id))
            return
        major, pitch = float(match["d"]), float(match["p"])
        minor = major - 1.082532 * pitch     # ISO 724 basic minor diameter D1 = D - 1.082532 P
        expected = minor if inward else major
        if abs(2 * inst.radius - expected) > 0.15 * pitch:
            self.add(finding("thread_spec_incomplete", f"{feature.id}: the modelled ⌀{2 * inst.radius:.3f} is not the "
                             f"{'minor' if inward else 'major'} diameter {expected:.3f} of {thread['designation']}",
                             feature=feature.id))
        depth = None
        anchor_name = thread.get("full_depth_anchor")
        blind = inst.ends is not None and "floor" in inst.ends
        if anchor_name:
            anchor = feature.anchors.get(anchor_name)
            if anchor is None:
                self.add(finding("thread_spec_incomplete", f"{feature.id}: anchor {anchor_name} is not in the locator",
                                 feature=feature.id))
            else:
                t = fg.dot(fg.sub(anchor["point_mm"], inst.axis_point), inst.axis_dir)
                entry = inst.t1 if inst.ends and inst.ends[0] == "floor" else inst.t0
                depth = abs(t - entry)
        elif blind:
            self.add(finding("thread_spec_incomplete", f"{feature.id}: a blind thread needs full_depth_anchor for its "
                             f"full-thread depth", feature=feature.id))
        self.char(feature, "thread", major, feature.faces, details={
            "designation": thread["designation"], "standard": thread["standard"], "operation": thread["operation"],
            "pitch": pitch, "minor": minor, "full_depth": depth},
            tolerance=Tolerance("explicit", designation=match["cls"], source=thread["standard"]))

    def _slot(self, feature: ResolvedFeature, frame: DatumFrame) -> None:
        own = self.own(feature)
        components = _connected([f for f in own], self.faces)
        widths, lengths, details = [], [], []
        floors_all: list[Face] = []
        for faces in components:
            cylinders = [f for f in faces if f.support_type == "cylinder"]
            if not cylinders:
                raise IntentError("invalid_drawing_intent", "a slot instance needs at least one end radius")
            depth_dir = fg.unit(cylinders[0].axis_dir)
            walls = [f for f in faces if f.support_type == "plane" and fg.perpendicular(f.normal, depth_dir)]
            floors = [f for f in faces if f.support_type == "plane" and fg.parallel(f.normal, depth_dir)]
            floors_all += floors
            pairs = [(a, b) for i, a in enumerate(walls) for b in walls[i + 1:] if fg.dot(a.normal, b.normal) < -1 + 1e-6]
            if not pairs:
                raise IntentError("invalid_drawing_intent", "a slot instance needs two opposed walls")
            a, b = pairs[0]
            width = abs(fg.dot(fg.sub(b.point, a.point), a.normal))
            ends = cylinder_instances(cylinders)
            if any(abs(2 * e.radius - width) > EPS for e in ends):
                raise IntentError("measurement_mismatch", f"end radius does not equal half the {width:.3f} mm width")
            along = fg.unit(fg.cross(depth_dir, a.normal))
            if len(ends) == 2:
                centre = fg.scale(fg.add(ends[0].axis_point, ends[1].axis_point), 0.5)
                length = fg.norm(fg.sub(ends[0].axis_point, ends[1].axis_point)) + width
                along = fg.unit(fg.sub(ends[1].axis_point, ends[0].axis_point))
            else:
                centre, length = ends[0].axis_point, None
            widths.append(width)
            lengths.append(length)
            u = frame.x if fg.perpendicular(frame.x, depth_dir) else frame.z
            v = fg.cross(depth_dir, u)
            angle = math.degrees(math.atan2(fg.dot(along, v), fg.dot(along, u))) % 180.0
            details.append({"centre": centre, "along": along, "depth_dir": depth_dir, "angle_deg": angle,
                            "faces": [f.index for f in faces], "open": len(ends) == 1,
                            "end_axes": [e.axis_point for e in ends]})
        if max(widths) - min(widths) > EPS:
            raise IntentError("measurement_mismatch", f"slot instances differ in width {widths}")
        n = len(components)
        self.char(feature, "width", widths[0], feature.faces, quantity=n, details={"instances": details})
        if all(length is not None for length in lengths):
            if max(lengths) - min(lengths) > EPS:
                raise IntentError("measurement_mismatch", f"slot instances differ in length {lengths}")
            self.char(feature, "length", lengths[0], feature.faces, quantity=n, details={"instances": details})
        # location: the slot centre (closed slots) or its end-radius axis (open slots)
        fake = [Instance(d["centre"], d["depth_dir"], widths[0] / 2, tuple(d["faces"]), 0.0, 0.0, None) for d in details]
        self._axis_location(feature, frame, fake)
        if n > 1 or not frame.axisymmetric:
            angles = [d["angle_deg"] for d in details]
            radial = all(_radial(d, frame) for d in details)
            if not radial and any(abs(a % 90.0) > 1e-4 and abs(a % 90.0 - 90.0) > 1e-4 for a in angles):
                self.char(feature, "angle", angles[0], feature.faces, quantity=n, details={"instances": details},
                          leg=lengths[0] or widths[0])
        if floors_all:
            axis = frame.axis_of(floors_all[0].normal)
            if axis is None:
                raise IntentError("dimension_coverage_incomplete", "the slot floor is not normal to a frame axis")
            value = frame.coords(floors_all[0].point)["xyz".index(axis[0])]
            self.locate(axis[0], value)
            entry = self._entry_plane(feature, floors_all[0])
            if entry is not None:  # a counterbore-like recess: depth from the face it opens through
                depth = abs(fg.dot(fg.sub(floors_all[0].point, entry.point), floors_all[0].normal))
                self.char(feature, "depth", depth, [f.index for f in floors_all], quantity=n,
                          details={"entry_face": entry.index})
            else:  # an opening surface that is not one plane: the floor elevation from the datum frame
                self.char(feature, "floor_location", value, [f.index for f in floors_all], axis=axis[0], quantity=n)

    def _entry_plane(self, feature: ResolvedFeature, floor: Face) -> Face | None:
        """The plane, parallel to the floor and outside the feature, that the recess's walls open through."""
        own = set(feature.faces)
        found = None
        for index in feature.faces:
            for neighbour in self.faces[index].neighbours():
                face = self.faces[neighbour]
                if neighbour in own or face.support_type != "plane" or not fg.parallel(face.normal, floor.normal):
                    continue
                if found is not None and abs(fg.dot(fg.sub(face.point, found.point), floor.normal)) > EPS:
                    return None
                found = face
        return found

    def _groove(self, feature: ResolvedFeature, frame: DatumFrame) -> None:
        own = self.own(feature)
        roots = cylinder_instances([f for f in own if f.support_type == "cylinder"])
        walls = [f for f in own if f.support_type == "plane"]
        if len(roots) != 1 or len(walls) != 2:
            raise IntentError("invalid_drawing_intent", "a groove is one root cylinder and two side walls")
        root = roots[0]
        axis = frame.axis_of(root.axis_dir)
        if axis is None:
            raise IntentError("dimension_coverage_incomplete", "the groove axis is not a frame axis")
        index = "xyz".index(axis[0])
        positions = sorted(frame.coords(w.point)[index] for w in walls)
        tolerance = self._size_tolerance(feature, "shaft", 2 * root.radius)
        self.char(feature, "diameter", 2 * root.radius, root.faces, tolerance=tolerance,
                  details={"axis_dir": root.axis_dir, "inward": False, "groove_root": True})
        nearest = min(positions, key=abs)
        self.char(feature, "location", nearest, [w.index for w in walls if abs(frame.coords(w.point)[index] - nearest) < EPS],
                  axis=axis[0], details={"normal": root.axis_dir})
        self.char(feature, "width", positions[1] - positions[0], [w.index for w in walls], axis=axis[0])
        for value in positions:
            self.locate(axis[0], value)

    def _chamfer(self, feature: ResolvedFeature, frame: DatumFrame) -> None:
        sizes: dict[tuple[float, float], list[int]] = {}
        for face in self.own(feature):
            if face.support_type == "cone":
                ts = [fg.dot(fg.sub(p, face.axis_point), fg.unit(face.axis_dir)) for p in face.boundary_points()]
                rs = [fg.axis_distance(p, face.axis_point, face.axis_dir) for p in face.boundary_points()]
                axial, radial = max(ts) - min(ts), max(rs) - min(rs)
            elif face.support_type == "plane":
                axial, radial = self._bevel_legs(face)
            else:
                raise IntentError("invalid_drawing_intent", f"a chamfer binds a {face.support_type} face")
            key = (round(axial, 4), round(math.degrees(math.atan2(radial, axial)), 3))
            sizes.setdefault(key, []).append(face.index)
        for number, ((axial, angle), indices) in enumerate(sorted(sizes.items())):
            self.char(feature, "chamfer", axial, indices, quantity=len(indices),
                      suffix=str(number) if len(sizes) > 1 else "", details={"angle_deg": angle})

    def _bevel_legs(self, face: Face) -> tuple[float, float]:
        """A plane chamfer's legs: its extent along the normals of the two faces it joins along its long edges."""
        lengths: dict[int, float] = {}
        for edge in face.edges:
            other = self.faces.get(edge.neighbour) if edge.neighbour is not None else None
            if other is not None and other.support_type == "plane" and not fg.parallel(other.normal, face.normal):
                lengths[other.index] = lengths.get(other.index, 0.0) + fg.norm(fg.sub(edge.points[-1], edge.points[0]))
        joined = sorted(lengths, key=lambda i: (-lengths[i], i))[:2]
        if len(joined) < 2 or fg.parallel(self.faces[joined[0]].normal, self.faces[joined[1]].normal):
            raise IntentError("invalid_drawing_intent", f"plane chamfer face {face.index} does not join two faces")
        points = list(face.boundary_points())
        legs = []
        for index in sorted(joined):
            values = [fg.dot(p, fg.unit(self.faces[index].normal)) for p in points]
            legs.append(max(values) - min(values))
        return legs[0], legs[1]

    def _round(self, feature: ResolvedFeature, frame: DatumFrame) -> None:
        sizes: dict[float, list[int]] = {}
        for face in self.own(feature):
            if face.support_type not in ("torus", "cylinder", "sphere"):
                raise IntentError("measurement_failed", f"round face {face.index} is a {face.support_type}; its radius "
                                  f"cannot be measured, so put it in a controlled-model surface feature")
            sizes.setdefault(round(face.radius, 4), []).append(face.index)
        for number, (radius, indices) in enumerate(sorted(sizes.items())):
            self.char(feature, "radius", radius, indices, quantity=len(indices),
                      suffix=str(number) if len(sizes) > 1 else "")

    def _taper(self, feature: ResolvedFeature, frame: DatumFrame) -> None:
        cones = [f for f in self.own(feature) if f.support_type == "cone"]
        if len(cones) != len(feature.faces):
            raise IntentError("invalid_drawing_intent", "a taper binds only cone faces")
        angles = {round(f.semi_angle_deg, 4) for f in cones}
        for number, angle in enumerate(sorted(angles)):
            indices = [f.index for f in cones if round(f.semi_angle_deg, 4) == angle]
            leg = min(fg.norm(fg.sub(f.bbox[3:], f.bbox[:3])) for f in cones)
            self.char(feature, "angle", 90.0 - angle, indices, quantity=len(indices), leg=leg,
                      suffix=str(number) if len(angles) > 1 else "", details={"to": "axis_normal"})

    def _socket(self, feature: ResolvedFeature, frame: DatumFrame) -> None:
        own = self.own(feature)
        planes = [f for f in own if f.support_type == "plane"]
        floors = [f for f in planes if len(planes) > 3 and all(
            fg.perpendicular(f.normal, g.normal) for g in planes if g is not f)]
        flats = [f for f in planes if f not in floors]
        if len(floors) != 1 or len(flats) < 3 or len(planes) != len(own):
            raise IntentError("invalid_drawing_intent", "a socket is three or more flats and one floor")
        floor = floors[0]
        pairs = [(a, b) for i, a in enumerate(flats) for b in flats[i + 1:] if fg.dot(a.normal, b.normal) < -1 + 1e-6]
        if not pairs:
            raise IntentError("invalid_drawing_intent", "the socket has no opposed flats")
        across = {round(abs(fg.dot(fg.sub(b.point, a.point), a.normal)), 6) for a, b in pairs}
        if max(across) - min(across) > EPS:
            raise IntentError("measurement_mismatch", f"the socket flats are not regular: {sorted(across)}")
        self.char(feature, "across_flats", min(across), [f.index for f in flats], details={"sides": len(flats)})
        entry = feature.relations.get("entry")
        if entry:
            entry_feature = self.binding.features.get(entry[0])
            if entry_feature is None:
                raise IntentError("feature_not_found", f"entry relation names {entry[0]}, which is not bound")
            entry_face = self.faces[entry_feature.faces[0]]
            depth = abs(fg.dot(fg.sub(floor.point, entry_face.point), floor.normal))
            self.char(feature, "depth", depth, [floor.index], details={"entry": entry[0]})
        else:
            axis = frame.axis_of(floor.normal)
            if axis is None:
                raise IntentError("dimension_coverage_incomplete", "the socket floor is not normal to a frame axis")
            self.char(feature, "floor_location", frame.coords(floor.point)["xyz".index(axis[0])], [floor.index],
                      axis=axis[0])

    def _surface(self, feature: ResolvedFeature, frame: DatumFrame) -> None:
        intent = self.intents[feature.id]
        zone = intent.get("profile_tolerance_mm")
        covered = [t for t in self.drawing.get("geometric_tolerances", [])
                   if t["characteristic"] == "profile_surface" and feature.id in t["features"]]
        if intent.get("profile") != "controlled_model":
            self.add(finding("dimension_coverage_incomplete", f"surface {feature.id} needs profile: controlled_model",
                             feature=feature.id))
        if zone is None and not covered:
            self.add(finding("tolerance_missing", f"controlled-model surface {feature.id} has no profile tolerance",
                             feature=feature.id))
            return
        frame_labels = (covered[0].get("datum_frame") if covered else None) or sorted(frame.datums)[:3]
        value = covered[0]["zone_mm"] if covered else zone
        self.char(feature, "profile", float(value), feature.faces,
                  tolerance=Tolerance("explicit", Decimal(str(-value)) / 2, Decimal(str(value)) / 2,
                                      designation="profile", source="drawing intent"),
                  details={"datum_frame": list(frame_labels)})

    def _engraving(self, feature: ResolvedFeature, frame: DatumFrame) -> None:
        on = feature.relations.get("on")
        if not on or on[0] not in self.binding.features:
            raise IntentError("invalid_drawing_intent", "an engraving needs an `on` relation to its surface feature")
        surface = self.faces[self.binding.features[on[0]].faces[0]]
        if surface.support_type != "plane":
            raise IntentError("invalid_drawing_intent", "an engraving surface must be a plane")
        own = self.own(feature)
        floors = [f for f in own if f.support_type == "plane" and fg.parallel(f.normal, surface.normal)]
        depth = max(abs(fg.dot(fg.sub(f.point, surface.point), surface.normal)) for f in floors)
        axis = frame.axis_of(surface.normal)
        if axis is None:
            raise IntentError("dimension_coverage_incomplete", "the engraving surface is not normal to a frame axis")
        across = [a for a in "xyz" if a != axis[0]]
        points = [frame.coords(p) for f in own for p in f.boundary_points()]
        lo = {a: min(p["xyz".index(a)] for p in points) for a in across}
        hi = {a: max(p["xyz".index(a)] for p in points) for a in across}
        text = [n for n in self.drawing.get("notes", []) if n.get("reference") == feature.id]
        if not text:
            self.add(finding("dimension_coverage_incomplete", f"engraving {feature.id} has no note giving its text and "
                             f"font (a note with reference: {feature.id})", feature=feature.id))
        tol = self.general(feature.id, "depth", depth)
        self.char(feature, "depth", depth, [f.index for f in floors], tolerance=tol)
        centre = {a: (lo[a] + hi[a]) / 2 for a in across}
        self.char(feature, "extent", hi[across[0]] - lo[across[0]], feature.faces,
                  details={"axes": across, "size": [hi[a] - lo[a] for a in across], "centre": centre,
                           "plane_axis": axis[0]})
        for a in across:
            if abs(centre[a]) > EPS:
                self.char(feature, "location", centre[a], feature.faces, axis=a, suffix=a,
                          details={"engraving_centre": True})

    # requests, geometric tolerances, closure ---------------------------------------------------------
    def _requests(self, frame: DatumFrame) -> None:
        for request in self.drawing.get("dimensions", []):
            features = [self.binding.features.get(f) for f in request["features"]]
            at = request.get("at")
            if any(f is None for f in features) or (at is not None and at not in self.binding.features):
                self.add(finding("feature_not_found", f"dimension {request['id']} names an unbound feature "
                                 f"{[*request['features'], *([at] if at else [])]}", dimension=request["id"]))
                continue
            measured_at: dict[str, Any] = {}
            try:
                if at is not None:
                    value, faces, axis, measured_at = self._measure_at(request, features, frame)
                else:
                    value, faces, axis = self._measure_request(request, features, frame)
            except IntentError as exc:
                self.add(finding(exc.code, f"dimension {request['id']}: {exc}", dimension=request["id"]))
                continue
            tolerance = None
            spec = request.get("tolerance")
            if spec and "deviation_mm" in spec:
                low, high = spec["deviation_mm"]
                if self.vendor:  # the limits the item's specification publishes
                    document = (self.part.get("procurement") or {}).get("specification") or {}
                    tolerance = Tolerance("vendor", Decimal(str(low)), Decimal(str(high)),
                                          designation=document.get("reference"),
                                          source=f"{document.get('reference')} rev {document.get('revision')}")
                else:
                    tolerance = Tolerance("explicit", Decimal(str(low)), Decimal(str(high)),
                                          source=f"dimension {request['id']}")
            elif spec and "policy" in spec:
                policy = self.policies.get(spec["policy"])
                deviation = policy.linear(abs(value)) if policy else None
                if deviation is not None:
                    tolerance = Tolerance("general", -deviation, deviation, designation=policy.label, source=policy.name)
            operation = request["operation"]
            # a request on a characteristic the feature type already requires replaces that row's control
            same = [c for c in self.result.characteristics
                    if c.feature == request["features"][0] and len(request["features"]) == 1
                    and c.operation == operation and abs(c.value - value) < EPS]
            for existing in same:
                self.result.characteristics.remove(existing)
            if tolerance is None and not request.get("reference"):
                tolerance = same[0].tolerance if same else self.general(request["features"][0], operation, value)
            details = {**(same[0].details if same else {}), "features": request["features"],
                       "datum_frame": request.get("datum_frame", []), **measured_at}
            if operation in ("radius", "diameter") and self._spherical(features[0]):
                details["spherical"] = True   # SR, S⌀ (ISO 129-1, ASME Y14.5)
            chain = operation in SEPARATION_REQUESTS and len(features) == 2 and at is None
            if chain:   # drawn from the first feature's plane nearest the second
                details["from_faces"] = self._separation_planes(features[0], features[1])[0]
            quantity = same[0].quantity if same else 1
            if at is not None:   # every pair of planes at that width on the plane: 2× width 2.3
                quantity = len(measured_at["pairs"])
            elif operation == "width" and len(features) == 2:
                # a width callout states every opposed pair of the two features at that width: 4× width 0.6
                pairs = self._pairs_at(features[0], features[1], value)
                quantity, faces = len(pairs), sorted({b for _, b in pairs})
            item = Characteristic(id=request["id"], feature=request["features"][0], operation=operation, value=value,
                                  faces=tuple(faces), quantity=quantity, axis=axis,
                                  tolerance=tolerance, presentation=request.get("presentation", "auto"),
                                  reference=bool(request.get("reference")), requested=True, details=details)
            if chain and operation != "width" and not item.reference and features[1].kind == "plane_face":
                # a chain dimension locates the second plane from the first, in place of its datum location
                self.result.characteristics = [c for c in self.result.characteristics if not (
                    c.feature == features[1].id and c.operation == "location" and not c.requested)]
            self.result.characteristics.append(item)

    def _spherical(self, feature: ResolvedFeature) -> bool:
        radii = [self.faces[i] for i in feature.faces if self.faces[i].radius]
        return bool(radii) and all(f.support_type == "sphere" for f in radii)

    def _sphere_depth(self, features: Sequence[ResolvedFeature]) -> tuple[float, list[int], None]:
        """A spherical recess's depth: from the plane it opens through to the sphere's lowest point."""
        dish = next((f for f in features if any(self.faces[i].support_type == "sphere" and self.faces[i].inward
                                                for i in f.faces)), None)
        if dish is None:
            raise IntentError("measurement_failed", "depth between two features needs an inward sphere (a spherical "
                              "recess) and the plane it opens through")
        plane = self._plane_of(next(f for f in features if f is not dish))
        sphere = next(self.faces[i] for i in dish.faces if self.faces[i].support_type == "sphere")
        n = fg.unit(plane.normal)
        depth = fg.dot(fg.sub(plane.point, sphere.axis_point), n) + sphere.radius
        return depth, [i for i in dish.faces if self.faces[i].support_type == "sphere"], None

    def _measure_at(self, request: Mapping[str, Any], features: Sequence[ResolvedFeature], frame: DatumFrame
                    ) -> tuple[float, list[int], str | None, dict[str, Any]]:
        """A width or thickness stated at a reference plane (ISO 129-1): the distance between the lines where two
        planes meet the ``at`` plane, for a drafted wall or two inclined flanks. The planes are one feature's two,
        or one of each of two features: the pair nearest the plane, then the narrowest; every pair at that width
        side by side along the lines counts, so ``pairs`` lists them."""
        operation = request["operation"]
        if operation not in SEPARATION_REQUESTS:
            raise IntentError("invalid_drawing_intent", f"at applies to {', '.join(SEPARATION_REQUESTS)}, "
                              f"not {operation}")
        if len(features) not in (1, 2):
            raise IntentError("invalid_drawing_intent", "at measures between one feature's planes or two features'")
        ref = self._plane_of(self.binding.features[request["at"]])
        planes = [[self.faces[i] for i in f.faces if self.faces[i].support_type == "plane"] for f in features]
        candidates = ([(a, b) for k, a in enumerate(planes[0]) for b in planes[0][k + 1:]] if len(features) == 1
                      else [(a, b) for a in planes[0] for b in planes[1]])
        found = []
        for a, b in candidates:
            trace = fg.trace_at(a, b, ref)
            if trace is not None and fg.side_by_side(a, b, trace.along):
                found.append((round(fg.reach(a, ref) + fg.reach(b, ref), 3), trace, a.index, b.index))
        if not found:
            raise IntentError("measurement_failed", f"no two planes of {[f.id for f in features]} meet "
                              f"{request['at']} in parallel lines side by side")
        reach, trace, _, _ = min(found, key=lambda item: (item[0], item[1].width))
        pairs = [[a, b] for near, other, a, b in found if near == reach and abs(other.width - trace.width) < EPS]
        axis = frame.axis_of(trace.across)
        return trace.width, sorted({b for _, b in pairs}), axis[0] if axis else None, {
            "at": request["at"], "pairs": pairs,
            "trace": {"first": list(trace.first), "second": list(trace.second), "along": list(trace.along),
                      "across": list(trace.across)}}

    def _measure_request(self, request: Mapping[str, Any], features: Sequence[ResolvedFeature],
                         frame: DatumFrame) -> tuple[float, list[int], str | None]:
        operation = request["operation"]
        faces = [i for f in features for i in f.faces]
        if operation in SEPARATION_REQUESTS and len(features) == 2:
            start, target, value, normal = self._separation_planes(features[0], features[1])
            axis = frame.axis_of(normal)
            if axis:
                coords = [frame.coords(self.faces[side[0]].point)["xyz".index(axis[0])] for side in (start, target)]
                located = self.result.located[axis[0]]
                if any(abs(c - l) < EPS for c in coords for l in located):
                    for c in coords:
                        self.locate(axis[0], c)
            # measured from the first feature: the characteristic's faces are the second plane's, its target
            return value, target, axis[0] if axis else None
        if operation == "depth" and len(features) == 2:
            return self._sphere_depth(features)
        if operation == "axis_distance" and len(features) == 2:
            a, b = (cylinder_instances([self.faces[i] for i in f.faces])[0] for f in features)
            if not fg.parallel(a.axis_dir, b.axis_dir):
                raise IntentError("measurement_failed", "the axes are not parallel")
            return fg.axis_distance(b.axis_point, a.axis_point, a.axis_dir), faces, None
        if operation == "length" and len(features) == 1:
            instances = cylinder_instances([self.faces[i] for i in features[0].faces])
            cones = [self.faces[i] for i in features[0].faces if self.faces[i].support_type == "cone"]
            if instances:
                inst = instances[0]
                axis = frame.axis_of(inst.axis_dir)
                if axis:
                    ends = [frame.coords(inst.point_at(t))["xyz".index(axis[0])] for t in (inst.t0, inst.t1)]
                    located = self.result.located[axis[0]]
                    if any(abs(e - l) < EPS for e in ends for l in located):
                        for e in ends:
                            self.locate(axis[0], e)
                return inst.t1 - inst.t0, faces, axis[0] if axis else None
            if cones:
                ts = [fg.dot(fg.sub(p, cones[0].axis_point), fg.unit(cones[0].axis_dir)) for p in cones[0].boundary_points()]
                return max(ts) - min(ts), faces, None
            raise IntentError("measurement_failed", "length needs a cylinder or cone feature")
        if operation == "thickness" and len(features) == 1:
            radii = sorted({round(self.faces[i].radius, 6) for i in features[0].faces if self.faces[i].radius})
            if len(radii) == 2:
                return radii[1] - radii[0], faces, None
            raise IntentError("measurement_failed", "thickness of one feature needs two concentric radii")
        if operation == "axis_location" and len(features) == 1:
            instances = cylinder_instances([self.faces[i] for i in features[0].faces])
            if len(instances) != 1:
                raise IntentError("measurement_failed", "axis_location needs one axis")
            coords = frame.coords(instances[0].axis_point)
            along = frame.axis_of(instances[0].axis_dir)
            across = [a for a in "xyz" if not along or a != along[0]]
            values = [(a, coords["xyz".index(a)]) for a in across if abs(coords["xyz".index(a)]) > EPS]
            if len(values) != 1:
                raise IntentError("measurement_failed", f"axis_location needs exactly one non-zero coordinate, got {values}")
            return values[0][1], faces, values[0][0]
        if operation in ("diameter", "radius") and len(features) == 1:
            instances = cylinder_instances([self.faces[i] for i in features[0].faces])
            if instances:
                return (2 if operation == "diameter" else 1) * instances[0].radius, faces, None
            radii = {round(self.faces[i].radius, 6) for i in features[0].faces if self.faces[i].radius}
            if len(radii) == 1:
                return (2 if operation == "diameter" else 1) * radii.pop(), faces, None
        if operation == "angle" and len(features) == 1:
            cones = [self.faces[i] for i in features[0].faces if self.faces[i].support_type == "cone"]
            if cones:
                return 90.0 - cones[0].semi_angle_deg, faces, None
        if operation == "angle" and len(features) == 2:
            a, b = (self._plane_of(f) for f in features)
            return math.degrees(math.acos(max(-1.0, min(1.0, abs(fg.dot(a.normal, b.normal)))))), faces, None
        existing = [c for c in self.result.characteristics if c.feature == features[0].id and c.operation == operation]
        if len(features) == 1 and existing:
            return existing[0].value, list(existing[0].faces), existing[0].axis
        raise IntentError("invalid_drawing_intent", f"operation {operation} on {len(features)} features is not measurable")

    def _plane_of(self, feature: ResolvedFeature) -> Face:
        planes = [self.faces[i] for i in feature.faces if self.faces[i].support_type == "plane"]
        if not planes:
            raise IntentError("measurement_failed", f"{feature.id} has no plane face")
        return planes[0]

    def _separation_planes(self, first: ResolvedFeature, second: ResolvedFeature
                           ) -> tuple[list[int], list[int], float, Vector]:
        """The nearest pair of parallel planes of two features: their coplanar faces, the gap and the normal.

        A feature with several parallel planes, such as a slot's two walls, is measured at the wall that
        faces the other feature, never at whichever plane happens to come first."""
        planes = [[self.faces[i] for i in f.faces if self.faces[i].support_type == "plane"] for f in (first, second)]
        if not planes[0] or not planes[1]:
            raise IntentError("measurement_failed", f"{(first if not planes[0] else second).id} has no plane face")
        pairs = [(abs(fg.dot(fg.sub(b.point, a.point), a.normal)), a, b) for a in planes[0] for b in planes[1]
                 if fg.parallel(a.normal, b.normal)]
        if not pairs:
            raise IntentError("measurement_failed", "the two planes are not parallel")
        value, a, b = min(pairs, key=lambda p: (p[0] < EPS, p[0]))

        def coplanar(face: Face, own: Sequence[Face]) -> list[int]:
            return [f.index for f in own if fg.parallel(f.normal, face.normal)
                    and abs(fg.dot(fg.sub(f.point, face.point), face.normal)) < EPS]

        return coplanar(a, planes[0]), coplanar(b, planes[1]), value, a.normal

    def _pairs_at(self, first: ResolvedFeature, second: ResolvedFeature, value: float) -> list[tuple[int, int]]:
        """The opposed parallel plane pairs of two features ``value`` apart: each rib or web a width states."""
        planes = [[self.faces[i] for i in f.faces if self.faces[i].support_type == "plane"] for f in (first, second)]
        return [(a.index, b.index) for a in planes[0] for b in planes[1]
                if fg.dot(a.normal, b.normal) < -1 + fg.DIRECTION_EPS
                and abs(abs(fg.dot(fg.sub(b.point, a.point), a.normal)) - value) < EPS]

    def _geometric(self, frame: DatumFrame) -> None:
        for tolerance in self.drawing.get("geometric_tolerances", []):
            missing = [f for f in tolerance["features"] if f not in self.binding.features]
            if missing:
                self.add(finding("feature_not_found", f"geometric tolerance {tolerance['id']} names unbound {missing}"))
                continue
            labels = tolerance.get("datum_frame", [])
            if any(label not in frame.datums for label in labels):
                self.add(finding("datum_invalid", f"geometric tolerance {tolerance['id']} uses undeclared datums {labels}"))
                continue
            if tolerance["characteristic"] in ("position", "coaxiality", "perpendicularity", "parallelism",
                                               "circular_runout", "total_runout") and not labels:
                self.add(finding("datum_invalid", f"{tolerance['characteristic']} tolerance {tolerance['id']} needs "
                                 f"a datum reference frame"))
                continue
            self.result.geometric.append(dict(tolerance))

    def _closure(self, frame: DatumFrame) -> None:
        """Every axial end of a cylinder or taper lies on a located plane or meets a chamfer, round or surface."""
        located = self.result.located
        owner = self.binding.owner
        exempt_kinds = {"chamfer", "round", "surface", "taper", "socket", "slot", "engraving"}
        for feature in self.binding.features.values():
            if feature.kind not in ("bore", "shaft", "groove", "taper") or feature.id not in self.intents:
                continue
            for index in feature.faces:
                face = self.faces[index]
                if face.support_type not in ("cylinder", "cone") or face.axial is None:
                    continue
                axis = frame.axis_of(face.axis_dir)
                if axis is None:
                    continue
                k = "xyz".index(axis[0])
                direction = fg.unit(face.axis_dir)
                for t in face.axial:
                    end_edges = [e for e in face.edges if e.points and all(
                        abs(fg.dot(fg.sub(p, face.axis_point), direction) - t) < 1e-3 for p in e.points)]
                    neighbours = {e.neighbour for e in end_edges if e.neighbour is not None}
                    kinds = {self.binding.features[owner[n]].kind for n in neighbours if n in owner}
                    same = {owner.get(n) for n in neighbours} == {feature.id}
                    coordinate = frame.coords(fg.add(face.axis_point, fg.scale(direction, t)))[k]
                    if any(abs(coordinate - value) < EPS for value in located[axis[0]]):
                        continue
                    if kinds & exempt_kinds or (same and neighbours) or not end_edges:
                        continue
                    self.add(finding("dimension_coverage_incomplete",
                                     f"{feature.id}: the end of face {index} at {axis[0]} = {coordinate:.3f} is located by "
                                     f"no dimension; locate the plane it meets or request its length",
                                     feature=feature.id))


def _radial(detail: Mapping[str, Any], frame: DatumFrame) -> bool:
    """A slot that points at a datum axis is located by its pattern; its angle is the pattern angle."""
    for datum in frame.datums.values():
        if datum.role == "axis" and datum.direction is not None:
            to_axis = fg.sub(detail["centre"], datum.point)
            to_axis = fg.sub(to_axis, fg.scale(datum.direction, fg.dot(to_axis, datum.direction)))
            if fg.norm(to_axis) > EPS and fg.parallel(to_axis, detail["along"]):
                return True
    return False


def _connected(faces: Sequence[Face], index: Mapping[int, Face]) -> list[list[Face]]:
    """Connected components of a feature's faces through shared edges."""
    own = {f.index: f for f in faces}
    seen: set[int] = set()
    components = []
    for face in faces:
        if face.index in seen:
            continue
        stack, component = [face.index], []
        while stack:
            current = stack.pop()
            if current in seen:
                continue
            seen.add(current)
            component.append(own[current])
            stack.extend(n for n in own[current].neighbours() if n in own and n not in seen)
        components.append(sorted(component, key=lambda f: f.index))
    return components


def measure(pn: str, part: Mapping[str, Any], product: Mapping[str, Any], interfaces: Sequence[Mapping[str, Any]],
            binding: fg.Binding, faces: Sequence[Face]) -> Measured:
    return Measurer(pn, part, product, interfaces, binding, faces).run()
