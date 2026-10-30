"""Motion plans: choreography as data over cad-motion's Chain, with its coverage check; kernel-free.

A plan names an ordered list of segments that move the record's independent joints. `expand` turns
it into frames, each completed through the couplings by `Chain.complete`, the only kinematics;
renderers never derive a coupled coordinate themselves. `coverage` checks that the frames visit every
independent joint's whole [min, max] and that no frame puts a joint, derived ones included, outside
its limits.

Sources: case `default` is generated from the record by `default_plan` and is never authored. Any
other case is authored at hw/motion/cases/<case>/plan.yaml (cad-record layout entry
`record.motion_case`); joint ids are checked against the version's record snapshot.

Plan (YAML, schema 1):

    schema: 1
    case: lamp-tour                  # optional; equals the case directory when given
    title: Fold, reach and tilt      # optional
    fps: 30                          # playback rate, 1..120; frames are spaced by max_step, not by time
    max_step: {deg: 5, mm: 1}        # largest independent-joint change between consecutive frames
    start: {J-002: -30}              # optional; unnamed independent joints start at nominal
    segments:
      - id: swivel-out               # unique slug [a-z0-9-]
        title: Swivel the base out   # optional
        to: {J-001: 80}              # absolute targets of independent joints; unnamed joints hold
        easing: linear               # linear (default) | ease_in_out
        camera: iso                  # iso (default) | front | side; fixed for the whole segment
      - {id: pause, hold_frames: 15} # a hold; without `camera` it keeps the previous segment's framing
    coverage: full                   # full (default) | partial, which needs `coverage_reason`
    coverage_reason: Close-up of the head tilt beside the full tour

Validation refuses unknown keys, unknown, fixed or coupled joints (a coupled joint names its driver),
targets outside [min, max], duplicate or malformed ids, bad easing or camera, and plans that expand
past MAX_FRAMES. Frame 0 is the start pose; each segment adds frames so that no independent joint
moves more than max_step between two frames (ease_in_out's steepest slope is pi/2 times the linear
one, so it takes pi/2 times as many).
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SCHEMA = 1
DEFAULT_CASE = "default"
CASE_ID = re.compile(r"^[a-z][a-z0-9_-]*$")  # layout.json token ID
SEGMENT_ID = re.compile(r"^[a-z0-9][a-z0-9-]*$")
EASINGS = ("linear", "ease_in_out")
CAMERAS = ("iso", "front", "side")  # cad-render view directions a segment may name
COVERAGE = ("full", "partial")
DEFAULT_FPS = 30
DEFAULT_STEP = {"deg": 5.0, "mm": 1.0}
MAX_FPS = 120
MAX_FRAMES = 10_000
COVER_EPS = 1e-9  # deg or mm: a visited interval this close to a limit covers it
PLAN_KEYS = {"schema", "case", "title", "fps", "max_step", "start", "segments", "coverage", "coverage_reason",
             "generated"}
MOVE_KEYS = {"id", "title", "to", "easing", "camera"}
HOLD_KEYS = {"id", "title", "hold_frames", "camera"}


class PlanError(ValueError):
    """A plan that cannot be used; `problems` lists every reason. Maps to exit 2."""

    def __init__(self, problems: Sequence[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = list(problems)


@dataclass(frozen=True)
class Frame:
    index: int
    segment: int  # index into the plan's segments; frame 0, the start pose, belongs to segment 0
    settings: Mapping[str, float]  # every independent joint
    values: Mapping[str, float]  # every movable joint, completed through the couplings


@dataclass(frozen=True)
class Span:
    """One segment's frames. `start` is the pose it leaves from (the previous segment's last frame, or
    frame 0); `last` the pose it ends at. `group` is the first segment of the camera group it belongs
    to: a hold without its own camera keeps the framing of the segment before it."""

    index: int
    id: str
    title: str
    start: int
    last: int
    camera: str
    group: int


# --------------------------------------------------------------------------- sources


def case_path(hw: Path, case: str, layout: Any) -> Path:
    """hw/motion/cases/<case>/plan.yaml, through cad-record's layout (`record.motion_case`)."""
    return layout.resolve(hw, "record.motion_case", ID=case) / "plan.yaml"


