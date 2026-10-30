#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6.0"]
# ///
"""Plan and optionally install non-CAD prerequisites for the CAD skills.

The default is a dry run. ``--yes`` executes user-level actions. FreeCAD must already be
installed; runtime environments, Chromium, and the three.js cache use preflight warm-up.

From a project root (the folder holding ``hw/``) setup also plans the git storage rules of the
generated results from ``hw/product.yaml`` ``storage.results_in_git`` (cad-record layout
``storage``). ``--storage`` plans only those rules, without the FreeCAD check or preflight.
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import platform
import re
import shutil
import shlex
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
LAYOUT_SCRIPT = CAD_ROOT / "skills" / "cad-record" / "scripts" / "layout.py"
STORAGE_BEGIN = "# >>> cad storage: written by cad-flow setup.py from product.yaml storage.results_in_git; do not edit"
STORAGE_END = "# <<< cad storage"


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


def _load_layout():
    """cad-record layout.py, the owner of which generated results git tracks; standard library only."""
    name = "cad_record_layout"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, LAYOUT_SCRIPT)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"Cannot load cad-record layout: {LAYOUT_SCRIPT}")
        sys.modules[name] = importlib.util.module_from_spec(spec)  # its dataclasses look the module up here
        spec.loader.exec_module(sys.modules[name])
    return sys.modules[name]


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
    return items + storage_plan(cwd)


def storage_answer(hw: Path) -> bool | None:
    """product.yaml `storage.results_in_git`: the user's true or false, None while the user was not asked."""
    import yaml  # in setup's environment; plain `python3 setup.py` without PyYAML reports it as a manual step

    path = hw / "product.yaml"
    try:
        product = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as error:
        raise ValueError(f"{path} is not valid YAML: {error}") from error
    storage = product.get("storage") if isinstance(product, dict) else None
    answer = storage.get("results_in_git") if isinstance(storage, dict) else None
    if answer is not None and not isinstance(answer, bool):
        raise ValueError(f"{path} storage.results_in_git must be true or false, not {answer!r}")
    return answer


def managed_block(text: str, lines: Sequence[str]) -> str:
    """`text` with its cad storage block replaced by `lines`, or dropped when `lines` is empty; every
    other line is kept as it was."""
    kept: list[str] = []
    inside = False
    for line in text.splitlines():
        if line == STORAGE_BEGIN:
            inside = True
        elif inside:
            inside = line != STORAGE_END
        else:
            kept.append(line)
    while kept and not kept[-1].strip():
        kept.pop()
    block = [STORAGE_BEGIN, *lines, STORAGE_END] if lines else []
    joined = kept + ([""] if kept and block else []) + block
    return "\n".join(joined) + "\n" if joined else ""


def storage_changes(hw: Path) -> tuple[bool | None, dict[Path, str]]:
    """The storage answer, and the new text of each of hw/.gitignore and hw/.gitattributes whose rules
    differ from it ("" removes a file that would hold nothing)."""
    answer = storage_answer(hw)
    changes = {}
    for name, lines in _load_layout().git_storage(answer).items():
        path = hw / name
        current = path.read_text(encoding="utf-8") if path.is_file() else ""
        wanted = managed_block(current, lines)
        if wanted != current:
            changes[path] = wanted
    return answer, changes


def write_storage(changes: Mapping[Path, str]) -> None:
    for path, text in changes.items():
        if text:
            path.write_text(text, encoding="utf-8")
        else:
            path.unlink(missing_ok=True)


