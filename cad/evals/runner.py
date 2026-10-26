"""Eval runner core: fresh sandbox per trial, harness turns, grading, ratchet rows.

Output per cell (one ratchet variant directory):
  results.jsonl   one row per scored (case, rep), appended as each finishes
  errors.jsonl    attempts that produced nothing scorable, with a failure class
  traces/<id>_rep<k>.json   transcripts, written for train ids only
  raw/<id>_rep<k>_t<n>.jsonl raw harness streams, train ids only
  artifacts/<id>_rep<k>/    the case's collected deliverables, for the judge hook

Ground truth lives in cad/evals/truth/ and is opened only by the grader; the
sandbox gets the seed record and a copy of the plugin with evals/ removed.
"""

from __future__ import annotations

import json
import os
import random
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import tomllib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import adapters
from adapters.base import TrialPaths, Turn, add_usage, empty_usage
from graders.score import GraderError, grade_trial

EVALS = Path(__file__).resolve().parent
PLUGIN_ROOT = EVALS.parent
CASES = EVALS / "cases"
TRUTH_MARKERS = (str(EVALS / "truth"), "evals/truth")
VALIDATOR = PLUGIN_ROOT / "skills" / "cad-record" / "scripts" / "validate.py"
_TRANSIENT = re.compile(
    r"(?i)throttl|rate.?limit|too many requests|\b429\b|\b50[0-4]\b|overloaded|ECONNRESET|"
    r"connection (reset|refused)|temporarily unavailable|service unavailable|socket hang up"
)
_STAGE_IGNORE = shutil.ignore_patterns("evals", ".git", "node_modules", "__pycache__", ".venv")


class TrialError(Exception):
    """An attempt that produced no scorable output."""

    def __init__(self, failure_class: str, detail: str, *, transient: bool = False):
        super().__init__(f"{failure_class}: {detail}")
        self.failure_class = failure_class
        self.detail = detail
        self.transient = transient


# ---------------------------------------------------------------- cases, matrix


def load_case(path: Path) -> dict:
    case = json.loads(path.read_text(encoding="utf-8"))
    case["_seed"] = CASES / "seeds" / case["seed"]
    case["_truth"] = EVALS / case["truth"]
    return case


def load_cases(ids: list[str] | None = None) -> list[dict]:
    cases = {c["id"]: c for c in map(load_case, sorted(CASES.glob("*.case.json")))}
    if not ids:
        return list(cases.values())
    missing = [i for i in ids if i not in cases]
    if missing:
        raise ValueError(f"unknown case ids: {', '.join(missing)}")
    return [cases[i] for i in ids]


def load_truth(case: dict) -> dict:
    return json.loads((case["_truth"] / "truth.json").read_text(encoding="utf-8"))


@dataclass(frozen=True)
class Cell:
    harness: str
    model: str
    expect: str | None = None

    @property
    def slug(self) -> str:
        return f"{self.harness}--{re.sub(r'[^A-Za-z0-9.-]+', '-', self.model.rsplit('/', 1)[-1])}"


@dataclass
class Matrix:
    raw: dict
    cells: list[Cell]

    @property
    def reps(self) -> int:
        return int(self.raw.get("reps", 2))

    def harness_cfg(self, harness: str) -> dict:
        return self.raw.get("harness", {}).get(harness, {})


def load_matrix(path: Path) -> Matrix:
    raw = tomllib.loads(path.read_text(encoding="utf-8"))
    expect = raw.get("expect", {})
    cells = [
        Cell(harness, model, expect.get(f"{harness}:{model}"))
        for harness, cfg in raw.get("harness", {}).items()
        for model in cfg.get("models", [])
    ]
    return Matrix(raw, cells)


# ---------------------------------------------------------------- host environment

