#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Check the CAD plugin's required local tools and optional harness installation.

`--warm` also fetches what the checks need (Playwright Chromium, the pinned three.js modules), and
its checks first-load every runtime environment, so the first build afterwards starts warm. Each
warm-up records its progress and report for this plugin copy. `--background` starts one in a
detached process and returns at once; `--status [--wait SECONDS]` reports on the last one.
"""

from __future__ import annotations
import re

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence


CAD_ROOT = Path(__file__).resolve().parents[3]
SKILLS = CAD_ROOT / "skills"
FREECAD_RUNTIME = SKILLS / "cad-drawings" / "scripts"
CONCEPT_SCRIPTS = SKILLS / "cad-concept" / "scripts"
MODEL_SCRIPTS = SKILLS / "cad-model" / "scripts"
RENDERER = SKILLS / "cad-render" / "assets" / "renderer"
EXPECTED_TEMPLATES = ("ISO/A4_Landscape_ISO5457_minimal.svg", "ASME/ANSIA_Landscape.svg")
SYNC_TIMEOUT = 1800  # resolve and install an environment from scratch
IMPORT_TIMEOUT = 1800  # a cold first OCP load on a busy Mac has taken over 1100 s
STARTUP_TIMEOUT = 60  # a background warm-up records itself as running within this
EXIT_NO_WARM = 2  # --status: no warm-up recorded, or it stopped without a report
EXIT_RUNNING = 3  # --status: the warm-up is still running

@dataclass(frozen=True)
class CadTool:
    name: str
    required_version: str
    lookup_candidates: tuple[tuple[str, str], ...]
    version_args: tuple[str, ...]
    version_pattern: str
    download_url: str


CAD_TOOL = CadTool(
    name="FreeCAD",
    required_version="1.1.4",
    lookup_candidates=(
        ("environment", "FREECADCMD"),
        ("path", "freecadcmd"),
        ("path", "FreeCADCmd"),
        ("macos", "/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd"),
        ("home", ".local/bin/freecadcmd"),
    ),
    version_args=("--version",),
    version_pattern=r"FreeCAD\s+(\d+\.\d+\.\d+)",
    download_url="https://github.com/FreeCAD/FreeCAD/releases/tag/1.1.4",
)

sys.path.insert(0, str(FREECAD_RUNTIME))
sys.path.insert(0, str(MODEL_SCRIPTS))
import freecad_runtime  # noqa: E402
from cadmodel import scriptenv  # noqa: E402 - standard library only


@dataclass(frozen=True)
class Runtime:
    """One environment a CAD script runs in, and the imports that first-load it."""

    id: str
    script: Path  # the PEP 723 script whose header defines the environment
    imports: tuple[str, ...]
    distribution: str  # its version must equal the header's pin

# Every PEP 723 script environment is shared by dependency set through cadmodel.scriptenv.
RUNTIMES = (
    Runtime("cadquery", MODEL_SCRIPTS / "run_cadquery.py", ("cadquery",), "cadquery"),
    Runtime("build123d", MODEL_SCRIPTS / "run_build123d.py", ("build123d",), "build123d"),
    Runtime("cad-model", MODEL_SCRIPTS / "cad_model.py", ("OCP", "trimesh", "yaml"), "cadquery-ocp-novtk"),
    Runtime("ocp-viewer", SKILLS / "cad-viewer" / "scripts" / "viewer.py", ("ocp_viewer",), "ocp_viewer"),
)
CHROMIUM = Runtime("playwright-chromium", SKILLS / "cad-render" / "scripts" / "render.py", ("playwright",),
                   "playwright")


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


def _last_line(result: subprocess.CompletedProcess[str], fallback: str) -> str:
    lines = (result.stderr or result.stdout).strip().splitlines()
    return lines[-1] if lines else fallback


def _run(argv: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
    """Run argv to completion; RuntimeError says why it did not succeed."""
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f"timed out after {timeout}s") from error
    except OSError as error:
        raise RuntimeError(f"could not start {argv[0]}: {error}") from error
    if result.returncode != 0:
        raise RuntimeError(_last_line(result, f"{Path(argv[0]).name} exited {result.returncode}"))
    return result


def _environment(uv: str, runtime: Runtime) -> tuple[list[str], int]:
    """argv prefix running Python in the environment shared by the script's dependency set."""
    return scriptenv.python_command(runtime.script, uv=uv), SYNC_TIMEOUT + IMPORT_TIMEOUT