def read_plan(path: Path) -> Any:
    import yaml

    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise PlanError([f"no plan at {path}"]) from None
    except (OSError, UnicodeDecodeError, yaml.YAMLError) as error:
        raise PlanError([f"cannot read {path}: {error}"]) from None


def load(chain: Any, hw: Path, layout: Any, case: str = DEFAULT_CASE) -> dict[str, Any]:
    """The validated, effective plan of a case: the generated default, or hw/motion/cases/<case>/plan.yaml."""
    if not CASE_ID.match(case):
        raise PlanError([f"case must match {CASE_ID.pattern}, got {case!r}"])
    authored = case_path(hw, case, layout)
    if case != DEFAULT_CASE:
        return prepare(chain, read_plan(authored), case)
    if authored.exists():
        raise PlanError([f"{authored}: case `default` is reserved for the generated plan; rename the authored case"])
    return prepare(chain, default_plan(chain), case)


def prepare(chain: Any, data: Any, case: str) -> dict[str, Any]:
    """`data` validated against the chain, with every default written out (`effective`)."""
    problems = validate(chain, data, case)
    if problems:
        raise PlanError(problems)
    return effective(data, case)


def default_plan(chain: Any) -> dict[str, Any]:
    """Every independent joint over its whole range, with step sizes scaled to fit MAX_FRAMES."""
    joints = chain.independent
    if not joints:
        raise PlanError(["the record has no independent movable joint, so it has no motion to plan"])
    nominal = {j.id: float(j.nominal) for j in joints}
    current = dict(nominal)
    segments: list[dict[str, Any]] = []

    def leg(seg_id: str, title: str, to: dict[str, float]) -> None:
        if all(abs(current[k] - v) <= COVER_EPS for k, v in to.items()):
            return
        segments.append({"id": seg_id, "title": title, "to": dict(to)})
        current.update(to)

    for joint in joints:
        name = joint.id.lower()
        leg(f"{name}-to-min", f"{joint.id} to its minimum {joint.min:g} {joint.unit}", {joint.id: float(joint.min)})
        leg(f"{name}-to-max", f"{joint.id} through its range to {joint.max:g} {joint.unit}",
            {joint.id: float(joint.max)})
        if not same_pose(chain, current, nominal):
            leg(f"{name}-home", f"{joint.id} back to nominal {joint.nominal:g} {joint.unit}",
                {joint.id: nominal[joint.id]})
    if len(joints) > 1:
        leg("all-to-min", "every independent joint to its minimum", {j.id: float(j.min) for j in joints})
        leg("all-to-max", "every independent joint to its maximum", {j.id: float(j.max) for j in joints})
        if not same_pose(chain, current, nominal):
            leg("all-home", "every independent joint back to nominal", dict(nominal))
    max_step = _default_max_step(chain, segments)
    return {"schema": SCHEMA, "case": DEFAULT_CASE, "title": "Every independent joint over its full range",
            "fps": DEFAULT_FPS, "max_step": max_step, "segments": segments, "coverage": "full",
            "generated": "default plan, generated from the record"}

def _default_max_step(chain: Any, segments: Sequence[Mapping[str, Any]]) -> dict[str, float]:
    """Smallest uniform increase to the default units that fits all generated motion under MAX_FRAMES."""
    plan = {"segments": segments}
    total = sum(_frame_counts(chain, plan)) + 1
    if total <= MAX_FRAMES:
        return dict(DEFAULT_STEP)

    def fits(scale: float) -> bool:
        step = {unit: value * scale for unit, value in DEFAULT_STEP.items()}
        return sum(_frame_counts(chain, {"segments": segments, "max_step": step})) + 1 <= MAX_FRAMES

    low, high = 1.0, max(2.0, total / MAX_FRAMES)
    while not fits(high):
        high *= 2
    for _ in range(64):
        middle = (low + high) / 2
        if middle == low or middle == high:
            break
        if fits(middle):
            high = middle
        else:
            low = middle
    return {unit: value * high for unit, value in DEFAULT_STEP.items()}




def same_pose(chain: Any, a: Mapping[str, float], b: Mapping[str, float]) -> bool:
    """Whether two settings place every occurrence alike."""
    ta, tb = chain.transforms(chain.complete(a)), chain.transforms(chain.complete(b))
    return all(ta[oid].close_to(tb[oid]) for oid in chain.ids)


