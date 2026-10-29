"""View planning for part drawings: directions, projection arrangement, sections and details.

Pure Python over the datum frame and the bound features. ``plan_views`` turns ``part.drawing.views``
into ``ViewPlan`` rows that ``techdraw_job.py`` builds; the first orthographic view is the principal
view and every other orthographic view is placed by the product's projection method relative to it.

Direction semantics (``part.drawing.views[]``): a view's direction points from the part toward the
viewer, TechDraw's ``Direction``.

- ``normal_to: R`` looks at plane R face-on from the side its outward normal points to; for an axis it
  is ``along_axis``.
- ``along_axis: R`` / ``parallel_to: R`` looks along axis R; ``toward: F`` puts the viewer on F's side,
  else on the side the frame axis parallel to R points to.
- ``perpendicular_to: R`` looks across R along the first frame axis (x, y, z) perpendicular to it;
  ``toward: F`` picks the sense.
- ``opposite: V`` looks from the other side of view V.
- ``kind: section`` cuts through ``through`` (one axis or plane, or two references) with a plane that
  the principal view sees edge-on; with ``normal_axis: x|y|z`` the plane is normal to that frame axis
  through the centre of the one ``through`` reference (a recess, an opening, a pair of holes). A
  horizontal cutting line is viewed from below the principal view and a vertical one from its right, so
  the section keeps the principal view's up direction.
- ``kind: detail`` enlarges ``feature`` as seen in the principal view (or the view named by ``toward``).
- ``sheet: N`` draws the view on sheet N (default 1; a detail defaults to its base view's sheet). The
  principal view is on sheet 1, the sheets are numbered from 1 without gaps, and an orthographic view
  away from sheet 1 is named by a letter. A lettered view's direction is shown by a reference arrow
  with its letter on a projected view that sees that direction in its plane (ISO 128-3 reference
  arrow layout); its ``base`` names that view. ``relocated`` takes a view out of its projected
  position the same way when the sheet planner needs the room.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Any

import feature_geometry as fg
from drawing_intent import DatumFrame, IntentError, cylinder_instances, feature_centre
from feature_geometry import Face, ResolvedFeature, Vector

RELATIONS_FIRST_ANGLE = {"top": (0, 1), "bottom": (0, -1), "left": (1, 0), "right": (-1, 0)}  # (column, row) offsets
SECTION_LETTERS = "ABCDEFGHJKLMNPRTUVWY"


@dataclass(frozen=True)
class ViewPlan:
    id: str
    kind: str                          # "part", "section" or "detail" (TechDraw view type)
    role: str                          # the intent kind: orthographic, auxiliary, section, detail
    direction: Vector                  # toward the viewer
    x_direction: Vector                # model direction of the sheet's +x in this view
    relation: str | None = None        # placement relative to the principal view: front, top, bottom, left, right
    base: str | None = None
    section: Mapping[str, Any] | None = None
    detail: Mapping[str, Any] | None = None
    label: str | None = None
    scale: str = "auto"
    features: tuple[str, ...] = ()
    sheet: int = 1                     # the drawing sheet the view is drawn on

    @property
    def up(self) -> Vector:
        """Model direction of the sheet's up (-y) in this view."""
        return fg.cross(self.direction, self.x_direction)


def _ref_direction(name: str, frame: DatumFrame, features: Mapping[str, ResolvedFeature],
                   faces: Mapping[int, Face]) -> tuple[Vector, Vector]:
    """A reference's direction (plane normal or axis) and a point on it."""
    datum = frame.datums.get(name)
    if datum is not None and datum.direction is not None:
        return datum.direction, datum.point
    feature = features.get(name)
    if feature is None:
        raise IntentError("invalid_drawing_intent", f"view reference {name} is neither a datum nor a bound feature")
    own = [faces[i] for i in feature.faces]
    planes = [f for f in own if f.support_type == "plane"]
    instances = cylinder_instances(own)
    if feature.kind == "plane_face" and planes:
        return fg.unit(planes[0].normal), planes[0].point
    if instances:   # the middle of the cylinder's span: a section origin inside the part
        return instances[0].axis_dir, instances[0].point_at((instances[0].t0 + instances[0].t1) / 2)
    raise IntentError("invalid_drawing_intent", f"view reference {name} has no plane or axis")


