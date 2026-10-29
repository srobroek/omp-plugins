"""Locate headless FreeCAD and run the FreeCAD-side job scripts of the drawing pipeline.

A job script runs inside ``freecadcmd``. It reads the JSON job file that the CAD_DRAWING_JOB
environment variable names and writes a JSON result to the path in the job's ``result`` key; a
result whose ``status`` is ``pass`` is a success, anything else carries an ``error`` message.
"""

from __future__ import annotations

import importlib.util
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from collections.abc import Callable, Iterable, Mapping
from concurrent.futures import Executor, Future, ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from typing import Any, TypeVar, cast


def find_freecadcmd(environ: Mapping[str, str] = os.environ, *, home: Path | None = None,
                    platform_name: str | None = None,
                    macos_command: Path | None = None) -> Path | None:
    """Resolve FreeCAD using cad-flow's authoritative ordered candidate list.

    A set FREECADCMD is returned as given without fallback, so an invalid value is reported
    rather than silently replaced by another FreeCAD.
    """
    flow_scripts = Path(__file__).resolve().parents[2] / "cad-flow" / "scripts"
    if str(flow_scripts) not in sys.path:
        sys.path.insert(0, str(flow_scripts))
    spec = importlib.util.spec_from_file_location("cad_flow_preflight", flow_scripts / "preflight.py")
    if spec is None or spec.loader is None:
        raise ImportError(f"{flow_scripts / 'preflight.py'} not found")
    preflight = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = preflight
    spec.loader.exec_module(preflight)
    return preflight._find_freecadcmd(environ, home, platform_name, macos_command)

MACOS_FREECADCMD = Path("/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd")
JOB_VARIABLE = "CAD_DRAWING_JOB"



def templates_dir(freecadcmd: Path | None) -> Path:
    """TechDraw's template directory in the FreeCAD bundle that holds ``freecadcmd``.

    The macOS app and the Linux AppImage both keep FreeCAD's resources in ``<prefix>/share`` next
    to ``<prefix>/bin``; a symlink to the bundle's freecadcmd resolves to that layout. Without a
    FreeCAD this is the macOS app's directory, which the caller then reports missing.
    """
    command = (freecadcmd or MACOS_FREECADCMD).resolve()
    return command.parent.parent / "share" / "Mod" / "TechDraw" / "Templates"


class JobInterrupted(Exception):
    """The drawing run received SIGINT or SIGTERM and stopped its FreeCAD jobs."""

    def __init__(self, signum: int) -> None:
        super().__init__(f"received {signal.Signals(signum).name}")
        self.signum = signum


_CANCEL_JOBS = threading.Event()
_CANCEL_SIGNAL: int | None = None
_ACTIVE_LOCK = threading.RLock()
_ACTIVE_PROCESSES: set[subprocess.Popen[str]] = set()
_T = TypeVar("_T")
_R = TypeVar("_R")


def available_memory_bytes() -> int:
    """Available physical memory, using Linux's reclaim-aware figure when available."""
    try:
        for line in Path("/proc/meminfo").read_text(encoding="ascii").splitlines():
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        pass
    try:
        return int(os.sysconf("SC_AVPHYS_PAGES") * os.sysconf("SC_PAGE_SIZE"))
    except (OSError, ValueError, AttributeError):
        return 0


def jobs_for(requested: int | None, item_count: int, peak_rss_bytes: int) -> int:
    """Bound work by explicit request, or CPU count and available memory for auto mode."""
    if item_count <= 0:
        return 1
    if requested is not None:
        return min(requested, item_count)
    cpu_count = os.cpu_count() or 1
    available_memory = available_memory_bytes()
    memory_count = (available_memory // max(peak_rss_bytes, 1)
                    if available_memory > 0 else item_count)
    return max(1, min(cpu_count, item_count, memory_count))


def _map_jobs(items: list[_T], executor: Executor, worker: Callable[[_T], _R]) -> list[_R]:
    futures: list[Future[_R]] = [executor.submit(worker, item) for item in items]
    results: list[_R | None] = [None] * len(futures)
    failures: list[BaseException] = []
    for index, future in enumerate(futures):
        try:
            results[index] = future.result()
        except BaseException as exc:
            failures.append(exc)
    if failures:
        raise failures[0]
    return cast(list[_R], results)


def map_jobs(items: Iterable[_T], jobs: int, worker: Callable[[_T], _R],
             executor: Executor | None = None) -> list[_R]:
    """Run independent items in a bounded pool and return their results in input order."""
    if jobs < 1:
        raise ValueError("jobs must be positive")
    values = list(items)
    if not values:
        return []
    if executor is not None:
        return _map_jobs(values, executor, worker)
    with ThreadPoolExecutor(max_workers=min(jobs, len(values)), thread_name_prefix="cad-drawing") as pool:
        return _map_jobs(values, pool, worker)


