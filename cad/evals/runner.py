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

import hmac
import json
import os
import random
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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
    r"(?i)throttl|rate.?limit|too many requests|expiredtoken|unrecognizedclientexception|security token included in the request is expired|"
    r"\b429\b|\b50[0-4]\b|overloaded|ECONNRESET|connection (reset|refused)|temporarily unavailable|service unavailable|socket hang up"
)
_EXPIRED_CREDENTIALS = re.compile(
    r"(?i)expiredtoken|unrecognizedclientexception|security token included in the request is expired"
)
_STAGE_IGNORE = shutil.ignore_patterns(
    "evals", ".git", "node_modules", "__pycache__", ".venv"
)


class TrialError(Exception):
    """An attempt that produced no scorable output."""

    def __init__(
        self,
        failure_class: str,
        detail: str,
        *,
        transient: bool = False,
        credential_failure: bool = False,
    ):
        super().__init__(f"{failure_class}: {detail}")
        self.failure_class = failure_class
        self.detail = detail
        self.transient = transient
        self.credential_failure = credential_failure


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
# (OMP_*, PI_*, CLAUDE_*, ANTHROPIC_*, AWS_PROFILE, XDG_*, MISE_*) stays out, and
# TMPDIR is the trial's own (`adapters.base.trial_temp`), never the host's.
_HOST_KEEP = ("PATH", "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME", "SHELL")
_GIT_ENV = {
    "GIT_TERMINAL_PROMPT": "0",
    "PAGER": "cat",
    "GIT_PAGER": "cat",
    "TERM": "dumb",
}
_CRED_REFRESH_MARGIN_S = 5 * 60
TRIAL_PREFIX = "cad-eval-"  # every trial root is mkdtemp(prefix=TRIAL_PREFIX) in the temp directory


def _forms(path: Path) -> list[str]:
    """`path` as given and resolved (macOS `/var` is `/private/var`), longest first."""
    return sorted({str(path), str(path.resolve())}, key=len, reverse=True)


def _whole(path: str) -> str:
    """A regex for `path` as a whole path, never the prefix of a longer name."""
    return re.escape(path) + r"(?![\w.-])"


class Redactor:
    """The one scrub every record writer applies: results and errors rows, traces, raw
    streams, and the smoke, probe and judge records. A credential value the runner
    exported becomes `<redacted>`, a trial root `<trial>`, the temp directory `$TMPDIR`
    and the user's home `~`, so a model that prints its environment, or a harness that
    echoes paths, leaves neither a secret nor the user's layout on disk."""

    def __init__(self, home: Path):
        temp = _forms(Path(tempfile.gettempdir()))
        self._paths = [
            (
                re.compile(
                    "|".join(
                        re.escape(f"{t}/{TRIAL_PREFIX}") + "[A-Za-z0-9_]+" for t in temp
                    )
                ),
                "<trial>",
            ),
            (re.compile("|".join(map(_whole, temp))), "$TMPDIR"),
            (re.compile("|".join(map(_whole, _forms(home)))), "~"),
        ]
        self._secrets: set[str] = set()
        self._lock = threading.Lock()

    def add_secrets(self, values: Iterable[str]) -> None:
        with self._lock:
            self._secrets.update(v for v in values if v)

    def __call__(self, value):
        with self._lock:
            secrets = sorted(self._secrets, key=len, reverse=True)
        return self._scrub(value, secrets)

    def _scrub(self, value, secrets: list[str]):
        if isinstance(value, str):
            for secret in secrets:
                value = value.replace(secret, "<redacted>")
            for pattern, replacement in self._paths:
                value = pattern.sub(replacement, value)
            return value
        if isinstance(value, dict):
            return {
                self._scrub(k, secrets): self._scrub(v, secrets)
                for k, v in value.items()
            }
        if isinstance(value, (list, tuple)):
            return [self._scrub(v, secrets) for v in value]
        return value


