"""Programmatic grading of one trial's sandbox against its hidden truth.

`grade_trial` finds the part's STEP through `hw/versions/latest.json` (the
cad-model build index, paths relative to hw/), runs the two uv-isolated probes
(STEP read-back through OCCT, design-record check) and compares the result with
the truth file. Every metric is 0 or 1; `score` is their mean and
`pass` is 1 only when all hold. A probe that fails as infrastructure (exit 2)
raises `GraderError`, which the runner files in errors.jsonl, never as a zero.
"""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
STEP_READBACK = HERE / "step_readback.py"
RECORD_CHECK = HERE / "record_check.py"

METRICS = ("step", "ap242", "solids", "volume", "bbox", "holes", "record")
_SCHEMA = re.compile(r"FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'", re.IGNORECASE)
PROBE_TIMEOUT_S = 600


class GraderError(RuntimeError):
    """A probe could not run; the output was not scored."""


@dataclass(frozen=True)
class Graded:
    grade: dict
    explanation: str


def ap242_header(step_text: str) -> tuple[bool, str]:
    """True when the exchange file is ISO 10303-21 declaring an AP242 schema."""
    if not step_text.lstrip().startswith("ISO-10303-21"):
        return False, "not an ISO-10303-21 exchange file"
    head = step_text.split("ENDSEC", 1)[0]
    match = _SCHEMA.search(head)
    if not match:
        return False, "HEADER has no FILE_SCHEMA"
    schema = match.group(1)
    return schema.upper().startswith("AP242_MANAGED_MODEL_BASED_3D_ENGINEERING"), f"FILE_SCHEMA {schema}"


def compare(truth: dict, readback: dict) -> tuple[dict, list[str]]:
    """Compare a STEP read-back with the truth geometry; return metrics and notes."""
    notes: list[str] = []
    metrics = {}

    metrics["solids"] = int(readback["solids"] == truth["solids"])
    if not metrics["solids"]:
        notes.append(f"solids {readback['solids']} != {truth['solids']}")

    want_v, got_v = truth["volume_mm3"], readback["volume_mm3"]
    metrics["volume"] = int(abs(got_v - want_v) <= truth["volume_rel_tol"] * want_v)
    if not metrics["volume"]:
        notes.append(f"volume {got_v:.1f} vs {want_v:.1f} mm3 (±{truth['volume_rel_tol']:.1%})")

    want_b, got_b = sorted(truth["bbox_mm"]), sorted(readback["bbox_mm"])
    metrics["bbox"] = int(all(abs(g - w) <= truth["bbox_tol_mm"] for g, w in zip(got_b, want_b, strict=True)))
    if not metrics["bbox"]:
        notes.append(f"bbox {[round(v, 2) for v in got_b]} vs {want_b} mm (±{truth['bbox_tol_mm']})")

    got_d = [h["diameter_mm"] for h in readback["holes"]]
    tol = truth["hole_tol_mm"]
    counts_ok = all(sum(abs(d - h["diameter_mm"]) <= tol for d in got_d) == h["count"] for h in truth["holes"])
    total_ok = len(got_d) == sum(h["count"] for h in truth["holes"])
    metrics["holes"] = int(counts_ok and total_ok)
    if not metrics["holes"]:
        want = ", ".join(f"{h['count']}×Ø{h['diameter_mm']}" for h in truth["holes"])
        notes.append(f"holes {sorted(got_d)} vs {want} (±{tol} mm)")
    return metrics, notes


def _probe(script: Path, args: list[str]) -> tuple[int, dict | None, str]:
    try:
        done = subprocess.run(
            ["uv", "run", "--quiet", "--script", str(script), *args],
            capture_output=True, text=True, timeout=PROBE_TIMEOUT_S, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise GraderError(f"{script.name} did not run: {exc}") from exc
    if done.returncode == 2:
        raise GraderError(f"{script.name} infrastructure error: {done.stderr.strip()[-800:]}")
    payload = None
    if done.stdout.strip():
        try:
            payload = json.loads(done.stdout)
        except json.JSONDecodeError as exc:
            raise GraderError(f"{script.name} wrote non-JSON stdout") from exc
    return done.returncode, payload, done.stderr.strip()


def resolve_step(work: Path, deliverables: dict) -> tuple[Path | None, str]:
    """The STEP the trial delivered for the case's PN, and where it was found.

    `hw/versions/latest.json` is authoritative when present: its `parts[PN]` path,
    relative to hw/, must stay inside hw/. Only a record without a build index falls
    back to the case's legacy `step` path (seed oracles predating cad-model)."""
    record = work / deliverables.get("record", "hw")
    latest = record / "versions" / "latest.json"
    if not latest.is_file():
        return work / deliverables["step"], f"legacy path {deliverables['step']}"
    try:
        index = json.loads(latest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None, "versions/latest.json is unreadable"
    rel = ((index.get("parts") or {}) if isinstance(index, dict) else {}).get(deliverables["pn"])
    if not isinstance(rel, str):
        return None, f"versions/latest.json names no STEP for {deliverables['pn']}"
    path = (record / rel).resolve()
    if not path.is_relative_to(record.resolve()):
        return None, f"versions/latest.json points outside hw/: {rel}"
    return path, f"versions/latest.json ({index.get('label')}) -> {rel}"


def grade_trial(case: dict, work: Path, truth: dict, validator: Path | None) -> Graded:
    deliverables = case["deliverables"]
    metrics = dict.fromkeys(METRICS, 0)
    notes: list[str] = []

    step_path, source = resolve_step(work, deliverables)
    if step_path is not None and step_path.is_file():
        ok, why = ap242_header(step_path.read_text(encoding="utf-8", errors="replace"))
        metrics["ap242"] = int(ok)
        if not ok:
            notes.append(f"AP242 header: {why}")
        code, readback, err = _probe(STEP_READBACK, [str(step_path)])
        if code == 0 and readback is not None:
            metrics["step"] = 1
            geometry, more = compare(truth, readback)
            metrics.update(geometry)
            notes += more
        else:
            notes.append(f"STEP unreadable ({source}): {err[-300:]}")
    else:
        notes.append(f"STEP missing ({source})")

    args = [str(work / deliverables.get("record", "hw")), "--pn", deliverables["pn"]]
    if validator is not None:
        args += ["--validator", str(validator)]
    code, record, err = _probe(RECORD_CHECK, args)
    if record is None:
        raise GraderError(f"record_check produced no result: {err[-300:]}")
    metrics["record"] = int(record["part_present"] and record["valid"])
    if not metrics["record"]:
        notes.append(f"record ({record['validator']}): " + "; ".join(record["problems"][:5]))

    grade = {name: float(metrics[name]) for name in METRICS}
    grade["score"] = round(sum(metrics.values()) / len(METRICS), 4)
    grade["pass"] = float(all(metrics.values()))
    return Graded(grade=grade, explanation="all checks pass" if not notes else " | ".join(notes))