# The only host variables a harness sees. Everything else of the user's shell
# (OMP_*, PI_*, CLAUDE_*, ANTHROPIC_*, AWS_PROFILE, XDG_*, MISE_*) stays out.
_HOST_KEEP = ("PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "USER", "LOGNAME", "SHELL")
_GIT_ENV = {"GIT_TERMINAL_PROMPT": "0", "PAGER": "cat", "GIT_PAGER": "cat", "TERM": "dumb"}
_CRED_MARGIN_S = 35 * 60  # longer than the default case ceiling


class HostSource:
    """Builds the `Host` handed to adapters, re-exporting AWS credentials when they
    near expiry. Credentials are exported from the host profile once per window, so
    the harness never reads ~/.aws or runs the profile's credential_process itself."""

    def __init__(self, auth: dict):
        self.profile = auth.get("aws_profile") or os.environ.get("AWS_PROFILE")
        self.region = auth.get("aws_region", "us-east-1")
        self._lock = threading.Lock()
        self._aws: dict[str, str] = {}
        self._expires = 0.0
        self._base = self._base_env()

    @staticmethod
    def _base_env() -> dict[str, str]:
        env = {k: os.environ[k] for k in _HOST_KEEP if k in os.environ}
        for var, args in (("UV_CACHE_DIR", ["cache", "dir"]), ("UV_PYTHON_INSTALL_DIR", ["python", "dir"])):
            try:  # toolchain caches, so `uv run` in a trial does not re-download kernels
                out = subprocess.run(["uv", *args], capture_output=True, text=True, check=True, timeout=30).stdout.strip()
            except (OSError, subprocess.SubprocessError):
                continue
            if out:
                env[var] = out
        return {**env, **_GIT_ENV}

    def _export_aws(self) -> None:
        try:
            done = subprocess.run(
                ["aws", "configure", "export-credentials", "--profile", self.profile, "--format", "process"],
                capture_output=True, text=True, check=True, timeout=120,
            )
            creds = json.loads(done.stdout)
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
            raise TrialError("auth_error", f"could not export AWS credentials for profile {self.profile}: {exc}") from exc
        self._aws = {
            "AWS_ACCESS_KEY_ID": creds["AccessKeyId"], "AWS_SECRET_ACCESS_KEY": creds["SecretAccessKey"],
            "AWS_REGION": self.region, "AWS_DEFAULT_REGION": self.region,
        }
        if creds.get("SessionToken"):
            self._aws["AWS_SESSION_TOKEN"] = creds["SessionToken"]
        expiry = creds.get("Expiration")
        self._expires = datetime.fromisoformat(expiry).timestamp() if expiry else float("inf")

    def get(self) -> adapters.Host:
        with self._lock:
            if self.profile and time.time() > self._expires - _CRED_MARGIN_S:
                self._export_aws()
            return adapters.Host(base_env=dict(self._base), aws_env=dict(self._aws), real_home=Path.home())


# ---------------------------------------------------------------- one trial


def stage_trial(case: dict | None, adapter, host: adapters.Host, *, require_plugin: bool) -> TrialPaths:
    root = Path(tempfile.mkdtemp(prefix="cad-eval-"))
    paths = TrialPaths(root=root, work=root / "work", plugin=root / "cad", state=root / "state", home=root / "home")
    if PLUGIN_ROOT.is_dir():
        shutil.copytree(PLUGIN_ROOT, paths.plugin, ignore=_STAGE_IGNORE)
    else:
        paths.plugin.mkdir()
    if require_plugin and not (paths.plugin / adapter.plugin_marker).exists():
        shutil.rmtree(root, ignore_errors=True)
        raise TrialError("plugin_missing", f"{adapter.name} needs {adapter.plugin_marker} under {PLUGIN_ROOT}")
    paths.work.mkdir()
    paths.home.mkdir()
    if case is not None:
        shutil.copytree(case["_seed"], paths.work, dirs_exist_ok=True)
    adapter.prepare(paths, host)
    # The baseline commit includes the harness files prepare() placed in the sandbox,
    # so the agent's own changes are the only diff.
    _git(paths.work, "init", "-q")
    _git(paths.work, "add", "-A")
    _git(paths.work, "-c", "user.name=cad-eval", "-c", "user.email=cad-eval@invalid", "commit", "-q", "--allow-empty", "-m", "seed")
    return paths


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, env={**os.environ, **_GIT_ENV}, check=True, capture_output=True)


def run_probe(adapter, paths: TrialPaths, host: adapters.Host, model: str, first_stream: list[str],
              timeout_s: float = 120) -> list[str]:
    """Run the adapter's model-free inventory commands after the first turn; one stdout
    per command, '' for a command that failed (an empty inventory fails closed as
    contaminated, it is not a trial error)."""
    outputs = []
    for argv, stdin in adapter.probe(paths, model, first_stream):
        try:
            done = subprocess.run(argv, cwd=paths.work, env=adapter.env(paths, host), input=stdin,
                                  capture_output=True, text=True, timeout=timeout_s, check=False)
            outputs.append(done.stdout)
        except (OSError, subprocess.TimeoutExpired):
            outputs.append("")
    return outputs