class HostSource:
    """Exports temporary profile credentials and serves them through a loopback endpoint."""

    def __init__(self, auth: dict):
        self.profile = auth.get("aws_profile") or os.environ.get("AWS_PROFILE")
        self.region = auth.get("aws_region", "us-east-1")
        self.redact = Redactor(Path.home())
        self._lock = threading.Lock()
        self._aws: dict[str, str] = {}
        self._expires: datetime | None = None
        self._endpoint: CredentialEndpoint | None = None
        self._base = self._base_env()

    @staticmethod
    def _base_env() -> dict[str, str]:
        env = {k: os.environ[k] for k in _HOST_KEEP if k in os.environ}
        for var, args in (
            ("UV_CACHE_DIR", ["cache", "dir"]),
            ("UV_PYTHON_INSTALL_DIR", ["python", "dir"]),
        ):
            try:  # toolchain caches, so `uv run` in a trial does not re-download kernels
                out = subprocess.run(
                    ["uv", *args],
                    capture_output=True,
                    text=True,
                    check=True,
                    timeout=30,
                ).stdout.strip()
            except (OSError, subprocess.SubprocessError):
                continue
            if out:
                env[var] = out
        return {**env, **_GIT_ENV}

    def _export_aws(self) -> None:
        try:
            done = subprocess.run(
                [
                    "aws",
                    "configure",
                    "export-credentials",
                    "--profile",
                    self.profile,
                    "--format",
                    "process",
                ],
                capture_output=True,
                text=True,
                check=True,
                timeout=120,
            )
            creds = json.loads(done.stdout)
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
            raise TrialError(
                "auth_error",
                f"could not export AWS credentials for profile {self.profile}: {exc}",
            ) from exc
        expiry = creds.get("Expiration")
        if not expiry:
            raise TrialError(
                "auth_error",
                (
                    f"profile {self.profile} exports credentials with no Expiration (long-lived access keys); trials take"
                    " temporary credentials only. Use a dedicated Bedrock-only SSO or role profile (cad/evals/README.md,"
                    ' "Credentials") through [auth] aws_profile or --aws-profile'
                ),
            )
        self._aws = {
            "AccessKeyId": creds["AccessKeyId"],
            "SecretAccessKey": creds["SecretAccessKey"],
        }
        if creds.get("SessionToken"):
            self._aws["Token"] = creds["SessionToken"]
        self.redact.add_secrets(self._aws.values())
        self._expires = datetime.fromisoformat(expiry)
        if self._expires.tzinfo is None:
            self._expires = self._expires.replace(tzinfo=timezone.utc)

    def _expires_within(self, seconds: float) -> bool:
        """Whether the exported credentials lapse within `seconds` plus the refresh margin."""
        return (
            self._expires is None
            or self._expires.timestamp() - time.time()
            <= seconds + _CRED_REFRESH_MARGIN_S
        )

    def _container_credentials(self) -> dict[str, str]:
        with self._lock:
            if self._expires_within(0):
                self._export_aws()
            return {
                "AccessKeyId": self._aws["AccessKeyId"],
                "SecretAccessKey": self._aws["SecretAccessKey"],
                "Token": self._aws.get("Token", ""),
                "Expiration": self._expires.isoformat(),
            }

    def force_near_expiry(self) -> None:
        with self._lock:
            self._expires = datetime.now(timezone.utc) + timedelta(minutes=1)

    def get(
        self,
        ceiling_s: float | None = None,
        *,
        static: bool = False,
        refresh: bool = False,
    ) -> adapters.Host:
        with self._lock:
            # Static keys cannot refresh inside a trial, so they must outlive its ceiling.
            if self.profile and (
                not self._aws
                or refresh
                or (static and self._expires_within(ceiling_s or 0))
            ):
                self._export_aws()
            aws_env = {"AWS_REGION": self.region, "AWS_DEFAULT_REGION": self.region}
            if self.profile and static:
                aws_env.update(
                    {
                        "AWS_ACCESS_KEY_ID": self._aws["AccessKeyId"],
                        "AWS_SECRET_ACCESS_KEY": self._aws["SecretAccessKey"],
                        **(
                            {"AWS_SESSION_TOKEN": self._aws["Token"]}
                            if self._aws.get("Token")
                            else {}
                        ),
                    }
                )
            elif self.profile:
                if self._endpoint is None:
                    self._endpoint = CredentialEndpoint(self)
                aws_env.update(self._endpoint.env)
            return adapters.Host(
                base_env=dict(self._base), aws_env=aws_env, real_home=Path.home()
            )

    def close(self) -> None:
        if self._endpoint is not None:
            endpoint, self._endpoint = self._endpoint, None
            endpoint.close()