def _ref_point(name: str, frame: DatumFrame, features: Mapping[str, ResolvedFeature],
               faces: Mapping[int, Face]) -> Vector:
    datum = frame.datums.get(name)
    if datum is not None:
        return datum.point
    feature = features.get(name)
    if feature is None:
        raise IntentError("invalid_drawing_intent", f"view reference {name} is neither a datum nor a bound feature")
    return feature_centre(feature, faces)


def _frame_sense(direction: Vector, frame: DatumFrame) -> Vector:
    axis = frame.axis_of(direction)
    if axis is None:
        return direction
    return frame.vector(axis[0])


def _sense(direction: Vector, toward: str | None, frame: DatumFrame, features: Mapping[str, ResolvedFeature],
           faces: Mapping[int, Face]) -> Vector:
    if toward is None:
        return direction
    target = _ref_point(toward, frame, features, faces)
    centre = frame.origin
    return direction if fg.dot(fg.sub(target, centre), direction) >= 0 else fg.scale(direction, -1.0)


def _x_direction(direction: Vector, frame: DatumFrame) -> Vector:
    for candidate in (frame.x, frame.z, frame.y):
        if fg.perpendicular(candidate, direction):
            return candidate
    projected = fg.sub(frame.x, fg.scale(direction, fg.dot(frame.x, direction)))
    return fg.unit(projected)


def _relation(direction: Vector, principal: ViewPlan) -> tuple[str, Vector] | None:
    """Where a view goes next to the principal view, and the x direction that projection keeps."""
    d0, x0, up0 = principal.direction, principal.x_direction, principal.up
    if 1 - fg.dot(direction, x0) < 1e-9:
        return "right_side", fg.scale(d0, -1.0)      # viewer on the right of the principal view
    if 1 - fg.dot(direction, fg.scale(x0, -1.0)) < 1e-9:
        return "left_side", d0
    if 1 - fg.dot(direction, up0) < 1e-9:
        return "above", x0
    if 1 - fg.dot(direction, fg.scale(up0, -1.0)) < 1e-9:
        return "below", x0
    if 1 - fg.dot(direction, fg.scale(d0, -1.0)) < 1e-9:
        return "rear", fg.scale(x0, -1.0)
    return None