def tracked_results(hw: Path) -> list[str]:
    """The result folders below hw/ (layout `storage.results`, globs resolved) that git already tracks
    files in; [] outside a git checkout. Read-only: `git ls-files`."""
    try:
        listed = subprocess.run(["git", "-C", str(hw), "ls-files", "-z"], capture_output=True, timeout=120,
                                check=False, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
    except (OSError, subprocess.SubprocessError):
        return []
    if listed.returncode:
        return []
    layout = _load_layout()
    names = listed.stdout.decode("utf-8", "surrogateescape").split("\0")
    return sorted({root for name in names if name and (root := layout.result_root(name)) is not None})


def storage_plan(cwd: Path) -> list[PlanItem]:
    """The git storage rules of the project in `cwd`, when it holds hw/product.yaml, and the manual
    untracking step for results git already tracks while storing them is not approved."""
    hw = cwd / "hw"
    if not (hw / "product.yaml").is_file():
        return []
    try:
        answer, changes = storage_changes(hw)
    except (OSError, ValueError, ImportError) as error:
        return [PlanItem("storage-manual", "Fix the git storage answer", f"Cannot plan the git storage rules: {error}")]
    items = []
    if changes:
        files = ", ".join(os.path.relpath(path, cwd) for path in changes)
        if answer is True:
            suffixes = ", ".join(f"*{suffix}" for suffix in _load_layout().load().storage["lfs_suffixes"])
            detail = (f"results_in_git is true: track generated results, with Git LFS rules for {suffixes} ({files}). "
                      "Setup never runs git lfs: install Git LFS and run `git lfs install` once per clone before "
                      "committing results")
            if shutil.which("git-lfs") is None:
                detail += "; Git LFS is not installed here"
        else:
            state = "is false" if answer is False else "is not answered yet, so nothing is tracked"
            detail = f"results_in_git {state}: keep generated results out of git ({files})"
        items.append(PlanItem("git-storage", "Write the git storage rules for generated results", detail))
    tracked = tracked_results(hw) if answer is not True else []
    if tracked:
        paths = " ".join(shlex.quote(os.path.relpath(hw / root, cwd)) for root in tracked)
        items.append(PlanItem("git-untrack-manual", "Stop tracking results git already tracks (manual)",
                              f"git still tracks {paths}, and .gitignore untracks nothing. To stop tracking them, "
                              f"run `git rm -r --cached {paths}` yourself, then commit; the files stay on disk. "
                              "Setup never runs it."))
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


def _execute(items: Sequence[PlanItem], cwd: Path, home: Path, environ: dict[str, str],
             harness: str | None) -> tuple[list[str], dict[str, str]]:
    """Run each planned action; returns the failures and the environment the actions left."""
    failures = []
    warm_started = False
    for item in items:
        if item.id in {"browser-libraries-manual", "manual-libraries"}:
            print(f"Manual system libraries step: {item.command}", file=sys.stderr)
            continue
        if item.id in {"git-untrack-manual", "storage-manual"}:
            print(f"Manual step: {item.command}", file=sys.stderr)
            continue
        try:
            if item.id == "uv":
                environ = _install_uv(home, environ)
                environ["PATH"] = os.pathsep.join([str(home / ".local" / "bin"), environ.get("PATH", "")])
            elif item.id.startswith("warm-"):
                if not warm_started:
                    print("Warming runtime environments, Chromium, and the pinned three.js cache...")
                    print(preflight.render_text(preflight.warm(environ, cwd, home, harness)))
                    warm_started = True
            elif item.id == "formulas":
                _copy_formulas(cwd, environ)
            elif item.id.startswith("harness-"):
                _copy_harness(item.id.removeprefix("harness-"), cwd)
            elif item.id == "git-storage":
                write_storage(storage_changes(cwd / "hw")[1])
        except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
            failures.append(f"{item.id}: {error}")
            print(f"Failed {item.id}: {error}", file=sys.stderr)
    return failures, environ


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--yes", action="store_true", help="execute user-level setup actions")
    parser.add_argument("--harness", choices=("opencode", "kiro", "claude"),
                        help="install this harness's files as in cad/README.md")
    parser.add_argument("--storage", action="store_true",
                        help="plan only the git storage rules of hw/ in this folder (with --yes, write them)")
    args = parser.parse_args(argv)
    cwd = Path.cwd()
    home = Path(os.environ.get("HOME", str(Path.home())))
    environ = dict(os.environ)

    if args.storage:
        if not (cwd / "hw" / "product.yaml").is_file():
            print(f"No hw/product.yaml in {cwd}; run setup --storage from the project root.", file=sys.stderr)
            return 2
        items = storage_plan(cwd)
        print(render_plan(items, execute=args.yes))
        if not args.yes:
            print("Dry run: no setup actions were executed.")
            return 0
        return int(bool(_execute(items, cwd, home, environ, args.harness)[0]))

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

    failures, environ = _execute(items, cwd, home, environ, args.harness)
    print("Re-running CAD preflight after setup actions...")
    final_report = preflight.run_checks(environ, cwd, home, args.harness)
    print(preflight.render_text(final_report))
    return int(bool(failures) or final_report.exit_code != 0)


if __name__ == "__main__":
    raise SystemExit(main())