@contextmanager
def terminate_jobs_on_signal():
    """Install CLI signal handlers that terminate all FreeCAD process groups before returning."""
    if threading.current_thread() is not threading.main_thread():
        raise RuntimeError("FreeCAD signal handlers must be installed on the main thread")
    previous = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
    global _CANCEL_SIGNAL
    _CANCEL_JOBS.clear()
    _CANCEL_SIGNAL = None

    def interrupted(signum: int, _frame: Any) -> None:
        global _CANCEL_SIGNAL
        with _ACTIVE_LOCK:
            _CANCEL_SIGNAL = signum
            _CANCEL_JOBS.set()
            processes = tuple(_ACTIVE_PROCESSES)
        _terminate_active_processes(processes)
        raise JobInterrupted(signum)

    for sig in previous:
        signal.signal(sig, interrupted)
    try:
        yield
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        _CANCEL_JOBS.clear()
        _CANCEL_SIGNAL = None


def _register_process(process: subprocess.Popen[str]) -> None:
    with _ACTIVE_LOCK:
        cancelled = _CANCEL_JOBS.is_set()
        if not cancelled:
            _ACTIVE_PROCESSES.add(process)
    if cancelled:
        _terminate_process_group(process)
        raise JobInterrupted(_CANCEL_SIGNAL or signal.SIGTERM)


def _unregister_process(process: subprocess.Popen[str]) -> None:
    with _ACTIVE_LOCK:
        _ACTIVE_PROCESSES.discard(process)


def _terminate_active_processes(processes: tuple[subprocess.Popen[str], ...] | None = None) -> None:
    if processes is None:
        with _ACTIVE_LOCK:
            processes = tuple(_ACTIVE_PROCESSES)
    for process in processes:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        alive = False
        for process in processes:
            try:
                os.killpg(process.pid, 0)
                alive = True
            except ProcessLookupError:
                pass
        if not alive:
            break
        time.sleep(0.05)
    for process in processes:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    for process in processes:
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass

@contextmanager
def _job_state_environment(workdir: Path):
    """Give each FreeCAD invocation an isolated FreeCAD, Qt, config, cache and temp directory."""
    with tempfile.TemporaryDirectory(prefix="freecad-job-", dir=workdir) as name:
        root = Path(name)
        home = root / "home"
        paths = {key: root / key.lower() for key in
                 ("FREECAD_USER_HOME", "FREECAD_USER_DATA", "FREECAD_USER_TEMP", "XDG_CONFIG_HOME",
                  "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR")}
        temporary = root / "tmp"
        for directory in (home, *paths.values(), temporary):
            directory.mkdir(mode=0o700)
        yield {"HOME": str(home), **{key: str(path) for key, path in paths.items()},
               "FREECAD_USER_HOME": str(paths["FREECAD_USER_HOME"]),
               "FREECAD_USER_DATA": str(paths["FREECAD_USER_DATA"]),
               "FREECAD_USER_TEMP": str(paths["FREECAD_USER_TEMP"]),
               "TMPDIR": str(temporary), "TMP": str(temporary), "TEMP": str(temporary),
               "APPDATA": str(paths["XDG_CONFIG_HOME"]), "LOCALAPPDATA": str(paths["XDG_DATA_HOME"]),
               "QT_QPA_PLATFORM": "offscreen"}


FREECAD_JOB_PEAK_RSS_BYTES = 1_500 * 1024 * 1024


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
    """Run one isolated FreeCAD process group and return its passing JSON result, or a reason."""
    run_id = uuid.uuid4().hex
    job_path = workdir / f"{script.stem}_{run_id}.job.json"
    result_path = workdir / f"{script.stem}_{run_id}.result.json"
    job_path.write_text(json.dumps({**job, "result": str(result_path)}), encoding="utf-8")
    process: subprocess.Popen[str] | None = None
    try:
        if _CANCEL_JOBS.is_set():
            raise JobInterrupted(_CANCEL_SIGNAL or signal.SIGTERM)
        with _job_state_environment(workdir) as isolation:
            try:
                process = subprocess.Popen([str(freecadcmd), str(script)], cwd=workdir, stdin=subprocess.DEVNULL,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                           start_new_session=True,
                                           env={**os.environ, **isolation, JOB_VARIABLE: str(job_path)})
                with _ACTIVE_LOCK:
                    if _CANCEL_JOBS.is_set():
                        cancel = True
                    else:
                        _ACTIVE_PROCESSES.add(process)
                        cancel = False
                if cancel:
                    _terminate_process_group(process)
                    raise JobInterrupted(_CANCEL_SIGNAL or signal.SIGTERM)
                try:
                    _, stderr = process.communicate(timeout=timeout)
                finally:
                    _terminate_process_group(process)
                    _unregister_process(process)
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