def plan_views(drawing: Mapping[str, Any], frame: DatumFrame, features: Mapping[str, ResolvedFeature],
               faces: Mapping[int, Face]) -> list[ViewPlan]:
    specs = drawing.get("views") or []
    if not specs:
        raise IntentError("invalid_drawing_intent", "drawing.views is empty")
    plans: list[ViewPlan] = []
    by_id: dict[str, ViewPlan] = {}
    principal: ViewPlan | None = None
    letters = iter([letter for letter in SECTION_LETTERS if letter not in frame.datums])  # never reuse a datum letter
    for spec in specs:
        kind = spec["kind"]
        if kind in ("orthographic", "auxiliary"):
            if "opposite" in spec:
                other = by_id.get(spec["opposite"])
                if other is None:
                    raise IntentError("invalid_drawing_intent", f"view {spec['id']} is opposite an undefined view")
                direction = fg.scale(other.direction, -1.0)
            elif "normal_to" in spec:
                vector, _ = _ref_direction(spec["normal_to"], frame, features, faces)
                feature = features.get(spec["normal_to"])
                is_plane = spec["normal_to"] in frame.datums and frame.datums[spec["normal_to"]].role == "plane" or \
                    (feature is not None and feature.kind == "plane_face")
                direction = vector if is_plane else _sense(_frame_sense(vector, frame), spec.get("toward"), frame,
                                                           features, faces)
            elif "along_axis" in spec or "parallel_to" in spec:
                vector, _ = _ref_direction(spec.get("along_axis") or spec["parallel_to"], frame, features, faces)
                direction = _sense(_frame_sense(vector, frame), spec.get("toward"), frame, features, faces)
            elif "perpendicular_to" in spec:
                vector, _ = _ref_direction(spec["perpendicular_to"], frame, features, faces)
                direction = next(a for a in (frame.x, frame.y, frame.z) if fg.perpendicular(a, vector))
                direction = _sense(direction, spec.get("toward"), frame, features, faces)
            else:
                raise IntentError("invalid_drawing_intent", f"view {spec['id']} has no direction")
            if principal is None:
                plan = ViewPlan(spec["id"], "part", kind, direction, _x_direction(direction, frame), "front",
                                scale=spec.get("scale", "auto"))
                principal = plan
            else:
                relation = _relation(direction, principal)
                if relation is None:
                    plan = ViewPlan(spec["id"], "part", kind, direction, _x_direction(direction, frame), None,
                                    label=next(letters), scale=spec.get("scale", "auto"))
                else:
                    plan = ViewPlan(spec["id"], "part", kind, direction, relation[1], relation[0],
                                    scale=spec.get("scale", "auto"))
        elif kind == "section":
            if principal is None:
                raise IntentError("invalid_drawing_intent", f"section {spec['id']} comes before any orthographic view")
            through = spec["through"] if isinstance(spec["through"], list) else [spec["through"]]
            if "normal_axis" in spec:
                # a plane normal to a frame axis through the reference's centre: a recess, a cutout, a hole pair
                if len(through) != 1:
                    raise IntentError("invalid_drawing_intent", f"section {spec['id']} with normal_axis cuts through "
                                      f"one reference, not {through}")
                point = _ref_point(through[0], frame, features, faces)
                normal = frame.vector(spec["normal_axis"])
            else:
                refs = [_ref_direction(name, frame, features, faces) for name in through]
                vector, point = refs[0]
                if len(refs) > 1:
                    second = _ref_point(through[1], frame, features, faces)
                    normal = fg.cross(vector, fg.sub(second, point))
                    if fg.norm(normal) < 1e-9:
                        raise IntentError("invalid_drawing_intent", f"section {spec['id']} references are collinear")
                    normal = fg.unit(normal)
                else:
                    # the plane contains the reference axis (or is the reference plane) and the principal view's direction
                    ref_is_plane = (through[0] in frame.datums and frame.datums[through[0]].role == "plane") or \
                        (features.get(through[0]) is not None and features[through[0]].kind == "plane_face")
                    if ref_is_plane:
                        normal = vector
                    else:
                        normal = fg.cross(vector, principal.direction)
                        if fg.norm(normal) < 1e-9:
                            normal = principal.up
                        normal = fg.unit(normal)
            if not fg.perpendicular(normal, principal.direction):
                raise IntentError("feature_not_presentable", f"section {spec['id']} cuts obliquely to the principal view")
            # a horizontal cutting line: view from below, so the section keeps the principal view's up; else from the right
            if abs(fg.dot(normal, principal.up)) > 0.5:
                direction = normal if fg.dot(normal, principal.up) < 0 else fg.scale(normal, -1.0)
            else:
                direction = normal if fg.dot(normal, principal.x_direction) > 0 else fg.scale(normal, -1.0)
            relation = _relation(direction, principal)
            x_dir = relation[1] if relation else _x_direction(direction, frame)
            plan = ViewPlan(spec["id"], "section", kind, direction, x_dir, relation[0] if relation else None,
                            base=principal.id, section={"origin": point, "normal": direction},
                            label=next(letters), scale=spec.get("scale", "auto"))
        elif kind == "detail":
            base = by_id.get(spec.get("toward", "")) or principal
            if base is None:
                raise IntentError("invalid_drawing_intent", f"detail {spec['id']} has no base view")
            feature = features.get(spec["feature"])
            if feature is None:
                raise IntentError("feature_not_found", f"detail {spec['id']} names unbound feature {spec['feature']}")
            plan = ViewPlan(spec["id"], "detail", kind, base.direction, base.x_direction, None, base=base.id,
                            detail={"feature": feature.id, "centre": feature_centre(feature, faces)},
                            label=next(letters), scale=spec.get("scale", "auto"), features=(feature.id,))
        else:
            raise IntentError("invalid_drawing_intent", f"view {spec['id']} kind {kind!r} is not supported")
        number = spec.get("sheet", by_id[plan.base].sheet if plan.kind == "detail" else 1)
        if plan is principal and number != 1:
            raise IntentError("invalid_drawing_intent", f"the principal view {plan.id} is on sheet {number}, not sheet 1")
        if number != 1 and plan.kind == "part" and plan.label is None:
            plan = replace(plan, label=next(letters))   # away from the principal: named, not only placed by projection
        plan = replace(plan, sheet=number)
        if plan.kind == "part" and principal is not None and principal.id == plan.id:
            principal = plan
        plans.append(plan)
        by_id[plan.id] = plan
    numbers = sorted({p.sheet for p in plans})
    if numbers != list(range(1, len(numbers) + 1)):
        raise IntentError("invalid_drawing_intent", f"drawing.views fill sheets {numbers}; number them 1 to {len(numbers)}")
    # a lettered projected view's direction is shown by a reference arrow on a view that carries it
    return [replace(p, base=arrow_host(p, plans)) if p.kind == "part" and p.label is not None else p for p in plans]


