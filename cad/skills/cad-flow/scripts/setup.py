#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Plan and optionally install non-CAD prerequisites for the CAD skills.

The default is a dry run. ``--yes`` executes user-level actions. FreeCAD must already be
installed; runtime environments, Chromium, and the three.js cache use preflight warm-up.
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import platform
import re
import shutil
import sys
import subprocess
import tempfile
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Sequence


SCRIPT_DIR = Path(__file__).resolve().parent
CAD_ROOT = SCRIPT_DIR.parents[2]
FORMULAS = CAD_ROOT / "formulas"
UV_INSTALLER = "https://astral.sh/uv/install.sh"
WARM_IDS = ("cadquery", "build123d", "cad-model", "ocp-viewer", "playwright-chromium", "three-vendor-cache")


def _load_preflight():
    """Load adjacent authoritative probes and warm-up without duplicating their checks."""
    sys.path[:0] = [str(CAD_ROOT / "skills" / "cad-drawings" / "scripts"),
                    str(CAD_ROOT / "skills" / "cad-model" / "scripts")]
    path = SCRIPT_DIR / "preflight.py"
    spec = importlib.util.spec_from_file_location("cad_flow_preflight", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load preflight script: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


preflight = _load_preflight()


@dataclass(frozen=True)
class PlanItem:
    id: str
    title: str
    command: str


def _run(argv: Sequence[str], *, cwd: Path | None = None, env: Mapping[str, str] | None = None,
         timeout: int = 1800) -> None:
    result = subprocess.run(list(argv), cwd=cwd, env=dict(env) if env is not None else None,
                            check=False, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"{argv[0]} exited with status {result.returncode}")


def _download(url: str, destination: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "cad-flow-setup"})
    with urllib.request.urlopen(request, timeout=120) as response, destination.open("wb") as output:
        shutil.copyfileobj(response, output)


def _install_uv(home: Path, environ: Mapping[str, str]) -> dict[str, str]:
    """Run Astral's official installer from a temporary script file."""
    with tempfile.TemporaryDirectory(prefix="cad-uv-setup-") as temporary:
        installer = Path(temporary) / "install-uv.sh"
        _download(UV_INSTALLER, installer)
        _run(["sh", str(installer)], env={**environ, "HOME": str(home)})
    updated = dict(environ)
    updated["PATH"] = os.pathsep.join([str(home / ".local" / "bin"), updated.get("PATH", "")])
    return updated


def _formulas_need_copy(cwd: Path, environ: Mapping[str, str]) -> bool:
    workspace = preflight.beads_workspace(cwd, environ)
    if workspace is None:
        return False
    destination = workspace / "formulas"
    return any(not (destination / source.name).is_file() or
               (destination / source.name).read_bytes() != source.read_bytes()
               for source in FORMULAS.glob("*.formula.toml"))


def _harness_sources(harness: str) -> list[tuple[Path, Path]]:
    if harness == "kiro":
        root = CAD_ROOT / "harness" / "kiro" / "agents"
        return [(source, Path(".kiro/agents") / source.name) for source in root.glob("cad-*.json")]
    if harness == "opencode":
        root = CAD_ROOT / "harness" / "opencode"
        sources = [*root.glob("agents/*.md"), *root.glob("commands/*.md"),
                   *(path for path in (CAD_ROOT / "skills").rglob("*") if path.is_file())]
        result = []
        for source in sources:
            if source.is_relative_to(CAD_ROOT / "skills"):
                target = Path(".opencode/skills") / source.relative_to(CAD_ROOT / "skills")
            else:
                target = Path(".opencode") / source.relative_to(root)
            result.append((source, target))
        return result
    return []


def _harness_needed(harness: str, cwd: Path, home: Path, environ: Mapping[str, str]) -> bool:
    if harness == "claude":
        return preflight._harness_check(harness, cwd, home, environ).status != "pass"
    if harness == "kiro":
        link = cwd / "cad"
        if not (link.is_dir() and (link / "skills").is_dir() and link.resolve() == CAD_ROOT.resolve()):
            return True
    return any(not (cwd / target).is_file() or (cwd / target).read_bytes() != source.read_bytes()
               for source, target in _harness_sources(harness))


def _release_info(path: Path) -> dict[str, str]:
    values = {}
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            key, separator, value = line.partition("=")
            if separator:
                values[key] = value.strip().strip('"')
    return values

def _is_debian_family(release: Mapping[str, str]) -> bool:
    """Whether os-release identifies Debian or Ubuntu, including ID_LIKE derivatives."""
    identifiers = {release.get("ID", "").lower(), *release.get("ID_LIKE", "").lower().split()}
    return bool(identifiers & {"debian", "ubuntu"})


