"""Locate headless FreeCAD and run the FreeCAD-side job scripts of the drawing pipeline.

A job script runs inside ``freecadcmd``. It reads the JSON job file that the CAD_DRAWING_JOB
environment variable names and writes a JSON result to the path in the job's ``result`` key; a
result whose ``status`` is ``pass`` is a success, anything else carries an ``error`` message.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import time
import uuid
from collections.abc import Mapping
from pathlib import Path
from typing import Any

MACOS_FREECADCMD = Path("/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd")
JOB_VARIABLE = "CAD_DRAWING_JOB"


def find_freecadcmd(environ: Mapping[str, str] = os.environ) -> Path | None:
    """The FREECADCMD path when set, else freecadcmd or FreeCADCmd on PATH, else the macOS app's.

    A set FREECADCMD is used as given, without falling back, so a wrong value is reported rather
    than silently replaced by another FreeCAD.
    """
    if environ.get("FREECADCMD"):
        return Path(environ["FREECADCMD"])
    for name in ("freecadcmd", "FreeCADCmd"):
        found = shutil.which(name, path=environ.get("PATH"))
        if found:
            return Path(found)
    return MACOS_FREECADCMD if MACOS_FREECADCMD.is_file() else None


def templates_dir(freecadcmd: Path | None) -> Path:
    """TechDraw's template directory in the FreeCAD bundle that holds ``freecadcmd``.

    The macOS app and the Linux AppImage both keep FreeCAD's resources in ``<prefix>/share`` next
    to ``<prefix>/bin``; a symlink to the bundle's freecadcmd resolves to that layout. Without a
    FreeCAD this is the macOS app's directory, which the caller then reports missing.
    """
    command = (freecadcmd or MACOS_FREECADCMD).resolve()
    return command.parent.parent / "share" / "Mod" / "TechDraw" / "Templates"


def _terminate_process_group(process: subprocess.Popen[str]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        process.wait()
        return
    deadline = time.monotonic() + 2
    while process.poll() is None and time.monotonic() < deadline:
        time.sleep(0.05)
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()


def run_job(freecadcmd: Path, script: Path, job: dict[str, Any], workdir: Path,
            timeout: float) -> tuple[dict[str, Any] | None, str]:
    """Run ``script`` in freecadcmd as its own process group; return its passing result, or None and why.

    The job and result files live in ``workdir`` under a run-specific name and are removed
    afterwards; on timeout the whole process group is killed.
    """
    run_id = uuid.uuid4().hex
    job_path = workdir / f"{script.stem}_{run_id}.job.json"
    result_path = workdir / f"{script.stem}_{run_id}.result.json"
    job_path.write_text(json.dumps({**job, "result": str(result_path)}), encoding="utf-8")
    process: subprocess.Popen[str] | None = None
    try:
        try:
            process = subprocess.Popen([str(freecadcmd), str(script)], cwd=workdir, stdin=subprocess.DEVNULL,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True,
                                       env={**os.environ, JOB_VARIABLE: str(job_path)})
            _, stderr = process.communicate(timeout=timeout)
        except FileNotFoundError:
            return None, f"FreeCAD command line application not found: {freecadcmd}"
        except subprocess.TimeoutExpired:
            _terminate_process_group(process)
            process.communicate()
            return None, f"FreeCAD {script.name} exceeded {timeout:g} seconds"
        except BaseException:
            if process is not None:
                _terminate_process_group(process)
                process.communicate()
            raise
        _terminate_process_group(process)
        if not result_path.is_file():
            return None, f"FreeCAD {script.name} wrote no result marker (exit {process.returncode}): {stderr[-1500:]}"
        try:
            result = json.loads(result_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            return None, f"invalid FreeCAD {script.name} result: {exc}"
    finally:
        job_path.unlink(missing_ok=True)
        result_path.unlink(missing_ok=True)
    if result.get("status") != "pass":
        return None, result.get("error", f"FreeCAD {script.name} failed")
    return result, ""