def arrow_host(plan: ViewPlan, plans: Sequence[ViewPlan]) -> str | None:
    """The view that carries a lettered view's reference arrow (ISO 128-3, ASME Y14.3 view indicator): a
    projected view that sees the lettered view's direction in its own plane; the principal view, then views on
    the same sheet, then plan order."""
    hosts = [p for p in plans if p.kind == "part" and p.id != plan.id and p.label is None
             and fg.perpendicular(p.direction, plan.direction)]
    hosts.sort(key=lambda p: (p.relation != "front", p.sheet != plan.sheet, plans.index(p)))
    return hosts[0].id if hosts else None


def relocated(plans: Sequence[ViewPlan], view_id: str, reserved: Iterable[str], sheet: int | None = None
              ) -> list[ViewPlan] | None:
    """The plans with view ``view_id`` out of its projected position, and on ``sheet`` when given: a projected
    view is then named by a letter (never one in ``reserved``, the datum letters) and its direction shown by a
    reference arrow on another view; a section or detail keeps its letter. None when no view can carry the
    arrow."""
    plan = next(p for p in plans if p.id == view_id)
    if plan.kind == "part" and plan.base is None:
        host = arrow_host(plan, plans)
        if host is None:
            return None
        used = {p.label for p in plans} | set(reserved)
        plan = replace(plan, label=plan.label or next(letter for letter in SECTION_LETTERS if letter not in used),
                       base=host)
    plan = replace(plan, relation=None, sheet=plan.sheet if sheet is None else sheet)
    return [plan if p.id == view_id else p for p in plans]


def grid_cell(relation: str | None, projection: str) -> tuple[int, int] | None:
    """Column/row offsets from the principal view for an adjacent projected view (ISO 5456-2, ASME Y14.3)."""
    if relation is None or relation == "front":
        return (0, 0) if relation == "front" else None
    first = {"above": (0, 1), "below": (0, -1), "right_side": (-1, 0), "left_side": (1, 0), "rear": (2, 0)}
    third = {"above": (0, -1), "below": (0, 1), "right_side": (1, 0), "left_side": (-1, 0), "rear": (2, 0)}
    return (first if projection == "first_angle" else third).get(relation)


def parse_scale(text: str) -> float | None:
    if text == "auto":
        return None
    a, b = text.split(":")
    return float(a) / float(b)
