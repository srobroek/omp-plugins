"""Safe Boolean edits for part model scripts, in either kernel.

    from cadmodel.safe import safe_cut, safe_fuse, safe_intersect

    body = safe_cut(body, bore)            # cq.Shape / cq.Workplane / build123d Shape in, same out
    body = safe_fuse(body, boss, rib)
    web = safe_intersect(blank, envelope)

Each operation runs one non-destructive OCCT Boolean on copies of its inputs and raises
`SafeEditError` instead of returning a result that is not physically possible:

| operation | accepted result volume V (inputs a, b..., slack = 1e-7 relative, >= 1e-6 mm^3) |
|---|---|
| safe_cut(a, *tools)       | V(a) - sum V(tools) <= V <= V(a)                      |
| safe_fuse(a, *others)     | max V(inputs) <= V <= sum V(inputs)                   |
| safe_intersect(a, *others)| 0 < V <= min V(inputs)                                |

Also rejected: an invalid or non-solid input, a kernel error, an invalid or empty result, and a
result whose solid members overlap (its volume double-counts space). Volumes are occupied
volumes: overlapping members of a multi-solid input are counted once.

The result comes back at the first input's abstraction level: a raw `TopoDS_Shape`, a CadQuery
`Shape` (cast to its topology class) or `Workplane` (one new stack object), or a build123d shape
(cast; a build123d `Part` input returns a `Part` when the result is a compound).

Adapted from AgentCAD 0.7.0 `agentcad.helpers` (Apache-2.0); see NOTICE.
"""

from __future__ import annotations

import sys
from typing import Any

from cadmodel import occ

__all__ = ["SafeEditError", "safe_cut", "safe_fuse", "safe_intersect"]


class SafeEditError(ValueError):
    """A Boolean edit was refused because its inputs or result are not physically valid."""


def _input(value: Any, label: str) -> tuple[Any, float]:
    shape = occ.to_topods(value)
    if shape is None:
        raise TypeError(f"{label} must be a TopoDS_Shape or a CadQuery/build123d shape, got {type(value).__name__}")
    if shape.IsNull():
        raise SafeEditError(f"{label} is a null shape")
    if not occ.is_valid(shape):
        raise SafeEditError(f"{label} is not a valid B-rep ({', '.join(occ.check_statuses(shape))}); repair it first")
    if occ.count(shape, "SOLID") == 0:
        raise SafeEditError(f"{label} contains no solid")
    try:
        shape, occupied = occ.occupied(shape)
    except occ.GeometryError as error:
        raise SafeEditError(f"{label}: {error}") from error
    if not occupied > 0.0:
        raise SafeEditError(f"{label} has non-positive volume {occupied:.6g} mm^3 (inside-out solid?)")
    return shape, occupied


def _result(name: str, operation: str, argument: Any, tools: list[Any]) -> tuple[Any, float]:
    try:
        result = occ.boolean(operation, argument, tools)
    except occ.GeometryError as error:
        raise SafeEditError(f"{name}: {error}") from error
    if not occ.is_valid(result):
        raise SafeEditError(f"{name} returned an invalid B-rep ({', '.join(occ.check_statuses(result))}); no result was accepted")
    if occ.count(result, "SOLID") == 0:
        raise SafeEditError(f"{name} rejected an empty result: no solid remains; no result was accepted")
    raw = occ.volume(result)
    try:
        _, physical = occ.occupied(result)
    except occ.GeometryError as error:
        raise SafeEditError(f"{name}: {error}") from error
    if abs(raw - physical) > occ.volume_slack(raw, physical):
        raise SafeEditError(f"{name} returned overlapping solid members ({raw:.6g} mm^3 counted, {physical:.6g} occupied)")
    return result, physical


def _bounds(name: str, value: float, low: float, high: float, slack: float, what: str) -> None:
    if not low - slack <= value <= high + slack:
        raise SafeEditError(f"{name} rejected an impossible result: {what} {value:.6g} mm^3 is outside "
                            f"[{low:.6g}, {high:.6g}] mm^3; no result was accepted")


def safe_cut(shape: Any, *tools: Any) -> Any:
    """`shape` minus every tool, refusing a result that gains volume or loses more than the tools hold."""
    if not tools:
        raise ValueError("safe_cut needs at least one tool")
    source, v_source = _input(shape, "safe_cut source")
    checked = [_input(tool, f"safe_cut tool {i}") for i, tool in enumerate(tools, start=1)]
    result, v = _result("safe_cut", "cut", source, [s for s, _ in checked])
    v_tools = sum(vol for _, vol in checked)
    _bounds("safe_cut", v, v_source - v_tools, v_source, occ.volume_slack(v_source, v_tools, v), "remaining volume")
    return _rewrap(result, shape)


def safe_fuse(shape: Any, *others: Any) -> Any:
    """Union of all inputs, refusing a result smaller than the largest or larger than their sum."""
    if not others:
        raise ValueError("safe_fuse needs at least two shapes")
    inputs = [_input(shape, "safe_fuse source"), *(_input(o, f"safe_fuse input {i}") for i, o in enumerate(others, start=1))]
    volumes = [vol for _, vol in inputs]
    result, v = _result("safe_fuse", "fuse", inputs[0][0], [s for s, _ in inputs[1:]])
    _bounds("safe_fuse", v, max(volumes), sum(volumes), occ.volume_slack(*volumes, v), "union volume")
    return _rewrap(result, shape)


def safe_intersect(shape: Any, *others: Any) -> Any:
    """Common volume of all inputs, refusing an empty result or one larger than the smallest input."""
    if not others:
        raise ValueError("safe_intersect needs at least two shapes")
    inputs = [_input(shape, "safe_intersect source"), *(_input(o, f"safe_intersect input {i}") for i, o in enumerate(others, start=1))]
    result = inputs[0][0]
    for other, _ in inputs[1:]:  # BOP COMMON with several tools keeps what any tool shares; chain for all
        result, v = _result("safe_intersect", "common", result, [other])
    volumes = [vol for _, vol in inputs]
    slack = occ.volume_slack(*volumes, v)
    if v <= slack:
        raise SafeEditError("safe_intersect rejected an empty result: the inputs do not overlap; no result was accepted")
    _bounds("safe_intersect", v, 0.0, min(volumes), slack, "intersection volume")
    return _rewrap(result, shape)


def _rewrap(topo: Any, template: Any) -> Any:
    """`topo` at `template`'s abstraction level; kernels are looked up, never imported."""
    from OCP.TopoDS import TopoDS_Shape

    if isinstance(template, TopoDS_Shape):
        return topo
    cq = sys.modules.get("cadquery")
    if cq is not None:
        if isinstance(template, cq.Workplane):
            return template.newObject([cq.Shape.cast(topo)])
        if isinstance(template, cq.Shape):
            return cq.Shape.cast(topo)
    bd = sys.modules.get("build123d")
    if bd is not None and isinstance(template, (bd.Shape, getattr(bd, "BuildPart", ()))):
        cast = bd.Shape.cast(topo)
        if isinstance(template, (bd.Part, bd.BuildPart)) and isinstance(cast, bd.Compound) and not isinstance(cast, bd.Part):
            return bd.Part(cast.wrapped)
        return cast
    return topo