# --------------------------------------------------------------------------- validation


def _number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate(chain: Any, plan: Any, case: str) -> list[str]:
    """Every problem with `plan` against the chain's joints; empty when it can be expanded. It reads only
    `joints`, `movable`, `independent` and `couplings`, so a pose.Assembly checks a plan against a record."""
    if not isinstance(plan, dict):
        return ["a plan is a YAML mapping"]
    problems: list[str] = []
    independent = {j.id: j for j in chain.independent}
    movable = {j.id for j in chain.movable}
    joints = {j.id for j in chain.joints}

    def targets(where: str, value: Any) -> None:
        if not isinstance(value, dict) or not value:
            problems.append(f"{where}: expected a non-empty mapping of joint id -> value")
            return
        for jid, target in value.items():
            if jid in chain.couplings.laws:
                problems.append(f"{where}: {chain.couplings.describe(jid)}; move its driver instead")
            elif jid in joints and jid not in movable:
                problems.append(f"{where}: {jid} is a fixed joint; independent joints: {sorted(independent)}")
            elif jid not in independent:
                problems.append(f"{where}: {jid} is not a joint of this record; independent joints: "
                                f"{sorted(independent)}")
            elif not _number(target):
                problems.append(f"{where}: {jid} must be a finite number")
            elif not independent[jid].min - COVER_EPS <= target <= independent[jid].max + COVER_EPS:
                j = independent[jid]
                problems.append(f"{where}: {jid} = {target:g} {j.unit} is outside [{j.min:g}, {j.max:g}]")

    for key in sorted(set(plan) - PLAN_KEYS):
        problems.append(f"unknown plan key {key!r}; allowed: {sorted(PLAN_KEYS)}")
    if plan.get("schema") != SCHEMA:
        problems.append(f"schema must be {SCHEMA}")
    if "case" in plan and plan["case"] != case:
        problems.append(f"case is {plan['case']!r}, but the plan is case {case!r}")
    if not isinstance(plan.get("title", ""), str):
        problems.append("title must be text")
    fps = plan.get("fps", DEFAULT_FPS)
    if not isinstance(fps, int) or isinstance(fps, bool) or not 1 <= fps <= MAX_FPS:
        problems.append(f"fps must be an integer 1..{MAX_FPS}")
    step = plan.get("max_step", DEFAULT_STEP)
    if not isinstance(step, dict) or set(step) - set(DEFAULT_STEP) or \
            not all(_number(v) and v > 0 for v in step.values()):
        problems.append("max_step must map deg and/or mm to positive numbers")
    if "start" in plan:
        targets("start", plan["start"])
    coverage = plan.get("coverage", "full")
    if coverage not in COVERAGE:
        problems.append(f"coverage must be one of {list(COVERAGE)}")
    reason = plan.get("coverage_reason")
    if coverage == "partial" and not (isinstance(reason, str) and reason.strip()):
        problems.append("coverage: partial needs a coverage_reason")
    if coverage == "full" and reason is not None:
        problems.append("coverage_reason is only for coverage: partial")
    segments = plan.get("segments")
    if not isinstance(segments, list) or not segments:
        problems.append("segments must be a non-empty list")
        return problems
    seen: set[str] = set()
    for index, segment in enumerate(segments):
        where = f"segments[{index}]"
        if not isinstance(segment, dict):
            problems.append(f"{where}: expected a mapping")
            continue
        seg_id = segment.get("id")
        if not isinstance(seg_id, str) or not SEGMENT_ID.match(seg_id) or seg_id in seen:
            problems.append(f"{where}: id must be a unique slug matching {SEGMENT_ID.pattern}, got {seg_id!r}")
        else:
            seen.add(seg_id)
            where = f"{where} ({seg_id})"
        hold = "hold_frames" in segment
        for key in sorted(set(segment) - (HOLD_KEYS if hold else MOVE_KEYS)):
            problems.append(f"{where}: unknown key {key!r}" + ("; a hold takes no `to`" if hold and key == "to" else ""))
        if not isinstance(segment.get("title", ""), str):
            problems.append(f"{where}: title must be text")
        if "camera" in segment and segment["camera"] not in CAMERAS:
            problems.append(f"{where}: camera must be one of {list(CAMERAS)}")
        if hold:
            count = segment["hold_frames"]
            if not isinstance(count, int) or isinstance(count, bool) or count < 1:
                problems.append(f"{where}: hold_frames must be a positive integer")
            continue
        targets(where, segment.get("to"))
        if segment.get("easing", "linear") not in EASINGS:
            problems.append(f"{where}: easing must be one of {list(EASINGS)}")
    if not problems:
        count = sum(_frame_counts(chain, plan))
        if count + 1 > MAX_FRAMES:
            problems.append(f"the plan expands to {count + 1} frames, more than {MAX_FRAMES}; raise max_step")
    return problems