def _python(environment: tuple[list[str], int], code: str) -> Any:
    """Run `code` in a prepared environment; return the JSON it printed after `CAD_PREFLIGHT:`."""
    prefix, timeout = environment
    result = _run([*prefix, "-c", code], timeout)
    marker = next((line.removeprefix("CAD_PREFLIGHT:") for line in result.stdout.splitlines()
                   if line.startswith("CAD_PREFLIGHT:")), None)
    if marker is None:
        raise RuntimeError("Python printed no result")
    return json.loads(marker)


def _where(module_file: str) -> str:
    site = next((parent for parent in Path(module_file).parents if parent.name == "site-packages"),
                Path(module_file).parent)
    return f"{site} (environment shared by dependency set)"


def _runtime_check(uv: str, runtime: Runtime) -> Check:
    """Prepare `runtime`'s environment and import its modules there: the first load a build would pay."""
    name = runtime.id
    guidance = (f"Resolve the {name} environment of {runtime.script.name} (the first run needs network "
                "access), then rerun preflight.")
    expected = scriptenv.pinned(runtime.script, runtime.distribution)
    code = (f"import importlib.metadata, json, sys\nimport {', '.join(runtime.imports)}\n"
            f"print('CAD_PREFLIGHT:' + json.dumps({{'version': importlib.metadata.version({runtime.distribution!r}), "
            f"'file': sys.modules[{runtime.imports[0]!r}].__file__}}))\n")
    try:
        found = _python(_environment(uv, runtime), code)
    except RuntimeError as error:
        if name == "cad-model" and "cannot open shared object file" in str(error):
            guidance = ("OCP is missing a system shared library. On Linux, install "
                        "`libglvnd-glx`, `libX11`, and `expat` (for example: "
                        "`dnf install libglvnd-glx libX11 expat`), then rerun preflight.")
        return _check(name, name, "fail", f"{', '.join(runtime.imports)} did not import in the environment of "
                      f"{runtime.script.name}: {error}.", guidance)
    if found["version"] != expected:
        return _check(name, name, "fail", f"{runtime.distribution} {found['version']} imported; "
                      f"{runtime.script.name} pins {expected}.", guidance)
    return _check(name, name, "pass", f"{runtime.distribution} {expected} imports from "
                  f"{_where(found['file'])}.", "")


def _chromium_check(uv: str, install: bool = False) -> Check:
    """Launch headless Chromium through cad-render's Playwright; with `install`, install it first."""
    name = CHROMIUM.id
    guidance = "Run `preflight.py --warm` with network access to install Playwright Chromium, then rerun preflight."
    expected = scriptenv.pinned(CHROMIUM.script, CHROMIUM.distribution)
    try:
        environment = _environment(uv, CHROMIUM)
        if install:
            _run([*environment[0], "-m", "playwright", "install", "chromium"], SYNC_TIMEOUT)
        found = _python(environment,
                        "import importlib.metadata, json\nfrom playwright.sync_api import sync_playwright\n"
                        "with sync_playwright() as p:\n"
                        "    browser = p.chromium.launch(headless=True)\n"
                        "    print('CAD_PREFLIGHT:' + json.dumps({'version': importlib.metadata.version('playwright'), "
                        "'chromium': browser.version, 'path': p.chromium.executable_path}))\n"
                        "    browser.close()\n")
    except RuntimeError as error:
        action = "Installing and launching" if install else "Launching"
        return _check(name, "Playwright Chromium", "fail", f"{action} Chromium failed: {error}.", guidance)
    if found["version"] != expected:
        return _check(name, "Playwright Chromium", "fail",
                      f"playwright {found['version']} imported; {CHROMIUM.script.name} pins {expected}.", guidance)
    return _check(name, "Playwright Chromium", "pass",
                  f"Playwright {expected} launches Chromium {found['chromium']} ({found['path']}).", "")


def _find_freecadcmd(environ: Mapping[str, str], home: Path | None = None,
                     platform_name: str | None = None,
                     macos_command: Path | None = None) -> Path | None:
    """Resolve FreeCAD using CAD_TOOL's ordered authoritative candidate list."""
    home_dir = home or Path(environ.get("HOME", str(Path.home())))
    for kind, value in CAD_TOOL.lookup_candidates:
        if kind == "environment":
            configured = environ.get(value)
            if configured:
                return Path(configured)
        elif kind == "path":
            found = shutil.which(value, path=environ.get("PATH"))
            if found:
                return Path(found)
        elif kind == "macos" and (platform_name or sys.platform) == "darwin":
            command = macos_command or Path(value)
            if command.is_file():
                return command
        elif kind == "home":
            command = home_dir / value
            if command.is_file() and os.access(command, os.X_OK):
                return command
    return None


