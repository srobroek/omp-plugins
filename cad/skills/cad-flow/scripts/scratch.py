#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Scratch workspace of one cad-flow worker unit: copy hw/, build and check the copy, deliver the unit's parts.

Usage:
    uv run --script scratch.py init    --hw HW --unit UNIT --part PN [--part PN ...] [--reset]
    uv run --script scratch.py build   --hw HW --unit UNIT --fidelity F0|F1|F2|F3 [--kernel auto|cadquery|build123d]
                                       [--attach REF=PARENT_REF ...]
    uv run --script scratch.py deliver --hw HW --unit UNIT

The workspace is <project>/.cad-work/<UNIT>/, <project> being the directory that holds HW.

init    copies HW into <workspace>/hw/ without versions/, renders/, releases/, .git/, .cad/ (the
        part store, the pair cache, run records and the recheck stamp) and __pycache__/, then
        records the unit's PNs and the sha256 of every copied file in <workspace>/baseline.json.
        It seeds the scratch part store with hard links to HW's stored objects and build records,
        so the scratch build reuses every unchanged part. An existing workspace is kept unless
        --reset replaces it.
build   runs cad-model `run` on the scratch hw/ under the next scratch label, cad-model `check`
        on that version, and cad-design form_check at --fidelity. HW itself is never passed to
        any of them, so HW/versions/ is neither created nor changed. Form findings are split
        into the unit's own PNs and the rest; only the unit's own block it. Each --attach is
        passed to cad-model `run` and recorded in the scratch version, so a unit builds and
        checks against the same rigid attachments as the lead's integrated build.
deliver copies each unit PN's scratch hw/parts/<PN>/ over HW/parts/<PN>/ and lists every other
        scratch file that differs from the baseline as a proposal for the lead. When any
        HW/parts/<PN>/ changed since init it writes nothing and exits 1. Generated
        versions/, renders/, releases/ and .cad/ output and every __pycache__/ are ignored
        during delivery, so a scratch build's own caches never reach HW.

stdout: one JSON document; every path in it is absolute. build writes each tool's diagnostics to
<workspace>/<tool>-<label>.log and names the log in the JSON, so its output stays small.
Exit codes: 0 pass; 1 build: a part failed to build, a blocking check failed, or the unit's
parts have form findings; deliver: HW/parts/<PN>/ changed since init; 2 usage or
infrastructure error.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path, PurePosixPath
from typing import Any

SKILLS = Path(__file__).resolve().parents[2]
CAD_MODEL_SCRIPTS = SKILLS / "cad-model" / "scripts"
CAD_RECORD_SCRIPTS = SKILLS / "cad-record" / "scripts"
FORM_CHECK = SKILLS / "cad-design" / "scripts" / "form_check.py"
sys.path.insert(0, str(CAD_MODEL_SCRIPTS))
from cadmodel import scriptenv  # noqa: E402 - standard library only
CAD_MODEL = CAD_MODEL_SCRIPTS / "cad_model.py"
WORK_DIR = ".cad-work"
# .cad/ holds only caches and control files (cad-record layout cache.*, control.*): the part store is as
# large as every version together, and the scratch build writes its own pair cache and run records there.
NOT_COPIED = frozenset({"versions", "renders", "releases", ".git", ".cad"})
UNIT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
PN = re.compile(r"^[A-Z]{2,5}-[0-9]{4}$")
LABEL = re.compile(r"^v([1-9][0-9]*)$")


def load_layout():
    name = "cad_record_layout"
    if name not in sys.modules:
        path = CAD_RECORD_SCRIPTS / "layout.py"
        spec = importlib.util.spec_from_file_location(name, path)
        if spec is None or spec.loader is None:
            raise ImportError(f"layout.py not found at {path}")
        sys.modules[name] = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sys.modules[name])
    return sys.modules[name]


layout = load_layout()


class UsageError(Exception):
    """Bad arguments or missing workspace; exit 2 and make no delivery writes."""


def workspace(hw: Path, unit: str) -> Path:
    if not UNIT.match(unit) or ".." in unit:
        raise UsageError(f"unit {unit!r} must match {UNIT.pattern} without '..'")
    if not (hw / "parts").is_dir():
        raise UsageError(f"{hw} is not a design record: no parts/ directory")
    return hw.parent / WORK_DIR / unit


def is_skipped(relative: PurePosixPath, top: frozenset[str]) -> bool:
    """Whether a path relative to the copied root is left out: `top` directly below it, and
    __pycache__ anywhere."""
    return relative.parts[0] in top or "__pycache__" in relative.parts


