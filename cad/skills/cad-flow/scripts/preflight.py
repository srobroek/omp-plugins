#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Check the CAD plugin's required local tools and optional harness installation."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any, Mapping, Sequence


CAD_ROOT = Path(__file__).resolve().parents[3]
FREECAD_RUNTIME = CAD_ROOT / "skills" / "cad-drawings" / "scripts"
CONCEPT_SCRIPTS = CAD_ROOT / "skills" / "cad-concept" / "scripts"
RENDERER = CAD_ROOT / "skills" / "cad-render" / "assets" / "renderer"
EXPECTED_TEMPLATES = ("ISO/A4_Landscape_ISO5457_minimal.svg", "ASME/ANSIA_Landscape.svg")
KERNEL_TIMEOUT = 600

sys.path.insert(0, str(FREECAD_RUNTIME))
import freecad_runtime  # noqa: E402


@dataclass(frozen=True)
class Check:
    """One named check and the action that resolves a failure or warning."""

    id: str
    name: str
    status: str
    required: bool
    detail: str
    fix: str
    elapsed_s: float = 0.0

    def __post_init__(self) -> None:
        if self.status not in {"pass", "fail", "warn"}:
            raise ValueError(f"invalid check status: {self.status}")


@dataclass(frozen=True)
class Report:
    checks: tuple[Check, ...]

    @property
    def counts(self) -> dict[str, int]:
        return {status: sum(check.status == status for check in self.checks)
                for status in ("pass", "fail", "warn")}

    @property
    def exit_code(self) -> int:
        return int(any(check.required and check.status != "pass" for check in self.checks))

    @property
    def summary(self) -> str:
        counts = self.counts
        times = ", ".join(f"{check.id} {check.elapsed_s:.1f}s" for check in self.checks)
        return (f"CAD preflight: {counts['pass']} passed, {counts['fail']} failed, "
                f"{counts['warn']} warnings; exit {self.exit_code}. Elapsed: {times}.")

    def as_json(self) -> dict[str, Any]:
        return {"summary": self.summary, "exit_code": self.exit_code, "counts": self.counts,
                "checks": [asdict(check) for check in self.checks]}


def _check(identifier: str, name: str, status: str, detail: str, fix: str,
           required: bool = True, elapsed_s: float = 0.0) -> Check:
    return Check(identifier, name, status, required, detail, fix, elapsed_s)