def effective(plan: Mapping[str, Any], case: str) -> dict[str, Any]:
    """The plan with every default written out: what a render records as plan.json."""
    out: dict[str, Any] = {"schema": SCHEMA, "case": case, "title": plan.get("title", ""),
                           "fps": plan.get("fps", DEFAULT_FPS), "max_step": {**DEFAULT_STEP, **plan.get("max_step", {})}}
    if "start" in plan:
        out["start"] = {k: float(v) for k, v in plan["start"].items()}
    segments, camera = [], "iso"
    for segment in plan["segments"]:
        if "hold_frames" in segment:
            entry = {"id": segment["id"], "title": segment.get("title", ""), "hold_frames": segment["hold_frames"]}
            if "camera" in segment:
                entry["camera"] = camera = segment["camera"]
        else:
            camera = segment.get("camera", "iso")
            entry = {"id": segment["id"], "title": segment.get("title", ""),
                     "to": {k: float(v) for k, v in segment["to"].items()},
                     "easing": segment.get("easing", "linear"), "camera": camera}
        segments.append(entry)
    out.update(segments=segments, coverage=plan.get("coverage", "full"))
    if out["coverage"] == "partial":
        out["coverage_reason"] = plan["coverage_reason"]
    if "generated" in plan:
        out["generated"] = plan["generated"]
    return out


# --------------------------------------------------------------------------- expansion


def _ease(kind: str, s: float) -> float:
    return s if kind == "linear" else (1.0 - math.cos(math.pi * s)) / 2.0


def _start(chain: Any, plan: Mapping[str, Any]) -> dict[str, float]:
    current = {j.id: float(j.nominal) for j in chain.independent}
    current.update({k: float(v) for k, v in (plan.get("start") or {}).items()})
    return current


def _frame_counts(chain: Any, plan: Mapping[str, Any]) -> list[int]:
    """Frames each segment adds after its start pose."""
    step = {**DEFAULT_STEP, **(plan.get("max_step") or {})}
    units = {j.id: j.unit for j in chain.independent}
    current, counts = _start(chain, plan), []
    for segment in plan["segments"]:
        if "hold_frames" in segment:
            counts.append(segment["hold_frames"])
            continue
        slope = math.pi / 2.0 if segment.get("easing", "linear") == "ease_in_out" else 1.0
        target = {**current, **{k: float(v) for k, v in segment["to"].items()}}
        counts.append(max(1, max(math.ceil(slope * abs(target[k] - current[k]) / step[units[k]] - 1e-12)
                                 for k in target)))
        current = target
    return counts


def expand(chain: Any, plan: Mapping[str, Any]) -> list[Frame]:
    """The frames of a validated plan; frame 0 is the start pose."""
    current = _start(chain, plan)
    settings: list[tuple[int, dict[str, float]]] = [(0, dict(current))]
    for index, (segment, count) in enumerate(zip(plan["segments"], _frame_counts(chain, plan))):
        if "hold_frames" in segment:
            settings += [(index, dict(current)) for _ in range(count)]
            continue
        target = {**current, **{k: float(v) for k, v in segment["to"].items()}}
        easing = segment.get("easing", "linear")
        for i in range(1, count + 1):
            s = _ease(easing, i / count)
            settings.append((index, {k: target[k] if i == count else current[k] + (target[k] - current[k]) * s
                                     for k in target}))
        current = target
    return [Frame(i, seg, values, chain.complete(values)) for i, (seg, values) in enumerate(settings)]


