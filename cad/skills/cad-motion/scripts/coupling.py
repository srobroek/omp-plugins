"""Coupled joint coordinates: typed laws, periodic profiles, slider-crank mechanisms and their DAG.

Kernel-free and standard-library only: cad-record's validate.py and cad-motion's pose.py read the
record through `parse`, and pose.py's `Chain.complete` derives every dependent coordinate through
`Couplings.derive`.

Record (hw/assembly.yaml). An independent movable joint authors `nominal`; a dependent one authors
`coupling` instead, and no `nominal`. Every movable joint keeps `min` and `max`; the limits apply to
derived coordinates too. Coordinates are unwrapped: a 720 degree crank is never reduced to 0..360.

    joints:
      - {id: J-031, type: revolute, ..., coupling: {type: linear, driver: J-011, ratio: 0.5, offset: 0}}
        q = ratio * q_driver + offset; ratio in dependent units per driver unit, offset in the
        dependent joint's unit; a negative ratio is an external gear.
      - {id: J-041, type: prismatic, ...,
         coupling: {type: periodic_table, driver: J-031, profile: intake_lift, phase_deg: -120}}
        q = profile((q_driver + phase_deg) mod period_deg), piecewise linear; the driver is revolute.
      - {id: J-021, type: prismatic, ..., coupling: {type: slider_crank, mechanism: cylinder-1, output: displacement}}
      - {id: J-022, type: revolute, ..., coupling: {type: slider_crank, mechanism: cylinder-1, output: rod_angle}}
    profiles:
      intake_lift: {input_unit: deg, output_unit: mm, period_deg: 360, interpolation: linear,
                    samples: [[0, 0], [65, 3], [130, 0], [360, 0]]}
        Abscissae strictly increase from 0 to period_deg; the first and last values match.
    mechanisms:
      - {id: cylinder-1, type: slider_crank, driver: J-011, origin_mm: [x, y, z], crank_axis: a,
         bank_axis: n, crank_radius_mm: r, rod_length_mm: L, phase_deg: phi}

Slider-crank, with a and n unit and perpendicular, t = a x n and theta = q_driver + phi:
    h = sqrt(L^2 - r^2 sin^2 theta)
    s = r cos theta + h - (L + r)        piston displacement from TDC along n (mm, <= 0)
    beta = atan2(-r sin theta, h)        rod rotation about +a (deg)
    crankpin = O + r cos theta n + r sin theta t,   wrist = O + (L + r + s) n
The record's transform tree realises it: the driver turns the crank about +a through O; the
displacement joint is prismatic along +n; the rod joint is revolute about +a through the TDC wrist
O + (L + r) n, a child of the piston. `parse` checks those axes and origins against the mechanism.
"""

from __future__ import annotations

import bisect
import graphlib
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

Vec = tuple[float, float, float]

JOINT_UNITS = {"revolute": "deg", "prismatic": "mm"}  # the coordinate unit of each movable joint type
LIMIT_EPS = 1e-9  # a derived coordinate this far (deg or mm) past a limit is rounding, not an excursion
AXIS_TOL = 1e-9  # |cos| tolerance for parallel and perpendicular unit axes
POINT_TOL_MM = 1e-6  # how far a joint axis line may pass from the point a mechanism places it through
RANGE_STEP = 0.5  # driver spacing (deg or mm) of the record-level limit check
RANGE_SAMPLES = 4001  # most driver values the record-level limit check evaluates per independent joint
OUTPUTS = {"displacement": "prismatic", "rod_angle": "revolute"}  # slider-crank output -> joint type


