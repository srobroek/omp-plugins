#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Plan and optionally install prerequisites for the CAD skills.

The default is a dry run. ``--yes`` executes user-level actions. FreeCAD installs and Linux
Chromium libraries require both ``--yes`` and ``--system``. Runtime environments, Chromium,
and the three.js cache are delegated to the existing preflight warm-up.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Sequence


SCRIPT_DIR = Path(__file__).resolve().parent
CAD_ROOT = SCRIPT_DIR.parents[2]
FORMULAS = CAD_ROOT / "formulas"
FREECAD_VERSION = "1.1.4"
FREECAD_RELEASE = "https://github.com/FreeCAD/FreeCAD/releases/download/1.1.4"
UV_INSTALLER = "https://astral.sh/uv/install.sh"
WARM_IDS = ("cadquery", "build123d", "cad-model", "ocp-viewer", "playwright-chromium", "three-vendor-cache")

# SHA-256 values are from the official GitHub release; also listed by the Homebrew cask.
FREECAD_ASSETS = {
    ("Darwin", "arm64"): ("FreeCAD_1.1.4-macOS-arm64-py311.dmg", "071343b4abb70492b75c973f41eaf1d2528f9b9c7ea018d22a4f46ae14d27ac0"),
    ("Darwin", "x86_64"): ("FreeCAD_1.1.4-macOS-x86_64-py311.dmg", "e173d0dcf47a5166b59cbb33adccf54cd751eb9ceaa2c86486230d0d079648c1"),
    ("Linux", "x86_64"): ("FreeCAD_1.1.4-Linux-x86_64-py311.AppImage", "f6dc6ba676e5ac96a565ebc8d657232f94c6158e85b4352141bd1a46f6b43434"),
    ("Linux", "aarch64"): ("FreeCAD_1.1.4-Linux-aarch64-py311.AppImage", "675d1a4295b2183e0e1d816a4b5557dcb63aeced4e60aaa28d6c3686f4c71dc9"),
}


def _load_preflight():
    """Load the adjacent authoritative probes and warm-up without duplicating their checks."""
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
    system: bool = False


def _freecad_needed(report) -> bool:
    return any(check.id in {"freecad-command", "freecad-version", "techdraw-templates"}
               and check.status != "pass" for check in report.checks)


def _warm_failures(report) -> list[str]:
    return [check.id for check in report.checks if check.id in WARM_IDS and check.status != "pass"]


def _freecad_item() -> PlanItem:
    asset = FREECAD_ASSETS.get((platform.system(), platform.machine()))
    if asset:
        name, digest = asset
        command = f"Download {FREECAD_RELEASE}/{name}; verify SHA-256 {digest}; install complete bundle"
        if platform.system() == "Darwin" and shutil.which("brew"):
            command += "; pinned cask fallback: brew install --cask freecad (1.1.4)"
    else:
        command = f"No official FreeCAD {FREECAD_VERSION} release for {platform.system()} {platform.machine()}"
    return PlanItem("freecad", f"Install FreeCAD {FREECAD_VERSION}", command, system=True)
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


def plan(report, cwd: Path, home: Path, environ: Mapping[str, str], harness: str | None = None) -> list[PlanItem]:
    """Plan one action per missing prerequisite, reusing preflight's existing warm operation."""
    items: list[PlanItem] = []
    uv_missing = any(check.id == "uv" and check.status != "pass" for check in report.checks)
    if uv_missing:
        items.append(PlanItem("uv", "Install uv for the current user",
                              f"Official install command: curl -LsSf {UV_INSTALLER} | sh (setup downloads it to a file first)",
                              system=True))
    if _freecad_needed(report):
        items.append(_freecad_item())
    failed = _warm_failures(report)
    if failed:
        items.append(PlanItem("warm", "Warm failed CAD environments, Chromium, and the pinned three.js cache",
                              "preflight.py --warm (covers: " + ", ".join(failed) + ")"))
    chromium = next((check for check in report.checks if check.id == "playwright-chromium"), None)
    if platform.system() == "Linux" and chromium is not None and chromium.status != "pass":
        items.append(PlanItem("browser-libraries", "Install Playwright Chromium system libraries",
                              "preflight installs Chromium OS dependencies with its pinned environment", system=True))
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


