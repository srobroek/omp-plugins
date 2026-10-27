"""Declared pair relations between occurrences: fits, heat-set inserts and clearance requirements.

The one reader of hw/interfaces.yaml pair declarations for cad-model `check` and cad-motion `sweep`.
Each declaration is resolved once to the exact pair of occurrences it joins, through the caller's
assembly (cad-motion pose's `Assembly`: `attachable(ref, where)` and `pn(id)`): `@id` names one
occurrence, and a bare PN must have exactly one. So a fit declared on one occurrence never
excuses the overlap of another occurrence of the same PN. Every entry keeps its provenance:
interface id and record path.

Press fits are classified with cad-fits' ISO 286 tables; only an `interference` classification
allows shared volume. An installed heat-set insert overlaps its bore by design, so its pair may
interfere; unlike a press fit, no measured overlap is required, because a model may draw the
insert at its bore size. Running fits are resolved but not classified.

Every press fit, running fit and heat-set pair is fitted: fitted or contacting by design, it
inherits no global running clearance (sweep's `--min-clearance`). A clearance requirement, an
interface `{type: clearance, pair: [REF, REF], min_clearance_mm}`, binds its pair whatever else
joins it: a joint, a fit or an insert never exempts the pair, because the requirement is
explicit. Stdlib plus PyYAML; no CAD kernel.
"""

from __future__ import annotations

import importlib.util
import math
import sys
from collections.abc import Iterable, Iterator
from decimal import Decimal, InvalidOperation
from functools import cache
from pathlib import Path
from typing import Any

FITS_SCRIPT = Path(__file__).resolve().parents[2] / "cad-fits" / "scripts" / "fits.py"


class PolicyError(ValueError):
    """interfaces.yaml cannot be read or a declaration cannot be resolved; a usage error."""