def find_freecadcmd(environ: Mapping[str, str], home: Path | None = None,
                    platform_name: str | None = None,
                    macos_command: Path | None = None) -> Path | None:
    """Resolve FreeCAD through the authoritative runtime lookup."""
    return _find_freecadcmd(environ, home, platform_name, macos_command)


def cad_tool_version(command: Path, environ: Mapping[str, str]) -> tuple[str | None, str]:
    """Probe the configured CAD tool and return its parsed version and command output."""
    try:
        result = subprocess.run([str(command), *CAD_TOOL.version_args], capture_output=True, text=True,
                                timeout=90, check=False, env=dict(environ))
    except (OSError, subprocess.SubprocessError) as error:
        return None, f"Could not query {CAD_TOOL.name} version: {error}."
    output = result.stdout + result.stderr
    match = re.search(CAD_TOOL.version_pattern, output)
    version = match.group(1) if result.returncode == 0 and match else None
    return version, output.strip() or f"freecadcmd exited {result.returncode}."


def _timed_freecad_checks(environ: Mapping[str, str], home: Path | None = None) -> list[Check]:
    tool = CAD_TOOL
    checks: list[Check] = []
    started = time.monotonic()
    print("[preflight] freecad-command: checking...", file=sys.stderr, flush=True)
    command = find_freecadcmd(environ, home)
    found = command is not None and command.is_file() and os.access(command, os.X_OK)
    detail = f"{tool.name} command: {command}" if found else f"{tool.name} {tool.required_version} freecadcmd was not found."
    lookup_labels = {
        "environment": lambda value: value,
        "path": lambda _: "PATH",
        "macos": lambda _: "the macOS app bundle",
        "home": lambda value: f"~/{value}",
    }
    lookup = ", ".join(dict.fromkeys(lookup_labels[kind](value) for kind, value in tool.lookup_candidates))
    fix = f"Install {tool.name} {tool.required_version} from {tool.download_url}; lookup order: {lookup}."
    checks.append(replace(_check("freecad-command", f"{tool.name} command", "pass" if found else "fail",
                                 detail, "" if found else fix), elapsed_s=time.monotonic() - started))
    print(f"[preflight] freecad-command: {checks[-1].status} ({checks[-1].elapsed_s:.1f}s)", file=sys.stderr, flush=True)

    started = time.monotonic()
    version: str | None = None
    detail = "FreeCAD command unavailable."
    if found and command:
        version, detail = cad_tool_version(command, environ)
    fix = f"Install {tool.name} {tool.required_version} from {tool.download_url}; lookup order: {lookup}."
    checks.append(replace(_check("freecad-version", f"{tool.name} version",
                                 "pass" if version == tool.required_version else "fail",
                                 detail if version == tool.required_version else
                                 detail + f" Required version is {tool.required_version}.",
                                 "" if version == tool.required_version else fix),
                          elapsed_s=time.monotonic() - started))
    if not found:
        return checks

    started = time.monotonic()
    print("[preflight] techdraw-templates: checking...", file=sys.stderr, flush=True)
    templates = freecad_runtime.templates_dir(command)
    missing = [item for item in EXPECTED_TEMPLATES if not (templates / item).is_file()]
    okay = not missing
    detail = (f"Missing TechDraw templates under {templates}: {', '.join(missing)}." if missing else
              f"TechDraw templates found in {templates}: {', '.join(EXPECTED_TEMPLATES)}.")
    template_fix = f"Install the complete {tool.name} {tool.required_version} bundle; TechDraw templates must be beside freecadcmd."
    checks.append(replace(_check("techdraw-templates", "TechDraw templates", "pass" if okay else "fail", detail,
                                 "" if okay else template_fix), elapsed_s=time.monotonic() - started))
    print(f"[preflight] techdraw-templates: {checks[-1].status} ({checks[-1].elapsed_s:.1f}s)", file=sys.stderr, flush=True)
    return checks


def _cache_home(environ: Mapping[str, str]) -> Path:
    return Path(environ.get("XDG_CACHE_HOME") or (Path(environ.get("HOME", str(Path.home()))) / ".cache"))