class CredentialEndpoint:
    """Authenticated, runner-owned ECS-shape credentials endpoint on loopback."""

    def __init__(self, source: HostSource):
        self._requests = 0
        self._request_lock = threading.Lock()
        self._token = secrets.token_urlsafe(32)
        source.redact.add_secrets([self._token])
        endpoint = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                with endpoint._request_lock:
                    endpoint._requests += 1
                if self.path != "/credentials" or not hmac.compare_digest(
                    self.headers.get("Authorization", ""),
                    self.server.token,
                ):
                    self.send_error(403)
                    return
                try:
                    payload = json.dumps(source._container_credentials()).encode(
                        "utf-8"
                    )
                except TrialError:
                    self.send_error(503)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, format, *args):
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self._server.token = self._token
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        host, port = self._server.server_address
        self.env = {
            "AWS_CONTAINER_CREDENTIALS_FULL_URI": f"http://{host}:{port}/credentials",
            "AWS_CONTAINER_AUTHORIZATION_TOKEN": self._token,
        }

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)


# ---------------------------------------------------------------- one trial


def stage_trial(
    case: dict | None, adapter, host: adapters.Host, *, require_plugin: bool
) -> TrialPaths:
    root = Path(tempfile.mkdtemp(prefix=TRIAL_PREFIX))
    paths = TrialPaths(
        root=root,
        work=root / "work",
        plugin=root / "cad",
        state=root / "state",
        home=root / "home",
    )
    try:
        if PLUGIN_ROOT.is_dir():
            shutil.copytree(PLUGIN_ROOT, paths.plugin, ignore=_STAGE_IGNORE)
        else:
            paths.plugin.mkdir()
        if require_plugin and not (paths.plugin / adapter.plugin_marker).exists():
            raise TrialError(
                "plugin_missing",
                f"{adapter.name} needs {adapter.plugin_marker} under {PLUGIN_ROOT}",
            )
        paths.work.mkdir()
        paths.home.mkdir()
        paths.tmp.mkdir()
        if case is not None:
            shutil.copytree(case["_seed"], paths.work, dirs_exist_ok=True)
        adapter.prepare(paths, host)
        # The baseline commit includes the harness files prepare() placed in the sandbox,
        # so the agent's own changes are the only diff.
        _git(paths, host, "init", "-q")
        _git(paths, host, "add", "-A")
        _git(
            paths,
            host,
            "-c",
            "user.name=cad-eval",
            "-c",
            "user.email=cad-eval@invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            f"core.hooksPath={os.devnull}",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "seed",
        )
    except BaseException:
        # A trial that never started still holds what prepare() copied in (the Kiro login).
        shutil.rmtree(root, ignore_errors=True)
        raise
    return paths


def _git(paths: TrialPaths, host: adapters.Host, *args: str) -> None:
    """git in the trial's work tree with none of the user's git setup: no global or
    system config (hooksPath, gpgsign, templates, excludes) and only the host
    allowlist in the environment, so no inherited GIT_DIR or GIT_INDEX_FILE."""
    env = {
        **host.base_env,
        "HOME": str(paths.home),
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_NOSYSTEM": "1",
    }
    subprocess.run(
        ["git", *args], cwd=paths.work, env=env, check=True, capture_output=True
    )


def run_probe(
    adapter,
    paths: TrialPaths,
    host: adapters.Host,
    model: str,
    first_stream: list[str],
    timeout_s: float = 120,
) -> list[str]:
    """Run the adapter's model-free inventory commands after the first turn; one stdout
    per command, '' for a command that failed (an empty inventory fails closed as
    contaminated, it is not a trial error)."""
    outputs = []
    for argv, stdin in adapter.probe(paths, model, first_stream):
        try:
            done = subprocess.run(
                argv,
                cwd=paths.work,
                env=adapter.env(paths, host),
                input=stdin,
                capture_output=True,
                text=True,
                timeout=timeout_s,
                check=False,
            )
            outputs.append(done.stdout)
        except (OSError, subprocess.TimeoutExpired):
            outputs.append("")
    return outputs