def spans(plan: Mapping[str, Any], frames: Sequence[Frame]) -> list[Span]:
    """Each segment's frame range, camera and camera group (see Span)."""
    last: dict[int, int] = {}
    for frame in frames:
        last[frame.segment] = frame.index
    out: list[Span] = []
    for index, segment in enumerate(plan["segments"]):
        start = out[-1].last if out else 0
        inherits = "hold_frames" in segment and "camera" not in segment and out
        camera = out[-1].camera if inherits else segment.get("camera", "iso")
        group = out[-1].group if inherits else index
        out.append(Span(index, segment["id"], segment.get("title", ""), start, last[index], camera, group))
    return out


# --------------------------------------------------------------------------- coverage


def _interval(lo: float, hi: float) -> list[float]:
    return [round(lo, 9) + 0.0, round(hi, 9) + 0.0]


def coverage(chain: Any, plan: Mapping[str, Any], frames: Sequence[Frame]) -> dict[str, Any]:
    """The coverage report: status pass | flagged | fail, per independent joint the visited interval and
    gaps, per derived joint its law, root driver and visited range, limit findings per frame."""
    rows, gaps = [], []
    for joint in chain.independent:
        visited = [f.settings[joint.id] for f in frames]
        lo, hi = min(visited), max(visited)
        # consecutive frames are one continuous move, so the visited set is the interval [lo, hi]
        missing = []
        if lo > joint.min + COVER_EPS:
            missing.append([float(joint.min), lo])
        if hi < joint.max - COVER_EPS:
            missing.append([hi, float(joint.max)])
        moved_in = sorted({plan["segments"][b.segment]["id"] for a, b in zip(frames, frames[1:])
                           if b.settings[joint.id] != a.settings[joint.id]})
        rows.append({"joint": joint.id, "type": joint.type, "unit": joint.unit, "limits": [joint.min, joint.max],
                     "visited": _interval(lo, hi), "segments": moved_in,
                     "gaps": [_interval(a, b) for a, b in missing], "status": "gap" if missing else "covered"})
        if missing:
            gaps.append(f"{joint.id} ({joint.type}) visits [{lo:g}, {hi:g}] {joint.unit} of "
                        f"[{joint.min:g}, {joint.max:g}]; missing " + ", ".join(f"[{a:g}, {b:g}]" for a, b in missing))
    derived = []
    for joint in chain.dependent:
        values = [f.values[joint.id] for f in frames]
        lo, hi = min(values), max(values)
        span = joint.max - joint.min
        derived.append({"joint": joint.id, "law": chain.couplings.describe(joint.id),
                        "root": chain.couplings.root(joint.id), "unit": joint.unit, "limits": [joint.min, joint.max],
                        "visited": _interval(lo, hi),
                        "fraction_of_limits": round((hi - lo) / span, 4) if span else None,
                        "moved": hi - lo > COVER_EPS})
    findings = [dict(finding, frame=frame.index) for frame in frames for finding in chain.limit_findings(frame.values)]
    combined = any(sum(abs(f.settings[j.id] - j.nominal) > COVER_EPS for j in chain.independent) >= 2
                   for f in frames)
    declared = plan.get("coverage", "full")
    status = "fail" if findings or (gaps and declared == "full") else ("flagged" if gaps else "pass")
    return {"status": status, "coverage_declared": declared, "coverage_reason": plan.get("coverage_reason"),
            "frames": len(frames), "segments": [s["id"] for s in plan["segments"]],
            "independent": rows, "gaps": gaps, "derived": derived,
            "unmoved_derived": [d["joint"] for d in derived if not d["moved"]],
            "combined_pose_present": combined, "limit_findings": findings[:50],
            "limit_findings_total": len(findings)}


def summary_line(report: Mapping[str, Any]) -> str:
    """One line for the gate output: every independent joint's visited interval, then the gaps."""
    joints = " ".join(f"{row['joint']} [{row['visited'][0]:g},{row['visited'][1]:g}]" for row in report["independent"])
    text = f"{report['status'].upper()}: {joints}"
    if report["gaps"]:
        text += "; gaps: " + "; ".join(report["gaps"])
    if report["limit_findings_total"]:
        text += f"; {report['limit_findings_total']} limit findings"
    return text