def _vendor_check(environ: Mapping[str, str], fill: bool = False) -> Check:
    # The cad-render import map is authoritative; check every SRI-pinned path it can request.
    sys.path.insert(0, str(CONCEPT_SCRIPTS))
    try:
        import serve as concept_serve

        integrity = concept_serve.vendor_integrity(RENDERER / "index.html")
        cache = _cache_home(environ) / "cad-concept" / "vendor"
        if fill:  # fetch each missing or mismatched module once, verified against its digest
            vendor = concept_serve.VendorCache(cache, integrity)
            for url in integrity:
                vendor.get(url)
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
        detail = f"Could not {'fill' if fill else 'verify'} cad-render's three.js cache: {error}."
    return _check("three-vendor-cache", "Pinned three.js vendor cache", "fail", detail,
                  "Run `preflight.py --warm` with network access to fill the pinned cache, then retry.")


def beads_workspace(cwd: Path, environ: Mapping[str, str]) -> Path | None:
    """Find the Beads workspace used by the preflight and setup commands."""
    workspace = Path(environ["BEADS_DIR"]) if environ.get("BEADS_DIR") else next(
        (parent / ".beads" for parent in (cwd, *cwd.parents) if (parent / ".beads").is_dir()), None)
    return workspace if workspace is not None and workspace.is_dir() else None


def _beads_check(cwd: Path, environ: Mapping[str, str]) -> Check:
    bd = shutil.which("bd", path=environ.get("PATH"))
    workspace = beads_workspace(cwd, environ)
    has_workspace = workspace is not None
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
               home: Path | None = None, harness: str | None = None, warm: bool = False,
               cad_checks: Sequence[Check] | None = None) -> Report:
    """Run checks, beginning with the CAD tool needed by every other operation."""
    env = os.environ if environ is None else environ
    workdir = cwd or Path.cwd()
    home_dir = home or Path(env.get("HOME", str(Path.home())))
    checks = list(cad_checks if cad_checks is not None else _timed_freecad_checks(env, home_dir))
    if any(check.status != "pass" for check in checks):
        return Report(tuple(checks))
    uv_check, uv = _run_uv_check(env)
    checks.append(uv_check)
    if uv:
        checks.extend(_run_check(runtime.id, lambda runtime=runtime: _runtime_check(uv, runtime))
                      for runtime in RUNTIMES)
        checks.append(_run_check(CHROMIUM.id, lambda: _chromium_check(uv, install=warm)))
    else:
        checks.extend(_run_check(name, lambda name=name: _check(
            name, name, "fail", "Cannot resolve this environment because uv is unavailable.",
            "Install uv and ensure its bin directory is on PATH."))
                      for name in (*(runtime.id for runtime in RUNTIMES), CHROMIUM.id))
    checks.append(_run_check("three-vendor-cache", lambda: _vendor_check(env, fill=warm)))
    checks.append(_run_check("beads", lambda: _beads_check(workdir, env)))
    harnesses = (harness,) if harness else ("omp", "claude", "opencode", "kiro")
    checks.extend(_run_check(f"harness-{name}", lambda name=name: _harness_check(name, workdir, home_dir, env))
                  for name in harnesses)
    return Report(tuple(checks))


def warm_record_path(environ: Mapping[str, str]) -> Path:
    """Where the warm-ups of this plugin copy record their state; its environments are this copy's."""
    key = hashlib.sha256(str(CAD_ROOT).encode("utf-8")).hexdigest()[:16]
    return _cache_home(environ) / "cad-flow" / "warm" / f"{key}.json"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _write_record(path: Path, record: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}")
    temporary.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def _read_record(path: Path) -> dict[str, Any] | None:
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return record if isinstance(record, dict) else None


def _alive(pid: Any) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def warm(environ: Mapping[str, str] | None = None, cwd: Path | None = None, home: Path | None = None,
         harness: str | None = None) -> Report:
    """`run_checks(warm=True)`, recorded as running and then with its report for `--status`."""
    env = os.environ if environ is None else environ
    path = warm_record_path(env)
    running = {"state": "running", "pid": os.getpid(), "plugin": str(CAD_ROOT), "started_at": _now()}
    _write_record(path, running)
    report = run_checks(env, cwd, home, harness, warm=True)
    _write_record(path, {**running, "state": "finished", "finished_at": _now(), "report": report.as_json()})
    return report