def _uv_check(environ: Mapping[str, str]) -> tuple[Check, str | None]:
    uv = shutil.which("uv", path=environ.get("PATH"))
    if not uv:
        return (_check("uv", "uv", "fail", "uv was not found on PATH.",
                       "Install uv and ensure its bin directory is on PATH."), None)
    try:
        result = subprocess.run([uv, "--version"], capture_output=True, text=True, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        return (_check("uv", "uv", "fail", f"Could not run {uv}: {error}.",
                       "Install or repair uv, then ensure its bin directory is on PATH."), None)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip() or f"uv exited {result.returncode}"
        return (_check("uv", "uv", "fail", detail, "Repair the uv installation and retry."), None)
    return (_check("uv", "uv", "pass", result.stdout.strip(), ""), uv)


def _script_probe(uv: str, name: str, runner: Path, module: str, expected: str,
                 distribution: str | None = None, timeout: int = 300, sync_timeout: int = 1800,
                 fix: str | None = None, chromium: bool = False) -> Check:
    """Sync a runner's uv environment and import with its selected interpreter."""
    guidance = fix or f"Resolve the {name} dependency environment used by {runner.name}, then retry."
    try:
        synced = subprocess.run([uv, "sync", "--script", str(runner)], capture_output=True, text=True,
                                timeout=sync_timeout, check=False)
    except subprocess.TimeoutExpired:
        return _check(name, name, "fail", f"uv sync --script {runner.name} timed out after {sync_timeout}s.", guidance)
    except OSError as error:
        return _check(name, name, "fail", f"Could not sync {runner.name}: {error}.", guidance)
    if synced.returncode != 0:
        reason = (synced.stderr or synced.stdout).strip().splitlines()
        detail = reason[-1] if reason else f"uv sync exited {synced.returncode}"
        return _check(name, name, "fail", f"Could not prepare {runner.name}: {detail}.", guidance)
    try:
        found = subprocess.run([uv, "python", "find", "--script", str(runner)], capture_output=True,
                               text=True, timeout=30, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        return _check(name, name, "fail", f"Could not find {runner.name}'s Python: {error}.", guidance)
    if found.returncode != 0 or not found.stdout.strip():
        reason = (found.stderr or found.stdout).strip().splitlines()
        detail = reason[-1] if reason else f"uv python find exited {found.returncode}"
        return _check(name, name, "fail", f"Could not locate {runner.name}'s Python: {detail}.", guidance)
    python = found.stdout.strip()
    distribution = distribution or module
    if chromium:
        code = ("import importlib.metadata, json\nfrom pathlib import Path\n"
                "from playwright.sync_api import sync_playwright\n"
                "with sync_playwright() as p:\n"
                f" version = importlib.metadata.version({distribution!r})\n"
                " print('CAD_PREFLIGHT:' + json.dumps({'version': version, 'path': p.chromium.executable_path, "
                "'exists': Path(p.chromium.executable_path).is_file()}))\n")
    else:
        code = (f"import importlib.metadata, json, {module}\n"
                f"print('CAD_PREFLIGHT:' + json.dumps(importlib.metadata.version({distribution!r})))\n")
    try:
        result = subprocess.run([python, "-c", code], capture_output=True, text=True,
                                timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        return _check(name, name, "fail", f"Importing {module} timed out after {timeout}s.", guidance)
    except OSError as error:
        return _check(name, name, "fail", f"Could not run {runner.name}'s Python: {error}.", guidance)
    marker = next((line.removeprefix("CAD_PREFLIGHT:") for line in result.stdout.splitlines()
                   if line.startswith("CAD_PREFLIGHT:")), None)
    if result.returncode != 0 or marker is None:
        reason = (result.stderr or result.stdout).strip().splitlines()
        detail = reason[-1] if reason else f"Python probe exited {result.returncode} without a result"
        return _check(name, name, "fail", f"The {module} import failed: {detail}.", guidance)
    try:
        version = json.loads(marker)
    except json.JSONDecodeError:
        version = marker
    if chromium:
        if version.get("version") != expected:
            return _check(name, name, "fail", f"Imported playwright {version.get('version')}; expected {expected}.", guidance)
        if not version.get("exists"):
            return _check(name, name, "fail", f"Chromium executable is missing at {version.get('path')}.", guidance)
        return _check(name, name, "pass", f"Playwright {expected} Chromium executable exists at {version['path']}.", "")
    if version != expected:
        return _check(name, name, "fail", f"Imported {module} {version}; expected {expected}.", guidance)
    return _check(name, name, "pass", f"{module} {version} imports from {runner.name}'s uv environment.", "")



def _ocp_viewer_check(uv: str) -> Check:
    runner = CAD_ROOT / "skills" / "cad-viewer" / "scripts" / "viewer.py"
    return _script_probe(uv, "ocp-viewer", runner, "ocp_viewer", "1.2.0",
                         timeout=300, sync_timeout=1800)






def _timed_freecad_checks(environ: Mapping[str, str]) -> list[Check]:
    checks: list[Check] = []
    started = time.monotonic()
    print("[preflight] freecad-command: checking...", file=sys.stderr, flush=True)
    command = freecad_runtime.find_freecadcmd(environ)
    found = command is not None and command.is_file() and os.access(command, os.X_OK)
    detail = f"FreeCAD command: {command}" if found else (
        f"Configured FreeCAD command is missing or not executable: {command}." if command else
        "FreeCAD 1.1.4 freecadcmd was not found via FREECADCMD, PATH, or the macOS app.")
    fix = ("Install FreeCAD 1.1.4; set FREECADCMD to its freecadcmd executable or add freecadcmd to PATH. "
           "See cad-drawings/SKILL.md for macOS and Linux install steps.")
    command_check = _check("freecad-command", "FreeCAD command", "pass" if found else "fail", detail,
                           "" if found else fix)
    checks.append(replace(command_check, elapsed_s=time.monotonic() - started))
    print(f"[preflight] freecad-command: {checks[-1].status} ({checks[-1].elapsed_s:.1f}s)",
          file=sys.stderr, flush=True)

    started = time.monotonic()
    print("[preflight] freecad-version: checking...", file=sys.stderr, flush=True)
    version: str | None = None
    detail = "FreeCAD command unavailable."
    if found and command:
        try:
            with tempfile.TemporaryDirectory(prefix="cad-preflight-freecad-") as temporary:
                result_file = Path(temporary) / "version.json"
                script = Path(temporary) / "version.py"
                script.write_text("import FreeCAD as App, json\n"
                                  f"open({str(result_file)!r}, 'w', encoding='utf-8').write(json.dumps(App.Version()))\n",
                                  encoding="utf-8")
                result = subprocess.run([str(command), str(script)], capture_output=True, text=True,
                                        timeout=90, check=False, env=dict(environ))
                if result.returncode == 0 and result_file.is_file():
                    version = ".".join(str(part) for part in json.loads(result_file.read_text())[:3])
                    detail = f"FreeCAD reported {version}."
                else:
                    lines = (result.stderr or result.stdout).strip().splitlines()
                    detail = lines[-1] if lines else "freecadcmd produced no version result."
        except (OSError, subprocess.TimeoutExpired, ValueError, json.JSONDecodeError) as error:
            detail = f"Could not query FreeCAD version: {error}."
    version_check = _check("freecad-version", "FreeCAD version", "pass" if version == "1.1.4" else "fail",
                           detail if version == "1.1.4" else detail + " Required version is 1.1.4.", fix)
    checks.append(replace(version_check, elapsed_s=time.monotonic() - started))
    print(f"[preflight] freecad-version: {checks[-1].status} ({checks[-1].elapsed_s:.1f}s)",
          file=sys.stderr, flush=True)

    started = time.monotonic()
    print("[preflight] techdraw-templates: checking...", file=sys.stderr, flush=True)
    templates = freecad_runtime.templates_dir(command)
    missing = [item for item in EXPECTED_TEMPLATES if not (templates / item).is_file()]
    okay = bool(found and not missing)
    detail = (f"Missing TechDraw templates under {templates}: {', '.join(missing)}." if missing else
              f"TechDraw templates found in {templates}: {', '.join(EXPECTED_TEMPLATES)}.")
    template_check = _check("techdraw-templates", "TechDraw templates", "pass" if okay else "fail", detail,
                            "Install the complete FreeCAD 1.1.4 bundle; TechDraw templates must be beside freecadcmd.")
    checks.append(replace(template_check, elapsed_s=time.monotonic() - started))
    print(f"[preflight] techdraw-templates: {checks[-1].status} ({checks[-1].elapsed_s:.1f}s)",
          file=sys.stderr, flush=True)
    return checks
def _vendor_check(environ: Mapping[str, str]) -> Check:
    # The cad-render import map is authoritative; check every SRI-pinned path it can request.
    sys.path.insert(0, str(CONCEPT_SCRIPTS))
    try:
        import serve as concept_serve

        integrity = concept_serve.vendor_integrity(RENDERER / "index.html")
        cache_home = Path(environ.get("XDG_CACHE_HOME") or
                          (Path(environ.get("HOME", str(Path.home()))) / ".cache"))
        cache = cache_home / "cad-concept" / "vendor"
        missing = []
        invalid = []
        for url, digest in integrity.items():
            path = cache / url.removeprefix("/vendor/")
            if not path.is_file():
                missing.append(url)
            elif not concept_serve.sri_matches(path.read_bytes(), digest):
                invalid.append(url)
        if not missing and not invalid:
            return _check("three-vendor-cache", "Pinned three.js vendor cache", "pass",
                          f"All {len(integrity)} modules from cad-render's import map match their SRI digests in {cache}.", "")
        problems = []
        if missing:
            problems.append(f"{len(missing)} missing module(s)")
        if invalid:
            problems.append(f"{len(invalid)} module(s) fail SRI verification")
        detail = f"{', '.join(problems)} in {cache}; the cad-render import map pins {len(integrity)} modules."
    except (OSError, ValueError, json.JSONDecodeError) as error:
        detail = f"Could not verify cad-render's three.js cache: {error}."
    return _check("three-vendor-cache", "Pinned three.js vendor cache", "fail", detail,
                  "Run a cad-render render once with network access to fill the pinned cache, then retry.")


def _beads_check(cwd: Path, environ: Mapping[str, str]) -> Check:
    bd = shutil.which("bd", path=environ.get("PATH"))
    workspace = Path(environ["BEADS_DIR"]) if environ.get("BEADS_DIR") else next(
        (parent / ".beads" for parent in (cwd, *cwd.parents) if (parent / ".beads").is_dir()), None)
    has_workspace = workspace is not None and workspace.is_dir()
    if bd and has_workspace:
        return _check("beads", "Beads", "pass", f"bd at {bd}; workspace at {workspace}.", "", required=False)
    absent = []
    if not bd:
        absent.append("bd is not on PATH")
    if not has_workspace:
        absent.append("no .beads workspace was found from the current directory or BEADS_DIR")
    return _check("beads", "Beads", "warn", "; ".join(absent) + ".",
                  "Install bd and initialize a Beads workspace if using the workflow formulas and approval gates.",
                  required=False)


def _plugin_named(value: Any) -> bool:
    if isinstance(value, dict):
        names = [value.get(key) for key in ("name", "id", "plugin", "package")]
        matches = any(isinstance(name, str) and (name == "cad" or name.startswith("cad@")
                                                  or name.endswith("/cad")) for name in names)
        install_path = value.get("installPath") or value.get("path")
        if matches and install_path is not None:
            return Path(str(install_path)).exists()
        return matches or any(_plugin_named(child) for child in value.values())
    if isinstance(value, list):
        return any(_plugin_named(child) for child in value)
    return False


def _harness_check(harness: str, cwd: Path, home: Path, environ: Mapping[str, str]) -> Check:
    if harness == "opencode":
        skills = sorted(path.name for path in (cwd / ".opencode" / "skills").glob("cad-*") if path.is_dir())
        agents = sorted(path.name for path in (cwd / ".opencode" / "agents").glob("cad-*"))
        present = bool(skills and agents)
        detail = f"Found {len(skills)} cad-* skill(s) and {len(agents)} cad-* agent(s) under .opencode/."
        fix = "Copy the generated cad skills and agents into .opencode/skills/ and .opencode/agents/ as in cad/README.md."
    elif harness == "kiro":
        agents_dir = cwd / ".kiro" / "agents"
        agents = sorted(agents_dir.glob("cad-*.json")) if agents_dir.is_dir() else []
        link = cwd / "cad"
        linked = link.is_dir() and (link / "skills").is_dir()
        present = bool(agents and linked)
        detail = f"Found {len(agents)} cad reviewer agent(s) in .kiro/agents; cad link {'is' if linked else 'is not'} present."
        fix = "Link the plugin to workspace cad/ and copy harness/kiro/agents/*.json to .kiro/agents/ as in cad/README.md."
    elif harness == "claude":
        claude_home = Path(environ.get("CLAUDE_CONFIG_DIR") or (home / ".claude"))
        settings = (cwd / ".claude" / "settings.json", cwd / ".claude" / "settings.local.json",
                    claude_home / "settings.json", claude_home / "settings.local.json")
        enabled = False
        for path in settings:
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            enabled_plugins = data.get("enabledPlugins", {}) if isinstance(data, dict) else {}
            enabled |= isinstance(enabled_plugins, dict) and any(
                str(key).startswith("cad@") and value is True for key, value in enabled_plugins.items())
        cache = claude_home / "plugins" / "cache"
        cached = any((path / "plugin.json").is_file() for path in cache.glob("**/cad/**")) if cache.exists() else False
        present = enabled or cached
        detail = "Claude Code cad plugin is enabled or cached." if present else "Claude Code cad plugin enablement/cache was not detected."
        fix = "Install or load the cad plugin with `claude plugin install cad@srobroek-omp` (or `--plugin-dir` for a checkout)."
    else:
        omp = shutil.which("omp", path=environ.get("PATH"))
        present = False
        detail = "OMP plugin was not detected."
        if omp:
            try:
                result = subprocess.run([omp, "plugin", "list", "--json"], capture_output=True, text=True,
                                        timeout=15, check=False, cwd=cwd, env=dict(environ))
                if result.returncode == 0:
                    present = _plugin_named(json.loads(result.stdout))
                    detail = "OMP cad plugin is present in `omp plugin list --json`." if present else \
                        "OMP plugin list did not report an installed cad plugin."
                else:
                    detail = "Could not read `omp plugin list --json`; OMP plugin state is unknown."
            except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
                detail = "Could not read `omp plugin list --json`; OMP plugin state is unknown."
        fix = "Install the cad plugin from its marketplace with `omp plugin install cad@srobroek-omp`."
    return _check(f"harness-{harness}", f"{harness.title()} installation", "pass" if present else "warn",
                  detail, "" if present else fix, required=False)


def _run_uv_check(environ: Mapping[str, str]) -> tuple[Check, str | None]:
    print("[preflight] uv: checking...", file=sys.stderr, flush=True)
    started = time.monotonic()
    check, uv = _uv_check(environ)
    elapsed = time.monotonic() - started
    check = replace(check, elapsed_s=elapsed)
    print(f"[preflight] uv: {check.status} ({elapsed:.1f}s)", file=sys.stderr, flush=True)
    return check, uv


def _run_check(name: str, function: Any) -> Check:
    print(f"[preflight] {name}: checking...", file=sys.stderr, flush=True)
    started = time.monotonic()
    try:
        check = function()
    except (OSError, ValueError, json.JSONDecodeError) as error:
        check = _check(name, name, "fail", f"Check failed unexpectedly: {error}.", "Review the reported error and retry.")
    elapsed = time.monotonic() - started
    check = replace(check, elapsed_s=elapsed)
    print(f"[preflight] {name}: {check.status} ({elapsed:.1f}s)", file=sys.stderr, flush=True)
    return check


def run_checks(environ: Mapping[str, str] | None = None, cwd: Path | None = None,
               home: Path | None = None, harness: str | None = None) -> Report:
    env = os.environ if environ is None else environ
    workdir = cwd or Path.cwd()
    home_dir = home or Path(env.get("HOME", str(Path.home())))
    checks: list[Check] = []
    uv_check, uv = _run_uv_check(env)
    checks.append(uv_check)
    checks.extend(_timed_freecad_checks(env))
    if uv:
        probes = (
            ("cadquery", lambda: _script_probe(uv, "cadquery", CAD_ROOT / "skills" / "cad-model" / "scripts" / "run_cadquery.py",
                                                "cadquery", "2.8.0", timeout=300, sync_timeout=1800)),
            ("build123d", lambda: _script_probe(uv, "build123d", CAD_ROOT / "skills" / "cad-model" / "scripts" / "run_build123d.py",
                                                 "build123d", "0.13.0", timeout=300, sync_timeout=1800)),
            ("playwright-chromium", lambda: _chromium_check(uv)),
            ("ocp-viewer", lambda: _ocp_viewer_check(uv)),
        )
        checks.extend(_run_check(name, probe) for name, probe in probes)
    else:
        checks.extend(_run_check(name, lambda name=name: _check(
            name, name, "fail", "Cannot resolve this environment because uv is unavailable.",
            "Install uv and ensure its bin directory is on PATH."))
                      for name in ("cadquery", "build123d", "playwright-chromium", "ocp-viewer"))
    checks.append(_run_check("three-vendor-cache", lambda: _vendor_check(env)))
    checks.append(_run_check("beads", lambda: _beads_check(workdir, env)))
    harnesses = (harness,) if harness else ("omp", "claude", "opencode", "kiro")
    checks.extend(_run_check(f"harness-{name}", lambda name=name: _harness_check(name, workdir, home_dir, env))
                  for name in harnesses)
    return Report(tuple(checks))


def render_text(report: Report) -> str:
    lines = [report.summary]
    for check in report.checks:
        label = check.status.upper()
        requirement = "required" if check.required else "optional"
        lines.append(f"{label} [{requirement}] {check.name}: {check.detail}")
        if check.status != "pass" and check.fix:
            lines.append(f"  Fix: {check.fix}")
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="print the complete report as JSON")
    parser.add_argument("--harness", choices=("omp", "claude", "opencode", "kiro"),
                        help="check only this harness (default: check all harnesses)")
    args = parser.parse_args(argv)
    report = run_checks(harness=args.harness)
    if args.json:
        print(json.dumps(report.as_json(), indent=2))
    else:
        print(render_text(report))
    return report.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