def skips(root: Path, top: frozenset[str] = NOT_COPIED):
    """A copytree `ignore` that leaves out what `is_skipped` names."""
    def ignore(directory: str, names: list[str]) -> set[str]:
        below = PurePosixPath(Path(directory).relative_to(root).as_posix())
        return {name for name in names if is_skipped(below / name, top)}
    return ignore


def tree_hashes(root: Path, top: frozenset[str] = NOT_COPIED) -> dict[str, str]:
    """sha256 per file below `root`, keyed by POSIX path relative to it, skipping what `skips` leaves out."""
    hashes = {}
    for path in sorted(root.rglob("*")):
        relative = PurePosixPath(path.relative_to(root).as_posix())
        if is_skipped(relative, top) or not path.is_file():
            continue
        hashes[relative.as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return hashes


def load_baseline(work: Path) -> dict[str, Any]:
    path = work / "baseline.json"
    if not path.is_file():
        raise UsageError(f"{work} has no baseline.json; run `scratch.py init` first")
    return json.loads(path.read_text(encoding="utf-8"))


def seed_store(hw: Path, scratch_hw: Path) -> int:
    """Hard-link HW's part store (cad-record layout cache.part_objects, cache.part_records) into the
    scratch copy and return how many files were linked. The store's writers only rename onto a name and
    never write a file in place, so no scratch write reaches HW through a link; objects stay read-only.
    Where no hard link can be made (another filesystem) seeding stops, and the scratch build builds the
    rest itself; nothing is copied, because the store can be as large as every version together."""
    lay, seeded = layout.load(), 0
    for entry_id in ("cache.part_objects", "cache.part_records"):
        folder = layout.locate(hw, str(PurePosixPath(lay.entry(entry_id).path).parent))
        for path in sorted(folder.iterdir()) if folder.is_dir() else []:
            match = lay.classify(layout.relative(hw, path))
            if match is None or match.entry.id != entry_id or path.is_symlink() or not path.is_file():
                continue
            target = scratch_hw / path.relative_to(hw)
            target.parent.mkdir(parents=True, exist_ok=True)
            try:
                os.link(path, target)
            except OSError:
                return seeded
            seeded += 1
    return seeded


def init(hw: Path, unit: str, parts: list[str], reset: bool) -> tuple[int, dict[str, Any]]:
    bad = [pn for pn in parts if not PN.match(pn)]
    if not parts or bad:
        raise UsageError(f"--part needs one or more PNs matching {PN.pattern}; got {bad or 'none'}")
    work = workspace(hw, unit)
    if work.exists() and not reset:
        baseline = load_baseline(work)
        return 0, {"status": "exists", "unit": unit, "workspace": str(work), "scratch_hw": str(work / "hw"),
                   "parts": baseline["parts"], "note": "kept the existing workspace; --reset replaces it"}
    shutil.rmtree(work, ignore_errors=True)
    work.parent.mkdir(parents=True, exist_ok=True)
    gitignore = work.parent / ".gitignore"
    if not gitignore.exists():
        gitignore.write_text("*\n", encoding="utf-8")
    shutil.copytree(hw, work / "hw", ignore=skips(hw))
    seeded = seed_store(hw, work / "hw")
    for pn in sorted(set(parts)):
        if not (hw / "parts" / pn).exists():
            (work / "hw" / "parts" / pn).mkdir(parents=True, exist_ok=True)
    baseline = {"unit": unit, "hw": str(hw), "parts": sorted(set(parts)), "files": tree_hashes(work / "hw")}
    (work / "baseline.json").write_text(json.dumps(baseline, indent=2) + "\n", encoding="utf-8")
    return 0, {"status": "created", "unit": unit, "workspace": str(work), "scratch_hw": str(work / "hw"),
               "parts": baseline["parts"], "files": len(baseline["files"]), "seeded_store_files": seeded}


def run_tool(argv: list[str], log: Path) -> tuple[int, dict[str, Any] | None]:
    """Run one CAD tool through its PEP 723 dependency-set environment and log stderr/output."""
    try:
        with log.open("w", encoding="utf-8") as stderr:
            done = subprocess.run(scriptenv.script_command(Path(argv[0]), *argv[1:]),
                                  stdout=subprocess.PIPE, stderr=stderr, text=True)
    except FileNotFoundError as error:
        raise UsageError("uv is not on PATH") from error
    try:
        return done.returncode, json.loads(done.stdout)
    except ValueError:
        with log.open("a", encoding="utf-8") as stderr:
            stderr.write(done.stdout)
        return done.returncode, None


def next_label(scratch_hw: Path) -> str:
    built = [int(m.group(1)) for d in (scratch_hw / "versions").glob("v*")
             if (m := LABEL.match(d.name)) and (d / "manifest.json").is_file()]
    return f"v{max(built, default=0) + 1}"


def build(hw: Path, unit: str, kernel: str, fidelity: str,
          attach: tuple[str, ...] | list[str] = ()) -> tuple[int, dict[str, Any]]:
    work = workspace(hw, unit)
    baseline = load_baseline(work)
    own = set(baseline["parts"])
    scratch_hw = work / "hw"
    label = next_label(scratch_hw)
    attachments = list(attach)
    report: dict[str, Any] = {"unit": unit, "scratch_hw": str(scratch_hw), "label": label, "parts": sorted(own),
                              "attach": attachments}

    run_log = work / f"run-{label}.log"
    attach_args = [arg for spec in attachments for arg in ("--attach", spec)]
    code, ran = run_tool([str(CAD_MODEL), "run", str(scratch_hw), "--label", label, "--kernel", kernel,
                          *attach_args], run_log)
    report["run"] = {"exit": code, "log": str(run_log), "findings": (ran or {}).get("findings", [])}
    if code != 0:
        report["status"] = "fail" if code == 1 else "error"
        return (1 if code == 1 else 2), report
    version = scratch_hw / "versions" / label
    report.update({"version_dir": str(version), "parts_dir": str(version / "parts"),
                   "metrics": str(version / "metrics.json"), "assembly_step": str(version / "assembly.step")})

    check_out = work / f"check-{label}.json"
    check_log = work / f"check-{label}.log"
    code, checked = run_tool([str(CAD_MODEL), "check", label, "--hw", str(scratch_hw), "--out", str(check_out)], check_log)
    report["check"] = {"exit": code, "json": str(check_out), "log": str(check_log),
                       "blocking_failures": (checked or {}).get("blocking_failures"),
                       "warnings": (checked or {}).get("warnings")}

    form_out = work / f"form-{label}.json"
    form_log = work / f"form-{label}.log"
    form_code, form = run_tool([str(FORM_CHECK), "--hw", str(scratch_hw), "--parts-dir", str(version / "parts"),
                                "--fidelity", fidelity], form_log)
    findings = (form or {}).get("findings", [])
    if form is not None:
        form_out.write_text(json.dumps(form, indent=2) + "\n", encoding="utf-8")
    report["form"] = {"exit": form_code, "fidelity": fidelity, "json": str(form_out), "log": str(form_log),
                      "own_findings": [f for f in findings if f.get("part") in own],
                      "other_findings": [f for f in findings if f.get("part") not in own]}
    if code == 2 or form is None or form_code == 2:
        report["status"] = "error"
        return 2, report
    passed = code == 0 and not report["form"]["own_findings"]
    report["status"] = "pass" if passed else "fail"
    return (0 if passed else 1), report


def delivery_tree(root: Path) -> tuple[dict[str, str], set[str]]:
    files, directories = {}, set()
    skipped = skips(root)
    for current, dirnames, filenames in os.walk(root, followlinks=False):
        directory = Path(current)
        ignored = skipped(current, dirnames)
        for name in list(dirnames):
            path = directory / name
            if path.is_symlink():
                raise UsageError(f"scratch contains a symlink at {path.relative_to(root)}")
            if name in ignored:
                dirnames.remove(name)
                continue
            directories.add(path.relative_to(root).as_posix())
        for name in filenames:
            path = directory / name
            relative = path.relative_to(root).as_posix()
            if path.is_symlink() or not path.is_file():
                raise UsageError(f"scratch contains a symlink or special file at {relative}")
            files[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    return files, directories


def is_record_path(path: str) -> bool:
    match = layout.classify(f"hw/{path}")
    return match is not None and match.entry.kind == "record" and match.role == "source"


def validate_delivery(baseline: dict[str, Any], authorized: set[str], files: dict[str, str],
                      directories: set[str]) -> None:
    old_files: dict[str, str] = baseline["files"]
    known_parts = {path.split("/")[1] for path in old_files if path.startswith("parts/")}
    for path in files:
        if path.startswith("parts/"):
            pn = path.split("/")[1]
            if PN.fullmatch(pn) and pn not in authorized and pn not in known_parts:
                raise UsageError(f"unit is not authorized for new part {pn}; initialize it with --part {pn}")
    for directory in directories:
        if not any(path.startswith(f"{directory}/") for path in files) and not layout.load().known_directory(f"hw/{directory}"):
            raise UsageError(f"cannot deliver an unrecognized empty directory {directory}")
    for path in sorted(set(files) | set(old_files)):
        if files.get(path) != old_files.get(path):
            match = layout.classify(f"hw/{path}")
            pn = path.split("/")[1] if path.startswith("parts/") else None
            if match is None or match.entry.kind != "record" or match.params.get("PN") not in (None, pn):
                raise UsageError(f"cannot deliver changed non-record or non-canonical path {path}")
    for pn in authorized:
        prefix = f"parts/{pn}/"
        part_files = [path for path in files if path.startswith(prefix)]
        if not part_files or f"parts/{pn}/part.yaml" not in part_files:
            raise UsageError(f"scratch hw/parts/{pn}/ needs a canonical part.yaml before delivery")
        if any(not is_record_path(path) for path in part_files):
            raise UsageError(f"cannot deliver non-record or non-canonical part path under parts/{pn}/")


def deliver(hw: Path, unit: str) -> tuple[int, dict[str, Any]]:
    work = workspace(hw, unit)
    baseline = load_baseline(work)
    if Path(baseline["hw"]) != hw:
        raise UsageError(f"{work} was initialised from {baseline['hw']}, not {hw}")
    scratch_hw = work / "hw"
    files, directories = delivery_tree(scratch_hw)
    authorized = set(baseline["parts"])
    validate_delivery(baseline, authorized, files, directories)
    owned = [f"parts/{pn}/" for pn in authorized]
    baseline_files: dict[str, str] = baseline["files"]
    conflicts = []
    for pn in sorted(authorized):
        then = {path: digest for path, digest in baseline_files.items() if path.startswith(f"parts/{pn}/")}
        part_dir = hw / "parts" / pn
        now = {f"parts/{pn}/{path}": digest for path, digest in tree_hashes(part_dir, frozenset()).items()} \
            if part_dir.is_dir() else {}
        if now != then:
            conflicts.append(str(part_dir))
    if conflicts:
        return 1, {"status": "conflict", "unit": unit, "changed_since_init": conflicts,
                   "note": "another actor changed these part directories; nothing was delivered"}

    delivered = []
    for pn in sorted(authorized):
        target = hw / "parts" / pn
        staged = hw / "parts" / f".{pn}.deliver-{os.getpid()}"
        shutil.rmtree(staged, ignore_errors=True)
        source = scratch_hw / "parts" / pn
        shutil.copytree(source, staged, ignore=skips(source, frozenset()))
        if target.exists():
            retired = hw / "parts" / f".{pn}.replaced-{os.getpid()}"
            target.rename(retired)
            staged.rename(target)
            shutil.rmtree(retired)
        else:
            staged.rename(target)
        current = tree_hashes(target, frozenset())
        delivered.extend(str(target / path) for path in current)
        baseline_files = {path: digest for path, digest in baseline_files.items()
                          if not path.startswith(f"parts/{pn}/")}
        baseline_files.update({f"parts/{pn}/{path}": digest for path, digest in current.items()})
    baseline["files"] = baseline_files
    (work / "baseline.json").write_text(json.dumps(baseline, indent=2) + "\n", encoding="utf-8")
    proposals = []
    for path in sorted(set(files) | set(baseline_files)):
        if any(path.startswith(f"parts/{pn}/") for pn in authorized) or files.get(path) == baseline_files.get(path):
            continue
        change = "added" if path not in baseline_files else "removed" if path not in files else "modified"
        proposals.append({"path": str(hw / path), "scratch": str(scratch_hw / path), "change": change})
    return 0, {"status": "delivered", "unit": unit, "delivered": delivered, "proposals": proposals}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="cad-flow worker scratch workspace")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("init", "build", "deliver"):
        command = sub.add_parser(name)
        command.add_argument("--hw", type=Path, required=True, help="project hw/ record")
        command.add_argument("--unit", required=True, help="unit id from the lead's brief")
        if name == "init":
            command.add_argument("--part", action="append", default=[], metavar="PN", help="a PN this unit owns")
            command.add_argument("--reset", action="store_true", help="replace an existing workspace")
        if name == "build":
            command.add_argument("--fidelity", choices=("F0", "F1", "F2", "F3"), required=True)
            command.add_argument("--kernel", choices=("auto", "cadquery", "build123d"), default="auto")
            command.add_argument("--attach", action="append", default=[], metavar="REF=PARENT_REF",
                                 help="passed to cad-model run: rigidly attach an occurrence without a joint "
                                      "(a PN or @id; repeatable), as the lead's integrated build does")
    args = parser.parse_args(argv)
    hw = args.hw.resolve()
    try:
        if args.command == "init":
            code, report = init(hw, args.unit, args.part, args.reset)
        elif args.command == "build":
            code, report = build(hw, args.unit, args.kernel, args.fidelity, args.attach)
        else:
            code, report = deliver(hw, args.unit)
    except (UsageError, OSError, ValueError) as error:
        print(json.dumps({"status": "error", "error": str(error)}))
        return 2
    print(json.dumps(report, indent=2))
    return code


if __name__ == "__main__":
    sys.exit(main())