def start_background(environ: Mapping[str, str] | None = None, harness: str | None = None) -> dict[str, Any]:
    """Start `--warm` in its own session, detached from the caller's shell, and return once it has
    recorded itself as running; a warm-up of this plugin copy that is still running is reused."""
    env = os.environ if environ is None else environ
    path = warm_record_path(env)
    log = path.with_suffix(".log")
    record = _read_record(path)
    if record and record.get("state") == "running" and _alive(record.get("pid")):
        return {"started": False, "pid": record["pid"], "record": str(path), "log": str(log)}
    path.parent.mkdir(parents=True, exist_ok=True)
    command = [sys.executable, str(Path(__file__).resolve()), "--warm", *(["--harness", harness] if harness else [])]
    with log.open("w", encoding="utf-8") as output:
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                                 start_new_session=True, env=dict(env))
    deadline = time.monotonic() + STARTUP_TIMEOUT
    while time.monotonic() < deadline:
        record = _read_record(path)
        if record and record.get("pid") == child.pid:
            return {"started": True, "pid": child.pid, "record": str(path), "log": str(log)}
        if child.poll() is not None:
            break
        time.sleep(0.1)
    returncode = child.poll()
    error = (f"it exited {returncode} before recording itself" if returncode is not None
             else f"it has not recorded itself after {STARTUP_TIMEOUT}s")
    return {"started": False, "pid": child.pid, "record": str(path), "log": str(log), "error": error}


def warm_status(environ: Mapping[str, str] | None = None, wait_s: float = 0.0) -> tuple[int, str]:
    """Exit code and text for the last warm-up of this plugin copy, waiting up to `wait_s` for a
    running one: 0 passed, 1 a required check failed, EXIT_NO_WARM none or it died, EXIT_RUNNING."""
    env = os.environ if environ is None else environ
    path = warm_record_path(env)
    log = path.with_suffix(".log")
    deadline = time.monotonic() + max(wait_s, 0.0)
    while True:
        record = _read_record(path)
        if record is None:
            return EXIT_NO_WARM, (f"No warm-up is recorded for {CAD_ROOT} ({path}). "
                                  "Run `preflight.py --warm` in the foreground.")
        if record.get("state") == "finished":
            report = Report(tuple(Check(**check) for check in record["report"]["checks"]))
            return report.exit_code, (f"Warm-up finished at {record.get('finished_at')} "
                                      f"(started {record.get('started_at')}).\n{render_text(report)}")
        if not _alive(record.get("pid")):
            return EXIT_NO_WARM, (f"The warm-up started at {record.get('started_at')} (pid {record.get('pid')}) "
                                  f"stopped without a report; see {log}. Run `preflight.py --warm` in the foreground.")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return EXIT_RUNNING, (f"The warm-up started at {record.get('started_at')} (pid {record['pid']}) is still "
                                  f"running; progress is in {log}.")
        time.sleep(min(2.0, remaining))


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
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--json", action="store_true", help="print the complete report as JSON")
    parser.add_argument("--harness", choices=("omp", "claude", "opencode", "kiro"),
                        help="check only this harness (default: check all harnesses)")
    parser.add_argument("--warm", action="store_true",
                        help="also install Playwright Chromium and fill the three.js cache; record the run for --status")
    parser.add_argument("--background", action="store_true",
                        help="with --warm: run the warm-up in a detached process and return once it is running")
    parser.add_argument("--status", action="store_true",
                        help="report the last warm-up of this plugin copy: exit 0 passed, 1 a required check "
                             f"failed, {EXIT_NO_WARM} none recorded or it died, {EXIT_RUNNING} still running")
    parser.add_argument("--wait", type=float, default=0.0, metavar="SECONDS",
                        help="with --status: wait up to SECONDS for a running warm-up to finish")
    args = parser.parse_args(argv)
    if args.background and not args.warm:
        parser.error("--background needs --warm")
    if args.status and args.warm:
        parser.error("--status reports on a warm-up; it cannot start one")
    if args.wait and not args.status:
        parser.error("--wait needs --status")
    if args.status:
        code, text = warm_status(wait_s=args.wait)
        print(json.dumps({"exit_code": code, "status": text,
                          "record": _read_record(warm_record_path(os.environ))}, indent=2) if args.json else text)
        return code
    if args.background:
        started = start_background(harness=args.harness)
        if args.json:
            print(json.dumps(started, indent=2))
        elif "error" in started:
            print(f"Could not start the warm-up: {started['error']}; see {started['log']}.")
        else:
            verb = "started" if started["started"] else "is already running"
            print(f"Warm-up {verb} in the background (pid {started['pid']}); progress in {started['log']}. "
                  "Check it with `preflight.py --status`.")
        return EXIT_NO_WARM if "error" in started else 0
    report = warm(harness=args.harness) if args.warm else run_checks(harness=args.harness)
    if args.json:
        print(json.dumps(report.as_json(), indent=2))
    else:
        print(render_text(report))
    return report.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
