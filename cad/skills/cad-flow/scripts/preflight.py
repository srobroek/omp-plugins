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
from dataclasses import asdict, dataclass
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
        return (f"CAD preflight: {counts['pass']} passed, {counts['fail']} failed, "
                f"{counts['warn']} warnings; exit {self.exit_code}.")

    def as_json(self) -> dict[str, Any]:
        return {"summary": self.summary, "exit_code": self.exit_code, "counts": self.counts,
                "checks": [asdict(check) for check in self.checks]}


def _check(identifier: str, name: str, status: str, detail: str, fix: str,
           required: bool = True) -> Check:
    return Check(identifier, name, status, required, detail, fix)


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


def _kernel_probe(uv: str, name: str, python: str, dependencies: Sequence[str], module: str,
                  expected: str, timeout: int = KERNEL_TIMEOUT, distribution: str | None = None) -> Check:
    dependency_lines = ", ".join(json.dumps(dependency) for dependency in dependencies)
    distribution = distribution or module
    code = (f"import importlib.metadata, json, {module}\n"
            f"print('CAD_PREFLIGHT:' + json.dumps(importlib.metadata.version({distribution!r})))\n")
    source = ("# /// script\n"
              f"# requires-python = {json.dumps(python)}\n"
              f"# dependencies = [{dependency_lines}]\n"
              "# ///\n" + code)
    try:
        with tempfile.TemporaryDirectory(prefix=f"cad-preflight-{name}-") as temporary:
            script = Path(temporary) / "probe.py"
            script.write_text(source, encoding="utf-8")
            result = subprocess.run([uv, "run", "--script", str(script)], cwd=temporary, capture_output=True,
                                    text=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        return _check(name, name, "fail", f"uv did not resolve and import {module} within {timeout} seconds.",
                      f"Retry with network access and allow uv to resolve the pinned {name} environment.")
    except OSError as error:
        return _check(name, name, "fail", f"Could not run the {name} uv environment: {error}.",
                      f"Install/repair uv, then run the {name} kernel runner once to resolve its environment.")

    marker = next((line.removeprefix("CAD_PREFLIGHT:") for line in result.stdout.splitlines()
                   if line.startswith("CAD_PREFLIGHT:")), None)
    if result.returncode != 0 or marker is None:
        detail = (result.stderr or result.stdout).strip().splitlines()
        reason = detail[-1] if detail else f"uv exited {result.returncode} without an import result"
        return _check(name, name, "fail", f"The pinned {module} import failed: {reason}.",
                      f"Run the {name} kernel runner once with network access, resolve the import error, then retry.")
    try:
        version = json.loads(marker)
    except json.JSONDecodeError:
        version = marker
    if version != expected:
        return _check(name, name, "fail", f"Imported {module} {version}; expected {expected}.",
                      f"Use the pinned {name} environment declared by cad-model.")
    return _check(name, name, "pass", f"{module} {version} imports in its pinned uv environment.", "")


def _freecad_checks(environ: Mapping[str, str]) -> list[Check]:
    command = freecad_runtime.find_freecadcmd(environ)
    if command is None:
        command_detail = "FreeCAD 1.1.4 freecadcmd was not found via FREECADCMD, PATH, or the macOS app."
        command_fix = ("Install FreeCAD 1.1.4; set FREECADCMD to its freecadcmd executable or add "
                       "freecadcmd to PATH. See cad-drawings/SKILL.md for macOS and Linux install steps.")
        found = False
    else:
        found = command.is_file() and os.access(command, os.X_OK)
        command_detail = f"FreeCAD command: {command}" if found else f"Configured FreeCAD command is missing or not executable: {command}."
        command_fix = ("Install FreeCAD 1.1.4; set FREECADCMD to an executable freecadcmd or add it to PATH. "
                       "See cad-drawings/SKILL.md for macOS and Linux install steps.")
    checks = [_check("freecad-command", "FreeCAD command", "pass" if found else "fail", command_detail,
                     "" if found else command_fix)]

    version = None
    version_error = "FreeCAD command unavailable."
    if found and command is not None:
        try:
            with tempfile.TemporaryDirectory(prefix="cad-preflight-freecad-") as temporary:
                result_file = Path(temporary) / "version.json"
                script = Path(temporary) / "version.py"
                script.write_text(
                    "import FreeCAD as App, json\n"
                    f"open({str(result_file)!r}, 'w', encoding='utf-8').write(json.dumps(App.Version()))\n",
                    encoding="utf-8")
                result = subprocess.run([str(command), str(script)], capture_output=True, text=True, timeout=90,
                                        check=False, env=dict(environ))
                if result.returncode != 0:
                    version_error = (result.stderr or result.stdout).strip().splitlines()[-1:]
                    version_error = version_error[0] if version_error else f"freecadcmd exited {result.returncode}"
                elif result_file.is_file():
                    reported = json.loads(result_file.read_text(encoding="utf-8"))
                    version = ".".join(str(component) for component in reported[:3])
                    version_error = f"FreeCAD reported {version}."
                else:
                    version_error = "freecadcmd produced no version result; FreeCAD may not have started."
        except (OSError, subprocess.TimeoutExpired, ValueError, json.JSONDecodeError) as error:
            version_error = f"Could not query FreeCAD version: {error}."
    version_ok = version == "1.1.4"
    checks.append(_check("freecad-version", "FreeCAD version", "pass" if version_ok else "fail",
                         version_error if version_ok else version_error + " Required version is 1.1.4.", command_fix))

    templates = freecad_runtime.templates_dir(command)
    missing = [relative for relative in EXPECTED_TEMPLATES if not (templates / relative).is_file()]
    template_ok = found and not missing
    if not found:
        detail = f"TechDraw template directory cannot be verified without freecadcmd: {templates}."
    elif missing:
        detail = f"Missing TechDraw templates under {templates}: {', '.join(missing)}."
    else:
        detail = f"TechDraw templates found in {templates}: {', '.join(EXPECTED_TEMPLATES)}."
    checks.append(_check("techdraw-templates", "TechDraw templates", "pass" if template_ok else "fail", detail,
                         "Install the complete FreeCAD 1.1.4 bundle; TechDraw templates must be beside its freecadcmd."
                         if not template_ok else ""))
    return checks


def _playwright_check(uv: str) -> Check:
    source = ("# /// script\n# requires-python = \">=3.11\"\n"
              "# dependencies = [\"playwright==1.64.1\"]\n# ///\n"
              "import json\nfrom pathlib import Path\nfrom playwright.sync_api import sync_playwright\n"
              "with sync_playwright() as p:\n"
              " print('CAD_PREFLIGHT:' + json.dumps({'version': p.chromium.name, 'path': p.chromium.executable_path, 'exists': Path(p.chromium.executable_path).is_file()}))\n")
    try:
        with tempfile.TemporaryDirectory(prefix="cad-preflight-playwright-") as temporary:
            script = Path(temporary) / "probe_chromium.py"
            script.write_text(source, encoding="utf-8")
            result = subprocess.run([uv, "run", "--script", str(script)], cwd=temporary, capture_output=True,
                                    text=True, timeout=240, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        reason = "timed out" if isinstance(error, subprocess.TimeoutExpired) else str(error)
        return _check("playwright-chromium", "Playwright Chromium", "fail", f"Playwright probe {reason}.",
                      "Run `uv run --with playwright==1.64.1 playwright install chromium`, then retry.")
    marker = next((line.removeprefix("CAD_PREFLIGHT:") for line in result.stdout.splitlines()
                   if line.startswith("CAD_PREFLIGHT:")), None)
    try:
        browser = json.loads(marker) if marker else None
    except json.JSONDecodeError:
        browser = None
    if result.returncode != 0 or not browser or not browser.get("exists"):
        detail = (result.stderr or result.stdout).strip().splitlines()
        reason = detail[-1] if detail else (f"Chromium executable missing at {browser.get('path')}" if browser else
                                             "Playwright did not report a Chromium executable")
        return _check("playwright-chromium", "Playwright Chromium", "fail", reason,
                      "Run `uv run --with playwright==1.64.1 playwright install chromium`, then retry.")
    return _check("playwright-chromium", "Playwright Chromium", "pass",
                  f"Playwright 1.64.1 Chromium executable exists at {browser['path']}.", "")


def _ocp_viewer_check(uv: str) -> Check:
    dependencies = ("cadquery-ocp-novtk==8.0.1.1.0", "ocp_viewer==1.2.0", "playwright==1.64.1", "pyyaml>=6.0")
    return _kernel_probe(uv, "ocp-viewer", "==3.12.*", dependencies, "ocp_viewer", "1.2.0",
                         timeout=KERNEL_TIMEOUT, distribution="ocp_viewer")


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


def run_checks(environ: Mapping[str, str] | None = None, cwd: Path | None = None,
               home: Path | None = None, harness: str | None = None) -> Report:
    env = os.environ if environ is None else environ
    workdir = cwd or Path.cwd()
    home_dir = home or Path(env.get("HOME", str(Path.home())))
    checks: list[Check] = []
    uv_check, uv = _uv_check(env)
    checks.append(uv_check)
    checks.extend(_freecad_checks(env))
    if uv:
        checks.append(_kernel_probe(uv, "cadquery", ">=3.12,<3.13",
                                    ("cadquery==2.8.0", "cadquery-ocp==7.9.3.1.1", "vtk==9.6.2"),
                                    "cadquery", "2.8.0"))
        checks.append(_kernel_probe(uv, "build123d", ">=3.12,<3.13",
                                    ("build123d==0.13.0", "cadquery-ocp-novtk==8.0.1.1.0", "bd_warehouse==0.4.0"),
                                    "build123d", "0.13.0"))
        checks.append(_playwright_check(uv))
        checks.append(_ocp_viewer_check(uv))
    else:
        for name in ("cadquery", "build123d", "playwright-chromium", "ocp-viewer"):
            checks.append(_check(name, name, "fail", "Cannot resolve this environment because uv is unavailable.",
                                  "Install uv and ensure its bin directory is on PATH."))
    checks.append(_vendor_check(env))
    checks.append(_beads_check(workdir, env))
    harnesses = (harness,) if harness else ("omp", "claude", "opencode", "kiro")
    checks.extend(_harness_check(name, workdir, home_dir, env) for name in harnesses)
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