def run_turn(adapter, argv: list[str], paths: TrialPaths, host: adapters.Host, timeout_s: float) -> tuple[Turn, list[str], str]:
    """Run one harness invocation; return the parsed turn, raw stdout lines and stderr."""
    if timeout_s <= 0:
        raise TrialError("timeout", "case wall-clock ceiling reached before the turn started")
    env = adapter.env(paths, host)
    try:
        proc = subprocess.Popen(
            argv, cwd=paths.work, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, start_new_session=True,
        )
    except OSError as exc:
        raise TrialError("adapter_error", f"could not start {argv[0]}: {exc}") from exc
    try:
        stdout, stderr = proc.communicate(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        _kill_group(proc)
        raise TrialError("timeout", f"turn exceeded the {timeout_s:.0f}s remaining in the case ceiling") from None
    lines = stdout.splitlines()
    turn = adapter.complete(adapter.parse(lines), lines, paths, env)
    if turn.error:
        raise TrialError("provider_error", turn.error[-800:], transient=bool(_TRANSIENT.search(turn.error)))
    if proc.returncode != 0:
        tail = (stderr or stdout)[-800:]
        raise TrialError("adapter_error", f"exit {proc.returncode}: {tail}", transient=bool(_TRANSIENT.search(tail)))
    if not lines:
        raise TrialError("adapter_error", f"empty stream; stderr: {stderr[-800:]}")
    return turn, lines, stderr


def isolation_of(adapter, paths: TrialPaths, probe_outputs: list[str], first_stream: list[str]) -> dict:
    """Row fields: `isolation` clean|contaminated, the leak list, the inventory and mechanism."""
    inventory = adapter.inventory(probe_outputs, first_stream, paths)
    found = adapters.leaks(inventory, paths, adapter.builtin)
    return {
        "isolation": "contaminated" if found else "clean",
        "leaks": found,
        "inventory": inventory.as_dict(),
        "isolation_mechanism": adapter.isolation,
    }


def _kill_group(proc: subprocess.Popen) -> None:
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(proc.pid, sig)
        except ProcessLookupError:
            return
        try:
            proc.wait(timeout=10)
            return
        except subprocess.TimeoutExpired:
            continue


@dataclass
class Conversation:
    turns: list[Turn] = field(default_factory=list)
    raw: list[list[str]] = field(default_factory=list)
    transcript: list[dict] = field(default_factory=list)
    usage: dict = field(default_factory=empty_usage)
    truncated: bool = False

    @property
    def model(self) -> str | None:
        return next((t.model for t in reversed(self.turns) if t.model), None)


def converse(case: dict, cell: Cell, adapter, paths: TrialPaths, host: adapters.Host, *, ceiling_s: float, max_turns: int) -> Conversation:
    """First prompt, then scripted gate answers while the agent's reply asks for one."""
    deadline = time.monotonic() + ceiling_s
    uses = [0] * len(case["gate_answers"])
    conv = Conversation()
    prompt, resume = case["prompt"], False
    for _ in range(max_turns):
        argv = adapter.command(model=cell.model, prompt=prompt, paths=paths, resume=resume)
        turn, lines, _ = run_turn(adapter, argv, paths, host, deadline - time.monotonic())
        conv.turns.append(turn)
        conv.raw.append(lines)
        conv.transcript.append({"role": "user", "content": prompt})
        conv.transcript.extend(e for e in turn.transcript if not (e["role"] == "user" and e["content"] == prompt))
        conv.usage = add_usage(conv.usage, turn.usage)
        conv.truncated = conv.truncated or turn.truncated
        reply = next_gate_answer(case["gate_answers"], uses, turn.text)
        if reply is None:
            return conv
        prompt, resume = reply, True
    conv.truncated = True  # turns ran out while the agent still waited on a gate
    return conv


def next_gate_answer(gates: list[dict], uses: list[int], text: str) -> str | None:
    for i, gate in enumerate(gates):
        if uses[i] < gate.get("max_uses", 1) and re.search(gate["when"], text or ""):
            uses[i] += 1
            return gate["reply"]
    return None


@dataclass(frozen=True)
class Scored:
    row: dict
    transcript: list[dict]
    raw: list[list[str]]


def attempt(case: dict, cell: Cell, adapter, cfg: dict, artifact_dir: Path, keep: bool, host_source: HostSource) -> Scored:
    host = host_source.get()
    paths = stage_trial(case, adapter, host, require_plugin=True)
    try:
        started = time.monotonic()
        conv = converse(case, cell, adapter, paths, host, ceiling_s=float(cfg["case_timeout_s"]), max_turns=int(cfg["max_turns"]))
        latency = round(time.monotonic() - started, 3)
        probe_outputs = run_probe(adapter, paths, host, cell.model, conv.raw[0])
        served = conv.model
        if served is None:
            raise TrialError("model_unverified", f"{cell.harness} stream carried no served model")
        if not adapters.served_matches(cell.model, served, cell.expect):
            raise TrialError("model_mismatch", f"requested {cell.model}, served {served}")
        if any(marker in line for lines in conv.raw for line in lines for marker in TRUTH_MARKERS):
            raise TrialError("truth_leak", "the harness stream references the hidden truth directory")
        try:
            graded = grade_trial(case, paths.work, load_truth(case), VALIDATOR if VALIDATOR.is_file() else None)
        except GraderError as exc:
            raise TrialError("grader_error", str(exc)) from exc
        collect = paths.work / case["deliverables"].get("collect", "hw")
        if collect.is_dir():
            shutil.copytree(collect, artifact_dir, dirs_exist_ok=True)
        row = {
            "prompt": case["prompt"],
            "tags": case["tags"],
            "grade": graded.grade,
            "explanation": graded.explanation,
            "status": "truncated" if conv.truncated else "ok",
            "model": served,
            "usage": conv.usage,
            "latency_s": latency,
            "harness": cell.harness,
            "requested_model": cell.model,
            "turns": len(conv.turns),
            **isolation_of(adapter, paths, probe_outputs, conv.raw[0]),
        }
        return Scored(row, conv.transcript, conv.raw)
    finally:
        if keep:
            print(f"kept sandbox {paths.root}")
        else:
            shutil.rmtree(paths.root, ignore_errors=True)


# ---------------------------------------------------------------- slots and sinks


class Sink:
    """Thread-safe append-only JSONL writers for one cell directory."""

    def __init__(self, out: Path):
        self.out = out
        out.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def append(self, name: str, row: dict) -> None:
        line = json.dumps(row, sort_keys=True, ensure_ascii=False)
        with self._lock, (self.out / name).open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")

    def done_slots(self) -> set[tuple[str, int]]:
        path = self.out / "results.jsonl"
        if not path.is_file():
            return set()
        rows = (json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip())
        return {(r["prompt_id"], r["rep"]) for r in rows}


def backoff_s(attempt_no: int, retry: dict, rng: random.Random) -> float:
    base, cap = float(retry.get("base_s", 10)), float(retry.get("max_s", 120))
    return min(cap, base * 2 ** (attempt_no - 1)) * rng.uniform(0.5, 1.5)


def run_slot(case: dict, rep: int, cell: Cell, adapter, cfg: dict, sink: Sink, *, trace: bool, keep: bool,
             rng: random.Random, host_source: HostSource) -> str:
    retry = cfg.get("retry", {})
    max_attempts = int(retry.get("attempts", 3))
    slot = f"{case['id']}_rep{rep}"
    for attempt_no in range(1, max_attempts + 1):
        artifact_dir = sink.out / "artifacts" / slot
        shutil.rmtree(artifact_dir, ignore_errors=True)
        started = time.monotonic()
        try:
            scored = attempt(case, cell, adapter, cfg, artifact_dir, keep, host_source)
        except Exception as exc:  # every unscorable attempt lands in errors.jsonl, never as a zero
            error = exc if isinstance(exc, TrialError) else TrialError("runner_error", f"{type(exc).__name__}: {exc}")
            if error.transient and attempt_no < max_attempts:
                time.sleep(backoff_s(attempt_no, retry, rng))
                continue
            sink.append("errors.jsonl", {
                "prompt_id": case["id"], "rep": rep, "tags": case["tags"], "harness": cell.harness,
                "requested_model": cell.model, "failure_class": error.failure_class, "detail": error.detail,
                "transient": error.transient, "retries": attempt_no - 1,
                "latency_s": round(time.monotonic() - started, 3), "at": _now(),
            })
            return error.failure_class
        row = {"prompt_id": case["id"], "rep": rep, **scored.row, "retries": attempt_no - 1}
        if trace:
            _write_trace(sink.out, slot, scored)
        sink.append("results.jsonl", row)
        return "ok"
    raise AssertionError("unreachable: the last attempt always records")


def _write_trace(out: Path, slot: str, scored: Scored) -> None:
    (out / "traces").mkdir(exist_ok=True)
    (out / "traces" / f"{slot}.json").write_text(json.dumps(scored.transcript, ensure_ascii=False, indent=1), encoding="utf-8")
    (out / "raw").mkdir(exist_ok=True)
    for n, lines in enumerate(scored.raw, 1):
        (out / "raw" / f"{slot}_t{n}.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def plan_slots(cells: list[Cell], cases: list[dict], reps: int, out: Path) -> list[tuple[Cell, dict, int]]:
    """Every (cell, case, rep) not already scored; errored slots are retried on resume."""
    slots = []
    for cell in cells:
        done = Sink(out / cell.slug).done_slots()
        slots += [(cell, case, rep) for case in cases for rep in range(1, reps + 1) if (case["id"], rep) not in done]
    return slots


def run_matrix(matrix: Matrix, cells: list[Cell], cases: list[dict], reps: int, out: Path, *,
               trace_ids: set[str] | None, concurrency: int, keep: bool, seed: int | None = None,
               host_source: HostSource | None = None) -> dict[str, int]:
    """Run every pending slot with bounded concurrency; return failure-class counts.

    `trace_ids=None` writes traces for every case (pilot, before a split exists);
    otherwise only ids in the set (the ratchet train split) get traces.
    """
    cfg = {key: matrix.raw.get(key, default) for key, default in (("case_timeout_s", 1800), ("max_turns", 4), ("retry", {}))}
    sinks = {cell.slug: Sink(out / cell.slug) for cell in cells}
    built = {cell.harness: adapters.build(cell.harness, matrix.harness_cfg(cell.harness)) for cell in cells}
    host_source = host_source or HostSource(matrix.raw.get("auth", {}))
    rng = random.Random(seed)
    slots = [(*slot, rng.random()) for slot in plan_slots(cells, cases, reps, out)]
    counts: dict[str, int] = {}
    lock = threading.Lock()

    def one(slot):
        cell, case, rep, slot_seed = slot
        trace = trace_ids is None or case["id"] in trace_ids
        outcome = run_slot(case, rep, cell, built[cell.harness], cfg, sinks[cell.slug], trace=trace, keep=keep,
                           rng=random.Random(slot_seed), host_source=host_source)
        with lock:
            counts[outcome] = counts.get(outcome, 0) + 1

    with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
        list(pool.map(one, slots))
    return counts


# ---------------------------------------------------------------- comparisons


def read_rows(cell_dir: Path) -> list[dict]:
    path = cell_dir / "results.jsonl"
    if not path.is_file():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def cell_isolation(rows: list[dict]) -> tuple[str, list[str]]:
    """A cell is clean only when every scored row is; a row without the tag
    predates isolation and counts as contaminated."""
    found = sorted({leak for r in rows for leak in (r.get("leaks") or ([] if r.get("isolation") == "clean" else ["untagged row"]))})
    clean = bool(rows) and all(r.get("isolation") == "clean" for r in rows)
    return ("clean" if clean else "contaminated"), found


class Contaminated(Exception):
    """A comparison was asked to include a contaminated cell without --allow-contaminated."""


def require_comparable(cell_dirs: list[Path], allow_contaminated: bool) -> dict[Path, tuple[str, list[str]]]:
    status = {d: cell_isolation(read_rows(d)) for d in cell_dirs}
    bad = {d: s for d, s in status.items() if s[0] != "clean"}
    if bad and not allow_contaminated:
        detail = "; ".join(f"{d.name}: {', '.join(s[1][:5]) or 'no rows'}" for d, s in bad.items())
        raise Contaminated(f"contaminated cells excluded from comparison (pass --allow-contaminated to include): {detail}")
    return status


def summarize(out: Path, allow_contaminated: bool) -> dict:
    """Per-cell pass rate and mean score; contaminated cells are listed but left out
    of `cells` unless allowed."""
    included, excluded = [], []
    for cell_dir in sorted(p for p in out.iterdir() if (p / "results.jsonl").is_file()):
        rows = read_rows(cell_dir)
        isolation, found = cell_isolation(rows)
        entry = {
            "cell": cell_dir.name, "n": len(rows), "isolation": isolation, "leaks": found,
            "pass_rate": round(sum(r["grade"]["pass"] for r in rows) / len(rows), 4),
            "mean_score": round(sum(r["grade"]["score"] for r in rows) / len(rows), 4),
        }
        (included if isolation == "clean" or allow_contaminated else excluded).append(entry)
    return {"cells": included, "excluded_contaminated": excluded}