def render_plan(items: Sequence[PlanItem], *, execute: bool, system: bool) -> str:
    if not items:
        return "Setup plan: nothing to do."
    lines = ["Setup plan:" if not execute else "Setup plan (execution requested):"]
    for item in items:
        status = "run" if execute and (not item.system or system) else "requires --yes --system" if item.system else "dry run"
        lines.append(f"- [{status}] {item.title}: {item.command}")
    return "\n".join(lines)


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


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _install_freecad(environ: Mapping[str, str]) -> None:
    asset, expected = FREECAD_ASSETS[(platform.system(), platform.machine())]
    with tempfile.TemporaryDirectory(prefix="cad-freecad-setup-") as temporary:
        work = Path(temporary)
        archive = work / asset
        _download(f"{FREECAD_RELEASE}/{asset}", archive)
        actual = _sha256(archive)
        if actual != expected:
            raise RuntimeError(f"FreeCAD checksum mismatch: expected {expected}, got {actual}")
        print(f"Verified FreeCAD archive SHA-256 {actual}.", flush=True)
        if platform.system() == "Darwin" and shutil.which("brew"):
            try:
                result = subprocess.run(["brew", "info", "--cask", "--json=v2", "freecad"],
                                        capture_output=True, text=True, timeout=30, check=False)
                casks = json.loads(result.stdout).get("casks", []) if result.returncode == 0 else []
                current = casks[0].get("version") if casks else None
            except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
                current = None
            if current == FREECAD_VERSION:
                _run(["brew", "install", "--cask", "freecad"])
                return
            print(f"Homebrew cask is {current or 'unavailable'}, not pinned {FREECAD_VERSION}; installing the verified release DMG.")
        if platform.system() == "Darwin":
            mount = work / "mount"
            mount.mkdir()
            _run(["hdiutil", "attach", "-nobrowse", "-readonly", "-mountpoint", str(mount), str(archive)])
            try:
                source = mount / "FreeCAD.app"
                if not source.is_dir():
                    raise RuntimeError("FreeCAD disk image contains no FreeCAD.app")
                _run(["ditto", str(source), "/Applications/FreeCAD.app"])
            finally:
                _run(["hdiutil", "detach", str(mount)])
            return
        archive.chmod(archive.stat().st_mode | 0o111)
        _run([str(archive), "--appimage-extract"], cwd=work)
        extracted = work / "squashfs-root" / "usr"
        if not (extracted / "bin" / "freecadcmd").is_file():
            raise RuntimeError("FreeCAD AppImage extraction has no usr/bin/freecadcmd")
        home = Path(environ.get("HOME", str(Path.home())))
        prefix = home / "opt" / "freecad-1.1.4"
        prefix.parent.mkdir(parents=True, exist_ok=True)
        staged = prefix.with_name(f".{prefix.name}.new-{os.getpid()}")
        shutil.rmtree(staged, ignore_errors=True)
        shutil.copytree(work / "squashfs-root", staged, symlinks=True)
        bin_dir = home / ".local" / "bin"
        bin_dir.mkdir(parents=True, exist_ok=True)
        link = bin_dir / "freecadcmd"
        target = prefix / "squashfs-root" / "usr" / "bin" / "freecadcmd"
        if link.exists() and (not link.is_symlink() or link.resolve() != target.resolve()):
            raise RuntimeError(f"Refusing to replace the existing command path {link}")
        backup = prefix.with_name(f".{prefix.name}.previous-{os.getpid()}")
        try:
            if prefix.exists():
                prefix.rename(backup)
            staged.rename(prefix)
            if not link.is_symlink():
                link.symlink_to(target)
        except OSError:
            if prefix.exists() and backup.exists():
                shutil.rmtree(prefix)
                backup.rename(prefix)
            raise
        else:
            shutil.rmtree(backup, ignore_errors=True)
        print(f"FreeCAD installed under {prefix}; add {bin_dir} to PATH or set FREECADCMD={link}.")


def _install_uv(home: Path, environ: Mapping[str, str]) -> dict[str, str]:
    """Run Astral's official installer from a temporary script file, never from a curl pipe."""
    with tempfile.TemporaryDirectory(prefix="cad-uv-setup-") as temporary:
        installer = Path(temporary) / "install-uv.sh"
        _download(UV_INSTALLER, installer)
        _run(["sh", str(installer)], env={**environ, "HOME": str(home)})
    updated = dict(environ)
    user_bin = home / ".local" / "bin"
    updated["PATH"] = os.pathsep.join([str(user_bin), updated.get("PATH", "")])
    return updated


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
        if link.is_symlink() and link.resolve() != CAD_ROOT.resolve():
            raise RuntimeError(f"Refusing to replace workspace link {link}")
        if link.exists() and not link.is_symlink():
            raise RuntimeError(f"Refusing to replace workspace path {link}")
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
    parser.add_argument("--system", action="store_true", help="also install FreeCAD and Linux system libraries (requires --yes)")
    parser.add_argument("--harness", choices=("opencode", "kiro", "claude"), help="install this harness's files as in cad/README.md")
    args = parser.parse_args(argv)
    if args.system and not args.yes:
        parser.error("--system requires --yes")
    cwd = Path.cwd()
    home = Path(os.environ.get("HOME", str(Path.home())))
    environ = dict(os.environ)
    report = preflight.run_checks(environ, cwd, home, args.harness)
    items = plan(report, cwd, home, environ, args.harness)
    print(render_plan(items, execute=args.yes, system=args.system))
    if not args.yes:
        print("Dry run: no setup actions were executed.")
        return 0

    failures = []
    for item in items:
        if item.id == "uv" and not args.system:
            print("Setup will not execute the downloaded uv installer without --yes --system.", file=sys.stderr)
            failures.append("uv: run setup with --yes --system to approve the official installer")
            continue
        if item.system and not args.system:
            continue
        try:
            if item.id == "uv":
                environ = _install_uv(home, environ)
            elif item.id == "freecad":
                _install_freecad(environ)
            elif item.id == "browser-libraries":
                preflight.install_chromium_system_deps(environ)
            elif item.id == "warm":
                print("Warming runtime environments, Chromium, and the pinned three.js cache...")
                print(preflight.render_text(preflight.warm(environ, cwd, home, args.harness)))
            elif item.id == "formulas":
                _copy_formulas(cwd, environ)
            elif item.id.startswith("harness-"):
                _copy_harness(item.id.removeprefix("harness-"), cwd)
        except (OSError, RuntimeError, subprocess.SubprocessError, urllib.error.URLError) as error:
            failures.append(f"{item.id}: {error}")
            print(f"Failed {item.id}: {error}", file=sys.stderr)

    print("Re-running CAD preflight after setup actions...")
    final_report = preflight.run_checks(environ, cwd, home, args.harness)
    print(preflight.render_text(final_report))
    return int(bool(failures) or final_report.exit_code != 0)


if __name__ == "__main__":
    raise SystemExit(main())