def plan(report, cwd: Path, home: Path, environ: Mapping[str, str], harness: str | None = None) -> list[PlanItem]:
    """Plan actions for missing non-CAD prerequisites."""
    items: list[PlanItem] = []
    if any(check.id == "uv" and check.status != "pass" for check in report.checks):
        items.append(PlanItem("uv", "Install uv for the current user",
                              f"Official install command: curl -LsSf {UV_INSTALLER} | sh (setup downloads it to a file first)"))
    for identifier in (check.id for check in report.checks
                       if check.id in WARM_IDS and check.status != "pass"):
        items.append(PlanItem(f"warm-{identifier}", f"Resolve failed prerequisite: {identifier}",
                              f"preflight.py --warm (checks and warms {identifier})"))
    chromium = next((check for check in report.checks if check.id == "playwright-chromium"), None)
    if chromium is not None and chromium.status != "pass" and platform.system() == "Linux":
        release = _release_info(Path("/etc/os-release"))
        if _is_debian_family(release):
            items.append(PlanItem("browser-libraries", "Install Chromium system libraries",
                                  "Run `playwright install-deps chromium` (Debian/Ubuntu)."))
        else:
            target_os = release.get("ID", "this OS")
            detail = (f"Playwright install-deps supports Debian/Ubuntu only; {target_os} is unsupported. "
                      f"Install the missing Chromium libraries manually: {chromium.detail}")
            items.append(PlanItem("browser-libraries-manual", "Install Chromium system libraries manually", detail))
    if platform.system() == "Linux":
        items.append(PlanItem("manual-libraries", "Install OCP system libraries manually",
                              "Install `libglvnd-glx`, `libX11`, and `expat` (for example: "
                              "`dnf install libglvnd-glx libX11 expat`) for headless OCP."))
    workspace = preflight.beads_workspace(cwd, environ)
    if workspace is None:
        print("Warning: no Beads workspace found; skipped copying CAD formulas.")
    elif _formulas_need_copy(cwd, environ):
        items.append(PlanItem("formulas", f"Copy CAD formulas to {workspace / 'formulas'}",
                              f"Copy {FORMULAS}/*.formula.toml"))
    if harness and _harness_needed(harness, cwd, home, environ):
        action = {
            "claude": "claude plugin marketplace add srobroek/omp-plugins; claude plugin install cad@srobroek-omp",
            "kiro": "Link cad/ to this checkout; copy generated cad agents to .kiro/agents/",
            "opencode": "Copy generated cad agents, command, and skills into .opencode/",
        }[harness]
        items.append(PlanItem(f"harness-{harness}", f"Install CAD files for {harness.title()}", action))
    return items


def render_plan(items: Sequence[PlanItem], *, execute: bool) -> str:
    if not items:
        return "Setup plan: nothing to do."
    lines = ["Setup plan:" if not execute else "Setup plan (execution requested):"]
    for item in items:
        status = "run" if execute else "dry run"
        lines.append(f"- [{status}] {item.title}: {item.command}")
    return "\n".join(lines)


def _copy_formulas(cwd: Path, environ: Mapping[str, str]) -> None:
    workspace = preflight.beads_workspace(cwd, environ)
    if workspace is None:
        print("Warning: no Beads workspace found; skipped copying CAD formulas.")
        return
    destination = workspace / "formulas"
    destination.mkdir(parents=True, exist_ok=True)
    for source in FORMULAS.glob("*.formula.toml"):
        target = destination / source.name
        if not target.is_file() or target.read_bytes() != source.read_bytes():
            shutil.copy2(source, target)


def _copy_harness(harness: str, cwd: Path) -> None:
    if harness == "claude":
        _run(["claude", "plugin", "marketplace", "add", "srobroek/omp-plugins"], cwd=cwd)
        _run(["claude", "plugin", "install", "cad@srobroek-omp"], cwd=cwd)
        return
    if harness == "kiro":
        link = cwd / "cad"
        if not link.exists():
            link.symlink_to(CAD_ROOT, target_is_directory=True)
    for source, relative in _harness_sources(harness):
        target = cwd / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.is_file() or target.read_bytes() != source.read_bytes():
            shutil.copy2(source, target)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--yes", action="store_true", help="execute user-level setup actions")
    parser.add_argument("--harness", choices=("opencode", "kiro", "claude"),
                        help="install this harness's files as in cad/README.md")
    args = parser.parse_args(argv)
    cwd = Path.cwd()
    home = Path(os.environ.get("HOME", str(Path.home())))
    environ = dict(os.environ)

    cad_checks = preflight._timed_freecad_checks(environ, home)
    cad_report = preflight.Report(tuple(cad_checks))
    if cad_report.exit_code:
        print(preflight.render_text(cad_report))
        return cad_report.exit_code

    report = preflight.run_checks(environ, cwd, home, args.harness, cad_checks=cad_checks)
    items = plan(report, cwd, home, environ, args.harness)
    print(render_plan(items, execute=args.yes))
    if not args.yes:
        print("Dry run: no setup actions were executed.")
        return 0

    failures = []
    warm_started = False
    for item in items:
        if item.id in {"browser-libraries-manual", "manual-libraries"}:
            print(f"Manual system libraries step: {item.command}", file=sys.stderr)
            continue
        try:
            if item.id == "uv":
                environ = _install_uv(home, environ)
                environ["PATH"] = os.pathsep.join([str(home / ".local" / "bin"), environ.get("PATH", "")])
            elif item.id.startswith("warm-"):
                if not warm_started:
                    print("Warming runtime environments, Chromium, and the pinned three.js cache...")
                    print(preflight.render_text(preflight.warm(environ, cwd, home, args.harness)))
                    warm_started = True
            elif item.id == "formulas":
                _copy_formulas(cwd, environ)
            elif item.id.startswith("harness-"):
                _copy_harness(item.id.removeprefix("harness-"), cwd)
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            failures.append(f"{item.id}: {error}")
            print(f"Failed {item.id}: {error}", file=sys.stderr)

    print("Re-running CAD preflight after setup actions...")
    final_report = preflight.run_checks(environ, cwd, home, args.harness)
    print(preflight.render_text(final_report))
    return int(bool(failures) or final_report.exit_code != 0)


if __name__ == "__main__":
    raise SystemExit(main())