@cache
def _fits_module() -> Any:
    """cad-fits' single ISO 286 classifier."""
    spec = importlib.util.spec_from_file_location("cad_pair_policy_fits", FITS_SCRIPT)
    if spec is None or spec.loader is None:
        raise PolicyError(f"cannot load fit classifier at {FITS_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def read_interfaces(hw: Path) -> list[Any]:
    """The interfaces list of hw/interfaces.yaml; empty when the file is absent."""
    import yaml

    path = hw / "interfaces.yaml"
    try:
        document = yaml.safe_load(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except (OSError, yaml.YAMLError) as error:
        raise PolicyError(f"{path}: cannot read interfaces: {error}") from error
    if not isinstance(document, dict) or not isinstance(document.get("interfaces"), list):
        raise PolicyError(f"{path}: expected an interfaces list")
    return document["interfaces"]


def _text(value: Any) -> bool:
    return isinstance(value, str) and bool(value)


def _pair(refs: list[str], assembly: Any, where: str) -> tuple[str, str]:
    a, b = (assembly.attachable(ref, f"{where}: ") for ref in refs)
    if a == b:
        raise PolicyError(f"{where}: both ends are the same occurrence {refs[0]}")
    return tuple(sorted((a, b)))  # type: ignore[return-value]


def _endpoint(entry: dict[str, Any], assembly: Any, where: str) -> str:
    """The occurrence of a feature endpoint: its `occurrence` (an @id of `PN`), else the PN's singleton."""
    ref = entry.get("occurrence")
    if ref is None:
        return assembly.attachable(entry["PN"], f"{where}: ")
    if not _text(ref) or not ref.startswith("@"):
        raise PolicyError(f"{where}: occurrence must be an @id reference, got {ref!r}")
    occurrence = assembly.attachable(ref, f"{where}: ")
    if assembly.pn(occurrence) != entry["PN"]:
        raise PolicyError(f"{where}: {ref} is an occurrence of {assembly.pn(occurrence)}, not {entry['PN']}")
    return occurrence


def _fit_pair(fit: dict[str, Any], assembly: Any, where: str) -> tuple[tuple[str, str], dict[str, Any] | None]:
    """The occurrence pair of a fit, and its feature endpoints when it declares them instead of a pair."""
    endpoints = {side: fit[side] for side in ("hole", "shaft") if side in fit}
    if "pair" in fit and not endpoints:
        pair = fit["pair"]
        if not isinstance(pair, list) or len(pair) != 2 or not all(_text(ref) for ref in pair) or pair[0] == pair[1]:
            raise PolicyError(f"{where}: expected fit and two distinct part references")
        return _pair(pair, assembly, where), None
    if "pair" not in fit and len(endpoints) == 2 and all(
            isinstance(e, dict) and _text(e.get("PN")) and _text(e.get("feature")) for e in endpoints.values()):
        hole, shaft = (_endpoint(endpoints[side], assembly, f"{where}/{side}") for side in ("hole", "shaft"))
        if hole == shaft:
            raise PolicyError(f"{where}: hole and shaft are on the same occurrence")
        return tuple(sorted((hole, shaft))), {  # type: ignore[return-value]
            side: {key: endpoints[side][key] for key in ("PN", "occurrence", "feature", "region") if key in endpoints[side]}
            for side in ("hole", "shaft")}
    raise PolicyError(f"{where}: expected fit with either a part pair or hole and shaft endpoints "
                      "{PN, feature} on two distinct occurrences")


def _fits(hw: Path, interfaces: list[Any], assembly: Any,
          kind: str) -> Iterator[tuple[dict[str, Any], str, tuple[str, str], dict[str, Any] | None, str]]:
    """(interface, designation, sorted occurrence pair, endpoints or None, source) of each `limits.<kind>` fit."""
    path = hw / "interfaces.yaml"
    for index, interface in enumerate(interfaces):
        if not isinstance(interface, dict):
            continue
        limits = interface.get("limits")
        fit = limits.get(kind) if isinstance(limits, dict) else None
        if fit is None:
            continue
        source = f"interfaces.yaml#/interfaces/{index}/limits/{kind}"
        where = f"{path}:{source}"
        if not isinstance(fit, dict) or not isinstance(fit.get("fit"), str):
            raise PolicyError(f"{where}: expected fit and two distinct part references")
        pair, endpoints = _fit_pair(fit, assembly, where)
        yield interface, fit["fit"], pair, endpoints, source


def _fit_entry(interface: dict[str, Any], designation: str, pair: tuple[str, str],
               endpoints: dict[str, Any] | None, source: str, **extra: Any) -> dict[str, Any]:
    entry = {"pair": list(pair), "fit": designation, **extra, "interface": interface.get("id"), "source": source}
    if endpoints is not None:
        entry["endpoints"] = endpoints
    return entry


def declared_press_fits(hw: Path, interfaces: list[Any], assembly: Any) -> list[dict[str, Any]]:
    """Press-fit declarations as {pair, fit, classification, interface, source[, endpoints]}.

    `pair` is the sorted occurrence ids. A fit names its parts as a `pair` or as feature-specific
    `hole` and `shaft` endpoints; an endpoint declaration is reported with its `endpoints`.
    """
    path = hw / "interfaces.yaml"
    fits = _fits_module() if interfaces else None
    declared = []
    for interface, designation, pair, endpoints, source in _fits(hw, interfaces, assembly, "press_fit"):
        where = f"{path}:{source}"
        size = designation.split(maxsplit=1)
        if len(size) != 2:
            raise PolicyError(f"{where}: fit must contain a nominal size and ISO fit")
        try:
            fit_data = fits.evaluate(Decimal(size[0]), size[1]).get("fit")
            if not isinstance(fit_data, dict):
                raise PolicyError(f"{where}: expected an ISO hole/shaft fit, got {designation!r}")
            classified = fit_data["type"]
        except (InvalidOperation, ValueError, fits.FitError, KeyError) as error:
            raise PolicyError(f"{where}: cannot classify {designation!r}: {error}") from error
        declared.append(_fit_entry(interface, designation, pair, endpoints, source, classification=classified))
    return declared


def declared_running_fits(hw: Path, interfaces: list[Any], assembly: Any) -> list[dict[str, Any]]:
    """Running-fit declarations as {pair, fit, interface, source[, endpoints]}, `pair` the sorted
    occurrence ids. A running fit is a clearance by design, often to vendor limits rather than an
    ISO 286 hole and shaft, so it is resolved but not classified."""
    return [_fit_entry(*fit) for fit in _fits(hw, interfaces, assembly, "running_fit")]


def declared_heat_sets(hw: Path, interfaces: list[Any], assembly: Any) -> list[dict[str, Any]]:
    """Heat-set inserts, `limits.heat_set: [{pair: [host, insert], hole_d, insert, source}]`, as
    {pair, host, insert, hole_d, interface, source} with `pair` the sorted occurrence ids and `host`
    the host's occurrence id."""
    path = hw / "interfaces.yaml"
    declared = []
    for index, interface in enumerate(interfaces):
        limits = interface.get("limits") if isinstance(interface, dict) else None
        entries = limits.get("heat_set") if isinstance(limits, dict) else None
        if entries is None:
            continue
        if not isinstance(entries, list):
            raise PolicyError(f"{path}:interfaces.yaml#/interfaces/{index}/limits/heat_set: expected a list")
        for number, entry in enumerate(entries):
            source = f"interfaces.yaml#/interfaces/{index}/limits/heat_set/{number}"
            pair = entry.get("pair") if isinstance(entry, dict) else None
            hole_d = entry.get("hole_d") if isinstance(entry, dict) else None
            if (not isinstance(pair, list) or len(pair) != 2 or not all(_text(ref) for ref in pair) or pair[0] == pair[1]
                    or isinstance(hole_d, bool) or not isinstance(hole_d, (int, float)) or hole_d <= 0
                    or not isinstance(entry.get("insert"), str) or not entry["insert"]):
                raise PolicyError(f"{path}:{source}: expected pair [host, insert], a positive hole_d "
                                  "and an insert designation")
            where = f"{path}:{source}"
            declared.append({"pair": list(_pair(pair, assembly, where)), "host": assembly.attachable(pair[0], f"{where}: "),
                             "insert": entry["insert"], "hole_d": hole_d, "interface": interface.get("id"),
                             "source": source})
    return declared


def allowed_pairs(press_fits: Iterable[dict[str, Any]], heat_sets: Iterable[dict[str, Any]]) -> set[tuple[str, str]]:
    """The occurrence pairs whose shared volume is declared: interference press fits and heat-set inserts."""
    allowed = {tuple(item["pair"]) for item in press_fits if item["classification"] == "interference"}
    return allowed | {tuple(item["pair"]) for item in heat_sets}  # type: ignore[return-value]


def fitted_pairs(*declarations: Iterable[dict[str, Any]]) -> set[tuple[str, str]]:
    """The occurrence pairs a press fit, running fit or heat-set insert declares. Fitted or contacting
    by design, they inherit no global running-clearance requirement; an explicit clearance
    requirement on such a pair still applies."""
    return {tuple(item["pair"]) for items in declarations for item in items}  # type: ignore[misc]


def declared_clearances(hw: Path, interfaces: list[Any], assembly: Any) -> list[dict[str, Any]]:
    """Clearance requirements as {pair, min_clearance_mm, interface, source}, `pair` the sorted
    occurrence ids; at most one requirement per occurrence pair.

    An interface with a `pair` or a `min_clearance_mm` is a requirement and needs both and `type:
    clearance`; a clearance interface with neither stays descriptive.
    """
    path = hw / "interfaces.yaml"
    declared: list[dict[str, Any]] = []
    by_pair: dict[tuple[str, str], str] = {}
    for index, interface in enumerate(interfaces):
        if not isinstance(interface, dict) or ("pair" not in interface and "min_clearance_mm" not in interface):
            continue
        source = f"interfaces.yaml#/interfaces/{index}"
        where = f"{path}:{source}"
        refs, required = interface.get("pair"), interface.get("min_clearance_mm")
        if (interface.get("type") != "clearance" or not isinstance(refs, list) or len(refs) != 2
                or not all(_text(ref) for ref in refs) or refs[0] == refs[1]
                or isinstance(required, bool) or not isinstance(required, (int, float))
                or not math.isfinite(required) or required <= 0):
            raise PolicyError(f"{where}: a clearance requirement needs type clearance, a pair of two distinct "
                              "part references and a positive min_clearance_mm")
        pair = _pair(refs, assembly, where)
        if pair in by_pair:
            raise PolicyError(f"{where}: {refs[0]} / {refs[1]} already has a clearance requirement at {by_pair[pair]}")
        by_pair[pair] = source
        declared.append({"pair": list(pair), "min_clearance_mm": float(required), "interface": interface.get("id"),
                         "source": source})
    return declared