def harness_version(
    adapter, paths: TrialPaths, host: adapters.Host, timeout_s: float = 60
) -> str | None:
    """The harness version from its own CLI, run model-free in the trial's environment;
    None when the adapter has no version command (its stream reports one) or it failed."""
    argv = adapter.version_command()
    if not argv:
        return None
    try:
        done = subprocess.run(
            argv,
            cwd=paths.work,
            env=adapter.env(paths, host),
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return adapters.parse_version(done.stdout) if done.returncode == 0 else None


def run_turn(
    adapter, argv: list[str], paths: TrialPaths, host: adapters.Host, timeout_s: float
) -> tuple[Turn, list[str], str]:
    """Run one harness invocation; return the parsed turn, raw stdout lines and stderr."""
    if timeout_s <= 0:
        raise TrialError(
            "timeout", "case wall-clock ceiling reached before the turn started"
        )
    env = adapter.env(paths, host)
    try:
        proc = subprocess.Popen(
            argv,
            cwd=paths.work,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
    except OSError as exc:
        raise TrialError("adapter_error", f"could not start {argv[0]}: {exc}") from exc
    with (
        proc
    ):  # closes the pipes and reaps the leader on every exit path, the timeout included
        try:
            stdout, stderr = proc.communicate(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            raise TrialError(
                "timeout",
                f"turn exceeded the {timeout_s:.0f}s remaining in the case ceiling",
            ) from None
        finally:
            _end_group(proc)
    lines = stdout.splitlines()
    turn = adapter.complete(adapter.parse(lines), lines, paths, env)
    if turn.error:
        raise TrialError(
            "provider_error",
            turn.error[-800:],
            transient=bool(_TRANSIENT.search(turn.error)),
            credential_failure=bool(_EXPIRED_CREDENTIALS.search(turn.error)),
        )
    if proc.returncode != 0:
        tail = (stderr or stdout)[-800:]
        raise TrialError(
            "adapter_error",
            f"exit {proc.returncode}: {tail}",
            transient=bool(_TRANSIENT.search(tail)),
            credential_failure=bool(_EXPIRED_CREDENTIALS.search(tail)),
        )
    if not lines:
        raise TrialError("adapter_error", f"empty stream; stderr: {stderr[-800:]}")
    return turn, lines, stderr


def isolation_of(
    adapter,
    paths: TrialPaths,
    probe_outputs: list[str],
    first_stream: list[str],
    version: str | None = None,
) -> dict:
    """Row fields: `isolation` clean|contaminated, the leak list, the inventory (with
    the harness version, the bundled baseline items it loaded and the version they are
    declared for) and the mechanism. `version` is the CLI's answer, used when the
    stream reports none."""
    inventory = adapter.inventory(probe_outputs, first_stream, paths)
    inventory.version = inventory.version or version
    found, bundled = adapters.audit(inventory, paths, adapter.baseline)
    return {
        "isolation": "contaminated" if found else "clean",
        "leaks": found,
        "inventory": {
            **inventory.as_dict(),
            "version": inventory.version,
            "baseline": {"declared_for": adapter.baseline.version, "loaded": bundled},
        },
        "isolation_mechanism": adapter.isolation,
    }


def _end_group(proc: subprocess.Popen, grace_s: float = 2.0) -> None:
    """SIGTERM, then SIGKILL after `grace_s`, to the turn's whole process group, whether
    the leader timed out or already exited: what the harness left running in its group
    dies with the turn. The leader is only polled (reaped once it exits), never waited on."""
    deadline = time.monotonic() + grace_s
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(proc.pid, sig)
        except (ProcessLookupError, PermissionError):
            return
        while time.monotonic() < deadline:
            proc.poll()
            try:
                os.killpg(proc.pid, 0)
            except (ProcessLookupError, PermissionError):
                return
            time.sleep(0.05)


def trial_processes(root: Path) -> list[tuple[int, int]]:
    """(pid, pgid) of every other process whose command line names the trial root."""
    try:
        listing = subprocess.run(
            ["ps", "-ax", "-ww", "-o", "pid=", "-o", "pgid=", "-o", "command="],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        ).stdout
    except (OSError, subprocess.TimeoutExpired):
        return []
    names = re.compile("|".join(map(_whole, _forms(root))))
    found = []
    for line in listing.splitlines():
        fields = line.split(None, 2)
        if (
            len(fields) == 3
            and fields[0].isdigit()
            and fields[1].isdigit()
            and names.search(fields[2])
        ):
            if int(fields[0]) != os.getpid():
                found.append((int(fields[0]), int(fields[1])))
    return found


def _signal(pid: int, pgid: int, sig: int) -> None:
    """Signal a process, or the whole group when it leads one of its own (a detached
    viewer host, whose OCP viewers and Chromium share its group)."""
    try:
        if pid == pgid and pgid != os.getpgrp():
            os.killpg(pgid, sig)
        else:
            os.kill(pid, sig)
    except (ProcessLookupError, PermissionError):
        pass


def sweep_trial_processes(root: Path, grace_s: float = 2.0) -> None:
    """SIGTERM, then SIGKILL after `grace_s`, to every process still naming the trial
    root, with the groups they lead: what escaped the turn's own group, such as a
    detached cad-viewer host or a cad-concept server started from the trial's plugin."""
    found = trial_processes(root)
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for pid, pgid in found:
            _signal(pid, pgid, sig)
        deadline = time.monotonic() + grace_s
        while found and time.monotonic() < deadline:
            time.sleep(0.1)
            found = trial_processes(root)
        if not found:
            return


VIEWER = Path("skills", "cad-viewer", "scripts", "viewer.py")


def stop_trial_processes(paths: TrialPaths, env: dict[str, str]) -> None:
    """Stop what a trial left running once its turns are over. Viewer session files are
    keyed by project and harness session, so the runner stops each one under the trial's
    XDG_STATE_HOME by path: `viewer.py stop` with CAD_VIEWER_SESSION naming it shuts that
    host down cleanly. `stop` is the script's stdlib-only path, so the runner's own
    interpreter runs it without building a uv environment. The sweep then ends
    whatever still names the trial root."""
    viewer = paths.plugin / VIEWER
    state = Path(env.get("XDG_STATE_HOME", "")) / "cad-viewer"
    if viewer.is_file() and state.is_dir():
        for session_file in sorted(state.glob("*/session.json")):
            try:
                subprocess.run([sys.executable, str(viewer), "stop"], cwd=paths.work,
                               env={**env, "CAD_VIEWER_SESSION": str(session_file)},
                               capture_output=True, timeout=60, check=False)
            except (OSError, subprocess.TimeoutExpired):
                pass
    sweep_trial_processes(paths.root)


def end_trial(paths: TrialPaths, adapter, host: adapters.Host, *, keep: bool) -> bool:
    """Stop trial processes, record login refresh, remove or retain the sandbox."""
    stop_trial_processes(paths, adapter.env(paths, host))
    refreshed = adapter.release_login(paths)
    if keep:
        print(f"kept sandbox {paths.root}", file=sys.stderr)
    else:
        shutil.rmtree(paths.root, ignore_errors=True)
    return refreshed


def _links(directory: str, names: list[str]) -> set[str]:
    return {name for name in names if os.path.islink(os.path.join(directory, name))}


def collect_artifacts(src: Path, dst: Path) -> None:
    """Copy the case's deliverables for the judge. Symlinks are left out, `src` itself
    included, so a link the agent made (hw/x -> ~/.aws, or -> /) copies nothing from
    outside the trial."""
    if src.is_dir() and not src.is_symlink():
        shutil.copytree(src, dst, ignore=_links, dirs_exist_ok=True)


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


def converse(
    case: dict,
    cell: Cell,
    adapter,
    paths: TrialPaths,
    host: adapters.Host,
    *,
    ceiling_s: float,
    max_turns: int,
) -> Conversation:
    """First prompt, then scripted gate answers while the agent's reply asks for one."""
    deadline = time.monotonic() + ceiling_s
    uses = [0] * len(case["gate_answers"])
    conv = Conversation()
    prompt, resume = case["prompt"], False
    for _ in range(max_turns):
        argv = adapter.command(
            model=cell.model, prompt=prompt, paths=paths, resume=resume
        )
        turn, lines, _ = run_turn(
            adapter, argv, paths, host, deadline - time.monotonic()
        )
        conv.turns.append(turn)
        conv.raw.append(lines)
        conv.transcript.append({"role": "user", "content": prompt})
        conv.transcript.extend(
            e
            for e in turn.transcript
            if not (e["role"] == "user" and e["content"] == prompt)
        )
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


def attempt(
    case: dict,
    cell: Cell,
    adapter,
    cfg: dict,
    artifact_dir: Path,
    keep: bool,
    host_source: HostSource,
    *,
    refresh_credentials: bool = False,
) -> Scored:
    ceiling_s = float(cfg["case_timeout_s"])
    host = host_source.get(
        ceiling_s,
        static=cell.harness in {"opencode", "claude"},
        refresh=refresh_credentials,
    )
    refusal = adapter.preflight(host, ceiling_s)
    if refusal:
        raise TrialError("auth_error", refusal)
    paths = stage_trial(case, adapter, host, require_plugin=True)
    row = None
    try:
        started = time.monotonic()
        conv = converse(
            case,
            cell,
            adapter,
            paths,
            host,
            ceiling_s=ceiling_s,
            max_turns=int(cfg["max_turns"]),
        )
        latency = round(time.monotonic() - started, 3)
        probe_outputs = run_probe(adapter, paths, host, cell.model, conv.raw[0])
        version = harness_version(adapter, paths, host)
        served = conv.model
        if served is None:
            raise TrialError(
                "model_unverified", f"{cell.harness} stream carried no served model"
            )
        if not adapters.served_matches(cell.model, served, cell.expect):
            raise TrialError(
                "model_mismatch", f"requested {cell.model}, served {served}"
            )
        if any(
            marker in line
            for lines in conv.raw
            for line in lines
            for marker in TRUTH_MARKERS
        ):
            raise TrialError(
                "truth_leak", "the harness stream references the hidden truth directory"
            )
        try:
            graded = grade_trial(
                case,
                paths.work,
                load_truth(case),
                VALIDATOR if VALIDATOR.is_file() else None,
            )
        except GraderError as exc:
            raise TrialError("grader_error", str(exc)) from exc
        collect_artifacts(
            paths.work / case["deliverables"].get("collect", "hw"), artifact_dir
        )
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
            **isolation_of(adapter, paths, probe_outputs, conv.raw[0], version),
        }
        return Scored(row, conv.transcript, conv.raw)
    finally:
        refreshed = end_trial(paths, adapter, host, keep=keep)
        if row is not None and cell.harness == "kiro" and refreshed:
            row["inventory"]["kiro_login_refreshed"] = True


# ---------------------------------------------------------------- slots and sinks


class Sink:
    """The writer of one cell directory: thread-safe append-only JSONL rows, and the
    traces and raw streams of traced slots. Every record passes `redact` first."""

    def __init__(self, out: Path, redact: Redactor):
        self.out = out
        self.redact = redact
        out.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def append(self, name: str, row: dict) -> None:
        line = json.dumps(self.redact(row), sort_keys=True, ensure_ascii=False)
        with self._lock, (self.out / name).open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")

    def trace(self, slot: str, scored: Scored) -> None:
        (self.out / "traces").mkdir(exist_ok=True)
        transcript = json.dumps(
            self.redact(scored.transcript), ensure_ascii=False, indent=1
        )
        (self.out / "traces" / f"{slot}.json").write_text(transcript, encoding="utf-8")
        (self.out / "raw").mkdir(exist_ok=True)
        for n, lines in enumerate(self.redact(scored.raw), 1):
            (self.out / "raw" / f"{slot}_t{n}.jsonl").write_text(
                "\n".join(lines) + "\n", encoding="utf-8"
            )


def done_slots(cell_dir: Path) -> set[tuple[str, int]]:
    return {(r["prompt_id"], r["rep"]) for r in read_rows(cell_dir)}


def backoff_s(attempt_no: int, retry: dict, rng: random.Random) -> float:
    base, cap = float(retry.get("base_s", 10)), float(retry.get("max_s", 120))
    return min(cap, base * 2 ** (attempt_no - 1)) * rng.uniform(0.5, 1.5)


def run_slot(
    case: dict,
    rep: int,
    cell: Cell,
    adapter,
    cfg: dict,
    sink: Sink,
    *,
    trace: bool,
    keep: bool,
    rng: random.Random,
    host_source: HostSource,
) -> str:
    retry = cfg.get("retry", {})
    max_attempts = int(retry.get("attempts", 3))
    slot = f"{case['id']}_rep{rep}"
    credential_retried = False
    retry_log: list[dict] = []
    for attempt_no in range(1, max_attempts + 1):
        artifact_dir = sink.out / "artifacts" / slot
        shutil.rmtree(artifact_dir, ignore_errors=True)
        started = time.monotonic()
        try:
            scored = attempt(
                case,
                cell,
                adapter,
                cfg,
                artifact_dir,
                keep,
                host_source,
                refresh_credentials=credential_retried,
            )
        except Exception as exc:
            error = (
                exc
                if isinstance(exc, TrialError)
                else TrialError("runner_error", f"{type(exc).__name__}: {exc}")
            )
            if (
                error.credential_failure
                and attempt_no < max_attempts
                and not credential_retried
                and cell.harness in {"opencode", "claude"}
            ):
                retry_log.append(
                    {
                        "kind": "credential_refresh",
                        "failure_class": error.failure_class,
                        "detail": error.detail,
                        "at": _now(),
                    }
                )
                credential_retried = True
                continue
            if (
                error.transient
                and not (error.credential_failure and credential_retried)
                and attempt_no < max_attempts
            ):
                time.sleep(backoff_s(attempt_no, retry, rng))
                continue
            error_row = {
                "prompt_id": case["id"],
                "rep": rep,
                "tags": case["tags"],
                "harness": cell.harness,
                "requested_model": cell.model,
                "failure_class": error.failure_class,
                "detail": error.detail,
                "transient": error.transient,
                "retries": attempt_no - 1,
                "retry_log": retry_log,
                "latency_s": round(time.monotonic() - started, 3),
                "at": _now(),
            }
            sink.append("errors.jsonl", error_row)
            return error.failure_class
        row = {
            "prompt_id": case["id"],
            "rep": rep,
            **scored.row,
            "retries": attempt_no - 1,
        }
        if retry_log:
            row["retry_log"] = retry_log
        if trace:
            sink.trace(slot, scored)
        sink.append("results.jsonl", row)
        return "ok"
    raise AssertionError("unreachable: the last attempt always records")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def plan_slots(
    cells: list[Cell], cases: list[dict], reps: int, out: Path
) -> list[tuple[Cell, dict, int]]:
    """Every (cell, case, rep) not already scored; errored slots are retried on resume."""
    slots = []
    for cell in cells:
        done = done_slots(out / cell.slug)
        slots += [
            (cell, case, rep)
            for case in cases
            for rep in range(1, reps + 1)
            if (case["id"], rep) not in done
        ]
    return slots


def run_matrix(
    matrix: Matrix,
    cells: list[Cell],
    cases: list[dict],
    reps: int,
    out: Path,
    *,
    trace_ids: set[str] | None,
    concurrency: int,
    keep: bool,
    seed: int | None = None,
    host_source: HostSource | None = None,
) -> dict[str, int]:
    """Run every pending slot with bounded concurrency; return failure-class counts.

    `trace_ids=None` writes traces for every case; otherwise only ids in the set are
    retained. A harness whose preflight refuses has none of its cells started; its
    reason goes to stderr and slots count as `not_started`. Profile credentials are
    exported at run start; OpenCode and Claude Code receive static keys that outlive
    the case ceiling, re-exported when the cached ones would not, and retry one
    expired-token error with a fresh export.
    """
    cfg = {
        key: matrix.raw.get(key, default)
        for key, default in (("case_timeout_s", 1800), ("max_turns", 4), ("retry", {}))
    }
    host_source = host_source or HostSource(matrix.raw.get("auth", {}))
    sinks = {cell.slug: Sink(out / cell.slug, host_source.redact) for cell in cells}
    built = {
        cell.harness: adapters.build(cell.harness, matrix.harness_cfg(cell.harness))
        for cell in cells
    }
    rng = random.Random(seed)
    pending = plan_slots(cells, cases, reps, out)
    host = host_source.get()
    refused = {
        harness: reason
        for harness in sorted({cell.harness for cell, _, _ in pending})
        if (reason := built[harness].preflight(host, float(cfg["case_timeout_s"])))
    }
    slots = [
        (*slot, rng.random()) for slot in pending if slot[0].harness not in refused
    ]
    counts: dict[str, int] = (
        {"not_started": len(pending) - len(slots)} if refused else {}
    )
    lock = threading.Lock()

    def record_not_started(slot, reason: str) -> None:
        cell, case, rep = slot
        sinks[cell.slug].append(
            "errors.jsonl",
            {
                "prompt_id": case["id"],
                "rep": rep,
                "tags": case["tags"],
                "harness": cell.harness,
                "requested_model": cell.model,
                "failure_class": "auth_error",
                "detail": reason,
                "transient": False,
                "retries": 0,
                "not_started": True,
                "at": _now(),
            },
        )

    for harness, reason in refused.items():
        print(f"{harness}: cells not started: {reason}", file=sys.stderr)
        for cell, case, rep in pending:
            if cell.harness == harness:
                record_not_started((cell, case, rep), reason)
    def one(slot):
        cell, case, rep, slot_seed = slot
        trace = trace_ids is None or case["id"] in trace_ids
        outcome = run_slot(
            case,
            rep,
            cell,
            built[cell.harness],
            cfg,
            sinks[cell.slug],
            trace=trace,
            keep=keep,
            rng=random.Random(slot_seed),
            host_source=host_source,
        )
        with lock:
            counts[outcome] = counts.get(outcome, 0) + 1

    with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
        list(pool.map(one, slots))
    host_source.close()
    return counts


# ---------------------------------------------------------------- comparisons


def read_rows(cell_dir: Path) -> list[dict]:
    path = cell_dir / "results.jsonl"
    if not path.is_file():
        return []
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def cell_isolation(rows: list[dict]) -> tuple[str, list[str]]:
    """A cell is clean only when every scored row is; a row without the tag
    predates isolation and counts as contaminated."""
    found = sorted(
        {
            leak
            for r in rows
            for leak in (
                r.get("leaks")
                or ([] if r.get("isolation") == "clean" else ["untagged row"])
            )
        }
    )
    clean = bool(rows) and all(r.get("isolation") == "clean" for r in rows)
    return ("clean" if clean else "contaminated"), found


class Contaminated(Exception):
    """A comparison was asked to include a contaminated cell without --allow-contaminated."""


def require_comparable(
    cell_dirs: list[Path], allow_contaminated: bool
) -> dict[Path, tuple[str, list[str]]]:
    status = {d: cell_isolation(read_rows(d)) for d in cell_dirs}
    bad = {d: s for d, s in status.items() if s[0] != "clean"}
    if bad and not allow_contaminated:
        detail = "; ".join(
            f"{d.name}: {', '.join(s[1][:5]) or 'no rows'}" for d, s in bad.items()
        )
        raise Contaminated(
            f"contaminated cells excluded from comparison (pass --allow-contaminated to include): {detail}"
        )
    return status


def summarize(out: Path, allow_contaminated: bool) -> dict:
    """Per-cell pass rate and mean score; contaminated cells are listed but left out
    of `cells` unless allowed."""
    included, excluded = [], []
    for cell_dir in sorted(p for p in out.iterdir() if (p / "results.jsonl").is_file()):
        rows = read_rows(cell_dir)
        isolation, found = cell_isolation(rows)
        entry = {
            "cell": cell_dir.name,
            "n": len(rows),
            "isolation": isolation,
            "leaks": found,
            "pass_rate": round(sum(r["grade"]["pass"] for r in rows) / len(rows), 4),
            "mean_score": round(sum(r["grade"]["score"] for r in rows) / len(rows), 4),
        }
        (included if isolation == "clean" or allow_contaminated else excluded).append(
            entry
        )
    return {"cells": included, "excluded_contaminated": excluded}