class CouplingError(ValueError):
    """The record's couplings cannot be evaluated; `problems` lists every reason."""

    def __init__(self, problems: Sequence[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = list(problems)


@dataclass(frozen=True)
class Profile:
    """A periodic, piecewise-linear table: output at (input mod period)."""

    name: str
    output_unit: str
    period: float
    knots: tuple[tuple[float, float], ...]
    xs: tuple[float, ...] = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "xs", tuple(k[0] for k in self.knots))

    def __call__(self, x: float) -> float:
        x = math.fmod(x, self.period)
        if x < 0.0:
            x += self.period
        if x >= self.period:  # x within rounding below 0 lands on period, the same seam value
            x -= self.period
        i = min(bisect.bisect_right(self.xs, x) - 1, len(self.xs) - 2)
        (x0, y0), (x1, y1) = self.knots[i], self.knots[i + 1]
        return y0 + (y1 - y0) * (x - x0) / (x1 - x0)


@dataclass(frozen=True)
class SliderCrank:
    """A centred slider-crank: one driver, the crank about `crank_axis` through `origin`, the piston
    along `bank_axis`."""

    id: str
    driver: str
    origin: Vec
    crank_axis: Vec  # a, unit
    bank_axis: Vec  # n, unit, perpendicular to a
    radius: float  # r, mm
    length: float  # L, mm, > r
    phase: float  # phi, deg

    @property
    def side(self) -> Vec:
        """t = a x n: the crankpin direction a quarter turn after TDC."""
        return _cross(self.crank_axis, self.bank_axis)

    def theta(self, q: float) -> float:
        return math.radians(q + self.phase)

    def _h(self, theta: float) -> float:
        return math.sqrt(self.length ** 2 - (self.radius * math.sin(theta)) ** 2)

    def displacement(self, q: float) -> float:
        theta = self.theta(q)
        return self.radius * math.cos(theta) + self._h(theta) - (self.length + self.radius)

    def rod_angle(self, q: float) -> float:
        theta = self.theta(q)
        return math.degrees(math.atan2(-self.radius * math.sin(theta), self._h(theta)))

    def crankpin(self, q: float) -> Vec:
        theta = self.theta(q)
        c, s = self.radius * math.cos(theta), self.radius * math.sin(theta)
        return _add(self.origin, _add(_scale(self.bank_axis, c), _scale(self.side, s)))

    def wrist(self, q: float) -> Vec:
        return _add(self.origin, _scale(self.bank_axis, self.length + self.radius + self.displacement(q)))

    @property
    def tdc_wrist(self) -> Vec:
        """The wrist at zero displacement: where the rod joint's axis passes."""
        return _add(self.origin, _scale(self.bank_axis, self.length + self.radius))


@dataclass(frozen=True)
class Linear:
    driver: str
    ratio: float
    offset: float

    @property
    def kind(self) -> str:
        return f"linear ratio {self.ratio:g} offset {self.offset:g}"

    def __call__(self, q: float) -> float:
        return self.ratio * q + self.offset


@dataclass(frozen=True)
class PeriodicTable:
    driver: str
    profile: Profile
    phase: float

    @property
    def kind(self) -> str:
        return f"periodic_table {self.profile.name} phase {self.phase:g} deg"

    def __call__(self, q: float) -> float:
        return self.profile(q + self.phase)


@dataclass(frozen=True)
class MechanismOutput:
    mechanism: SliderCrank
    output: str  # displacement | rod_angle

    @property
    def driver(self) -> str:
        return self.mechanism.driver

    @property
    def kind(self) -> str:
        return f"slider_crank {self.mechanism.id} {self.output}"

    def __call__(self, q: float) -> float:
        return getattr(self.mechanism, self.output)(q)


Law = Linear | PeriodicTable | MechanismOutput


@dataclass(frozen=True)
class Couplings:
    """The dependent joints of one record, each with its law, in an order that derives every driver
    before the joints it drives."""

    laws: Mapping[str, Law] = field(default_factory=dict)
    order: tuple[str, ...] = ()
    mechanisms: Mapping[str, SliderCrank] = field(default_factory=dict)

    @property
    def dependents(self) -> frozenset[str]:
        return frozenset(self.laws)

    def root(self, joint_id: str) -> str:
        """The independent joint whose coordinate `joint_id` follows (itself when it is independent)."""
        while joint_id in self.laws:
            joint_id = self.laws[joint_id].driver
        return joint_id

    def describe(self, joint_id: str) -> str:
        law = self.laws[joint_id]
        return f"{joint_id} follows {law.driver} ({law.kind})"

    def derive(self, independent: Mapping[str, float]) -> dict[str, float]:
        """`independent` plus every dependent coordinate, derived in DAG order."""
        values = dict(independent)
        for joint_id in self.order:
            law = self.laws[joint_id]
            value = law(values[law.driver])
            if not math.isfinite(value):
                raise CouplingError([f"{self.describe(joint_id)} gives a non-finite value at "
                                     f"{law.driver} = {values[law.driver]!r}"])
            values[joint_id] = value
        return values

    def range_problems(self, limits: Mapping[str, tuple[float, float]], nominal: Mapping[str, float],
                       units: Mapping[str, str]) -> list[str]:
        """Dependents that leave their [min, max] while an independent joint they follow moves through its
        own [min, max] (the others at `nominal`): sampled at RANGE_STEP spacing, at most RANGE_SAMPLES
        values, plus the nominal. One problem per dependent, at its first excursion."""
        problems: list[str] = []
        roots: dict[str, list[str]] = {}
        for joint_id in self.order:
            roots.setdefault(self.root(joint_id), []).append(joint_id)
        for root, dependents in roots.items():
            low, high = limits[root]
            count = min(RANGE_SAMPLES, max(2, math.ceil((high - low) / RANGE_STEP) + 1))
            samples = sorted({*(low + (high - low) * k / (count - 1) for k in range(count)), nominal[root]})
            reported: set[str] = set()
            for value in samples:
                values = self.derive({**nominal, root: value})
                for joint_id in dependents:
                    q, (lo, hi) = values[joint_id], limits[joint_id]
                    if joint_id not in reported and not lo - LIMIT_EPS <= q <= hi + LIMIT_EPS:
                        reported.add(joint_id)
                        problems.append(f"{self.describe(joint_id)} reaches {q:.6g} {units[joint_id]} at "
                                        f"{root} = {value:.6g} {units[root]}, outside its limits [{lo:g}, {hi:g}]")
        return problems


NONE = Couplings()


# --------------------------------------------------------------------------- parsing


def parse(record: Mapping[str, Any]) -> Couplings:
    """The couplings of an assembly.yaml mapping (`joints`, `profiles`, `mechanisms`).

    Raises CouplingError listing every problem: unknown, fixed or self drivers, missing profiles or
    mechanisms, unit and joint-type mismatches, mechanism geometry that disagrees with its joints,
    and cycles (named). Unknown drivers are rejected before the topological sort, which would
    otherwise add them as nodes.
    """
    problems: list[str] = []
    joints = {raw["id"]: raw for raw in record.get("joints") or [] if isinstance(raw, Mapping) and isinstance(raw.get("id"), str)}
    profiles = _profiles(record.get("profiles"), problems)
    mechanisms = _mechanisms(record.get("mechanisms"), joints, problems)
    laws: dict[str, Law] = {}
    used_outputs: dict[tuple[str, str], str] = {}
    for joint_id, raw in joints.items():
        if "coupling" not in raw:
            continue
        where = f"{joint_id} coupling"
        spec = raw["coupling"]
        kind = raw.get("type")
        if kind not in JOINT_UNITS:
            problems.append(f"{where}: a {kind} joint cannot be coupled; couple a revolute or prismatic joint")
            continue
        if not isinstance(spec, Mapping) or spec.get("type") not in ("linear", "periodic_table", "slider_crank"):
            problems.append(f"{where}: expected a mapping with type linear, periodic_table or slider_crank")
            continue
        if spec["type"] == "slider_crank":
            law = _mechanism_output(joint_id, raw, spec, mechanisms, used_outputs, problems)
        else:
            driver = _driver(joint_id, spec.get("driver"), joints, problems)
            if spec["type"] == "linear":
                law = _linear(where, driver, spec, problems)
            else:
                law = _periodic(where, driver, joints, raw, spec, profiles, problems)
        if law is not None:
            laws[joint_id] = law
    # Every law here has a known, movable driver, so the sort adds no invented nodes.
    sorter = graphlib.TopologicalSorter({joint_id: {law.driver} for joint_id, law in laws.items()})
    try:
        order = tuple(n for n in sorter.static_order() if n in laws)
    except graphlib.CycleError as error:
        order = ()
        problems.append(f"coupling cycle: {' -> '.join(error.args[1])} (each joint drives the next)")
    if problems:
        raise CouplingError(problems)
    return Couplings(laws, order, mechanisms)


def _number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _vector(value: Any, where: str, problems: list[str]) -> Vec | None:
    if isinstance(value, Sequence) and not isinstance(value, str) and len(value) == 3 and all(_number(v) for v in value):
        return (float(value[0]), float(value[1]), float(value[2]))
    problems.append(f"{where} must be three finite numbers")
    return None


def _unit(value: Any, where: str, problems: list[str]) -> Vec | None:
    vector = _vector(value, where, problems)
    if vector is None:
        return None
    norm = math.sqrt(_dot(vector, vector))
    if norm < 1e-12:
        problems.append(f"{where} has zero length")
        return None
    return _scale(vector, 1.0 / norm)


def _optional(spec: Mapping[str, Any], key: str, where: str, problems: list[str]) -> float:
    value = spec.get(key, 0)
    if not _number(value):
        problems.append(f"{where}: {key} must be a finite number")
        return 0.0
    return float(value)


def _driver(joint_id: str, driver: Any, joints: Mapping[str, Any], problems: list[str],
            where: str | None = None) -> str | None:
    where = where or f"{joint_id} coupling"
    if not isinstance(driver, str):
        problems.append(f"{where}: driver must be a joint id")
        return None
    if driver == joint_id:
        problems.append(f"{where}: {joint_id} is coupled to itself")
        return None
    if driver not in joints:
        problems.append(f"{where}: driver {driver} is not a joint of this assembly")
        return None
    if joints[driver].get("type") not in JOINT_UNITS:
        problems.append(f"{where}: driver {driver} is a {joints[driver].get('type')} joint; a driver moves")
        return None
    return driver


def _linear(where: str, driver: str | None, spec: Mapping[str, Any], problems: list[str]) -> Linear | None:
    ratio = spec.get("ratio")
    if not _number(ratio) or ratio == 0:
        problems.append(f"{where}: ratio must be a finite non-zero number (a constant coordinate is a fixed joint)")
        return None
    offset = _optional(spec, "offset", where, problems)
    return Linear(driver, float(ratio), offset) if driver is not None else None


def _periodic(where: str, driver: str | None, joints: Mapping[str, Any], raw: Mapping[str, Any],
              spec: Mapping[str, Any], profiles: Mapping[str, Profile], problems: list[str]) -> PeriodicTable | None:
    phase = _optional(spec, "phase_deg", where, problems)
    name = spec.get("profile")
    if name not in profiles:
        problems.append(f"{where}: profile {name!r} is not in `profiles`"
                        + (f" (known: {', '.join(sorted(profiles))})" if profiles else ""))
        return None
    profile = profiles[name]
    unit = JOINT_UNITS[raw["type"]]
    if profile.output_unit != unit:
        problems.append(f"{where}: profile {name} outputs {profile.output_unit}, but {raw['id']} is a "
                        f"{raw['type']} joint in {unit}")
        return None
    if driver is not None and joints[driver].get("type") != "revolute":
        problems.append(f"{where}: driver {driver} is {joints[driver].get('type')}; a periodic table needs an angular "
                        "(revolute) driver")
        return None
    return PeriodicTable(driver, profile, phase) if driver is not None else None


def _mechanism_output(joint_id: str, raw: Mapping[str, Any], spec: Mapping[str, Any],
                      mechanisms: Mapping[str, SliderCrank], used: dict[tuple[str, str], str],
                      problems: list[str]) -> MechanismOutput | None:
    where = f"{joint_id} coupling"
    name, output = spec.get("mechanism"), spec.get("output")
    if output not in OUTPUTS:
        problems.append(f"{where}: output must be displacement or rod_angle")
        return None
    if name not in mechanisms:
        problems.append(f"{where}: mechanism {name!r} is not in `mechanisms`")
        return None
    mechanism = mechanisms[name]
    if mechanism.driver == joint_id:
        problems.append(f"{where}: {joint_id} drives its own mechanism {name}")
        return None
    if raw.get("type") != OUTPUTS[output]:
        problems.append(f"{where}: the {output} of {name} drives a {OUTPUTS[output]} joint, not a {raw.get('type')} one")
        return None
    if (name, output) in used:
        problems.append(f"{where}: the {output} of {name} already drives {used[(name, output)]}")
        return None
    used[(name, output)] = joint_id
    axis = _unit(raw.get("axis"), f"{joint_id}.axis", problems)
    origin = _vector(raw.get("origin"), f"{joint_id}.origin", problems)
    if axis is None or origin is None:
        return None
    if output == "displacement":
        if _dot(axis, mechanism.bank_axis) < 1.0 - AXIS_TOL:
            problems.append(f"{where}: the piston slides along {_rounded(axis)}, not along {name}'s bank_axis "
                            f"{_rounded(mechanism.bank_axis)}")
            return None
    else:
        if _dot(axis, mechanism.crank_axis) < 1.0 - AXIS_TOL:
            problems.append(f"{where}: the rod turns about {_rounded(axis)}, not about {name}'s crank_axis "
                            f"{_rounded(mechanism.crank_axis)}")
            return None
        miss = _line_distance(mechanism.tdc_wrist, origin, axis)
        if miss > POINT_TOL_MM:
            problems.append(f"{where}: the rod axis passes {miss:.6g} mm from {name}'s TDC wrist "
                            f"{_rounded(mechanism.tdc_wrist)}; set its origin there")
            return None
    return MechanismOutput(mechanism, output)


def _profiles(raw: Any, problems: list[str]) -> dict[str, Profile]:
    if raw is None:
        return {}
    if not isinstance(raw, Mapping):
        problems.append("profiles must map profile names to tables")
        return {}
    profiles = {}
    for name, spec in raw.items():
        where = f"profile {name}"
        if not isinstance(spec, Mapping):
            problems.append(f"{where}: expected a mapping")
            continue
        count = len(problems)
        if spec.get("input_unit") != "deg":
            problems.append(f"{where}: input_unit must be deg (a periodic table follows an angular driver)")
        if spec.get("output_unit") not in JOINT_UNITS.values():
            problems.append(f"{where}: output_unit must be mm or deg")
        if spec.get("interpolation") != "linear":
            problems.append(f"{where}: interpolation must be linear (no smoothing, no overshoot)")
        period = spec.get("period_deg")
        if not _number(period) or period <= 0:
            problems.append(f"{where}: period_deg must be a positive number")
        samples = spec.get("samples")
        if not (isinstance(samples, Sequence) and len(samples) >= 2 and all(
                isinstance(s, Sequence) and not isinstance(s, str) and len(s) == 2 and all(_number(v) for v in s)
                for s in samples)):
            problems.append(f"{where}: samples must be at least two [input, output] pairs of finite numbers")
        elif _number(period) and period > 0:
            xs = [float(s[0]) for s in samples]
            if any(b <= a for a, b in zip(xs, xs[1:])):
                problems.append(f"{where}: sample inputs must strictly increase")
            if xs[0] != 0 or xs[-1] != period:
                problems.append(f"{where}: samples must run from 0 to period_deg {period:g}")
            if samples[0][1] != samples[-1][1]:
                problems.append(f"{where}: the first and last outputs differ ({samples[0][1]:g}, {samples[-1][1]:g}); "
                                "a periodic profile closes on itself")
        if len(problems) == count:
            profiles[name] = Profile(name, spec["output_unit"], float(period),
                                     tuple((float(x), float(y)) for x, y in samples))
    return profiles


def _mechanisms(raw: Any, joints: Mapping[str, Any], problems: list[str]) -> dict[str, SliderCrank]:
    if raw is None:
        return {}
    if not isinstance(raw, Sequence) or isinstance(raw, str):
        problems.append("mechanisms must be a list")
        return {}
    mechanisms: dict[str, SliderCrank] = {}
    for spec in raw:
        if not isinstance(spec, Mapping) or not isinstance(spec.get("id"), str):
            problems.append(f"mechanism without a string id: {spec!r}")
            continue
        name = spec["id"]
        where = f"mechanism {name}"
        if name in mechanisms:
            problems.append(f"{where}: duplicate mechanism id")
            continue
        count = len(problems)
        if spec.get("type") != "slider_crank":
            problems.append(f"{where}: type must be slider_crank")
        driver = _driver("", spec.get("driver"), joints, problems, where)
        if driver is not None and joints[driver].get("type") != "revolute":
            problems.append(f"{where}: driver {driver} is {joints[driver].get('type')}; a crank is revolute")
        origin = _vector(spec.get("origin_mm"), f"{where} origin_mm", problems)
        crank = _unit(spec.get("crank_axis"), f"{where} crank_axis", problems)
        bank = _unit(spec.get("bank_axis"), f"{where} bank_axis", problems)
        if crank is not None and bank is not None and abs(_dot(crank, bank)) > AXIS_TOL:
            problems.append(f"{where}: crank_axis and bank_axis are not perpendicular")
        radius, length = spec.get("crank_radius_mm"), spec.get("rod_length_mm")
        if not (_number(radius) and _number(length) and length > radius > 0):
            problems.append(f"{where}: needs rod_length_mm > crank_radius_mm > 0")
        phase = _optional(spec, "phase_deg", where, problems)
        if len(problems) > count:
            continue
        mechanism = SliderCrank(name, driver, origin, crank, bank, float(radius), float(length), phase)
        crank_joint = joints[driver]
        axis = _unit(crank_joint.get("axis"), f"{driver}.axis", problems)
        at = _vector(crank_joint.get("origin"), f"{driver}.origin", problems)
        if axis is None or at is None:
            continue
        if _dot(axis, crank) < 1.0 - AXIS_TOL:
            problems.append(f"{where}: driver {driver} turns about {_rounded(axis)}, not about crank_axis {_rounded(crank)}")
        elif _line_distance(origin, at, axis) > POINT_TOL_MM:
            problems.append(f"{where}: driver {driver}'s axis does not pass through origin_mm {_rounded(origin)}")
        else:
            mechanisms[name] = mechanism
    return mechanisms


# --------------------------------------------------------------------------- vectors


def _dot(a: Vec, b: Vec) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a: Vec, b: Vec) -> Vec:
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _add(a: Vec, b: Vec) -> Vec:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def _scale(a: Vec, k: float) -> Vec:
    return (a[0] * k, a[1] * k, a[2] * k)


def _line_distance(point: Vec, origin: Vec, axis: Vec) -> float:
    """Distance from `point` to the line through `origin` along the unit `axis`."""
    offset = (point[0] - origin[0], point[1] - origin[1], point[2] - origin[2])
    across = _cross(offset, axis)
    return math.sqrt(_dot(across, across))


def _rounded(v: Vec) -> list[float]:
    return [round(c, 6) + 0.0 for c in v]
