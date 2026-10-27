"""Pre-flight checks for the cad eval harness (ratchet Phase 2 step 5).

Run: python3 -m unittest discover -s cad/evals/tests -v
Needs `uv` on PATH. Geometry tests build the three oracles (CadQuery 2.8 and
build123d 0.13 environments) and read STEP back through OCCT. Built STEP files are
cached by model-source hash in ~/.cache/cad-evals/oracle-steps (CAD_EVALS_ORACLE_CACHE),
so only the first run pays the kernel imports. CAD_EVALS_SKIP_GEOMETRY=1 runs only
the fast, model-free checks. No model is called.
"""

from __future__ import annotations

import functools
import gc
import hashlib
import io
import json
import os
import random
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import warnings
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

EVALS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EVALS))

import adapters  # noqa: E402
import run  # noqa: E402
import runner  # noqa: E402
from adapters import kiro  # noqa: E402
from adapters.base import Baseline, Turn  # noqa: E402
from adapters.claude import canonical_model  # noqa: E402
from graders import judge  # noqa: E402
from graders.score import METRICS, ap242_header, grade_trial, resolve_step  # noqa: E402

FAKE_AGENT = Path(__file__).with_name("fake_agent.py")
FIXTURES = Path(__file__).with_name("fixtures")
# What each harness's CLI reported when the fixture streams were recorded; Claude
# Code reports its own version in system/init.
RECORDED_VERSIONS = {"omp": "18.12.3", "kiro": "2.34.0", "opencode": "2.1.4"}
SKIP_GEOMETRY = os.environ.get("CAD_EVALS_SKIP_GEOMETRY") == "1"
geometry = unittest.skipIf(SKIP_GEOMETRY, "CAD_EVALS_SKIP_GEOMETRY=1")
_SCRATCH = Path(tempfile.mkdtemp(prefix="cad-eval-test-"))


def tearDownModule():
    shutil.rmtree(_SCRATCH, ignore_errors=True)


# A kernel import costs minutes on a loaded machine (CadQuery pulls in VTK), so built
# STEP files are cached by the SHA-256 of the model source: an edit rebuilds.
ORACLE_CACHE = Path(os.environ.get("CAD_EVALS_ORACLE_CACHE", Path.home() / ".cache" / "cad-evals" / "oracle-steps"))


def build_model(model: Path) -> None:
    """Run a part model that writes `<PN>.step` beside itself, reusing a cached build."""
    step = model.with_name(f"{model.parent.name}.step")
    cached = ORACLE_CACHE / hashlib.sha256(model.read_bytes()).hexdigest() / step.name
    if not cached.is_file():
        subprocess.run(["uv", "run", "--quiet", "--script", str(model)], check=True, capture_output=True, timeout=1800)
        cached.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(step, cached)
    shutil.copy(cached, step)


@functools.cache
def oracle_answer(case_id: str) -> Path:
    """The seed record plus the hidden reference answer, its model run to produce the
    STEP. Built once per test run and copied by callers that change it."""
    case = runner.load_cases([case_id])[0]
    dest = _SCRATCH / "oracle" / case_id
    shutil.copytree(case["_seed"], dest, dirs_exist_ok=True)
    shutil.copytree(case["_truth"] / "oracle", dest, dirs_exist_ok=True)
    build_model(dest / "hw" / "parts" / case["deliverables"]["pn"] / "model.py")
    return dest


def copy_of(source: Path, name: str) -> Path:
    dest = _SCRATCH / name
    shutil.rmtree(dest, ignore_errors=True)
    shutil.copytree(source, dest)
    return dest


def grade(case: dict, work: Path):
    return grade_trial(case, work, runner.load_truth(case), runner.VALIDATOR if runner.VALIDATOR.is_file() else None)


class StaticHost:
    """A HostSource stand-in: no AWS export, PATH only, and its own redactor."""

    def __init__(self, home: Path):
        self.home = home
        self.redact = runner.Redactor(home)

    def get(self, ceiling_s: float | None = None) -> adapters.Host:
        return adapters.Host(base_env={"PATH": os.environ["PATH"], **runner._GIT_ENV}, aws_env={}, real_home=self.home)


def exported_source(creds: dict) -> runner.HostSource:
    """A real HostSource whose `aws configure export-credentials` answers `creds`."""
    real_run = subprocess.run

    def run(argv, *args, **kwargs):
        if argv[:3] == ["aws", "configure", "export-credentials"]:
            return subprocess.CompletedProcess(argv, 0, stdout=json.dumps(creds), stderr="")
        return real_run(argv, *args, **kwargs)

    source = runner.HostSource({"aws_profile": "cad-eval-test"})
    with mock.patch.object(subprocess, "run", side_effect=run):
        source.get()
    return source


class CredentialLifetime(unittest.TestCase):
    def fake_source(self, expiries: list[datetime], *, never_refresh: bool = False) -> tuple[runner.HostSource, list[datetime]]:
        source = runner.HostSource({"aws_profile": "cad-eval-test"})
        exports: list[datetime] = []

        def export() -> None:
            index = min(len(exports), len(expiries) - 1) if never_refresh else len(exports)
            expiry = expiries[index]
            exports.append(expiry)
            self._export_credentials(source, index, expiry)

        source._export_aws = export
        return source, exports


    def test_cached_credentials_wait_for_fresh_credentials_before_trial(self):
        now = datetime.now(timezone.utc)
        short = now + timedelta(minutes=20)
        fresh = now + timedelta(hours=1)
        source, exports = self.fake_source([short, short, fresh])
        clock = [now.timestamp()]
        with mock.patch.object(runner.time, "time", side_effect=lambda: clock[0]), \
                mock.patch.object(runner.time, "monotonic", side_effect=lambda: clock[0]), \
                mock.patch.object(runner.time, "sleep", side_effect=lambda duration: clock.__setitem__(0, clock[0] + duration)):
            host = source.get(1800)
        self.assertEqual(host.aws_env["AWS_ACCESS_KEY_ID"], "ASIAEXAMPLE2")

    def test_credentials_that_never_refresh_leave_slot_not_started(self):
        now = datetime.now(timezone.utc)
        short = now + timedelta(minutes=20)
        source, _ = self.fake_source([short], never_refresh=True)
        with mock.patch.object(runner, "_CRED_POLL_S", 1), mock.patch.object(runner, "_CRED_MAX_WAIT_S", 2), \
                mock.patch.object(runner.time, "time", return_value=now.timestamp()), \
                mock.patch.object(runner.time, "monotonic", side_effect=[0, 0, 1, 1, 2, 2, 3]), \
                mock.patch.object(runner.time, "sleep", return_value=None), \
                mock.patch.object(adapters.OmpAdapter, "prepare") as prepare:
            with self.assertRaises(runner.CredentialsUnavailable) as caught:
                source.get(1800)
        self.assertIn("did not issue AWS credentials", str(caught.exception))
        self.assertEqual(source._credential_refusal, caught.exception.detail)
        prepare.assert_not_called()

    def test_unrenewed_credentials_keep_slot_pending_for_resume(self):
        now = datetime.now(timezone.utc)
        short = now + timedelta(minutes=20)
        source, _ = self.fake_source([short], never_refresh=True)
        matrix = runner.Matrix({"harness": {"omp": {"bin": str(FAKE_AGENT)}}, "case_timeout_s": 1800,
                                "max_turns": 4, "retry": {"attempts": 1}}, [runner.Cell("omp", "model")])
        cell = matrix.cells[0]
        out = Path(tempfile.mkdtemp(prefix="cad-eval-credential-pending-"))
        self.addCleanup(shutil.rmtree, out, True)
        with mock.patch.object(runner, "_CRED_POLL_S", 1), mock.patch.object(runner, "_CRED_MAX_WAIT_S", 2), \
                mock.patch.object(runner.time, "time", return_value=now.timestamp()), \
                mock.patch.object(runner.time, "monotonic", side_effect=[0, 0, 1, 1, 2, 2, 3]), \
                mock.patch.object(runner.time, "sleep", return_value=None), \
                mock.patch.object(adapters.OmpAdapter, "prepare") as prepare:
            counts = runner.run_matrix(matrix, [cell], [runner.load_cases(["t1-lower-link-cq"])[0]], 1, out,
                                       trace_ids=set(), concurrency=1, keep=False, host_source=source)
        self.assertEqual(counts, {"not_started": 1})
        self.assertEqual(runner.plan_slots([cell], runner.load_cases(["t1-lower-link-cq"]), 1, out)[0][0], cell)
        self.assertEqual(runner.plan_slots([cell], runner.load_cases(["t1-lower-link-cq"]), 1, out)[0][2], 1)
        self.assertFalse((out / cell.slug / "errors.jsonl").exists())
        prepare.assert_not_called()

    def test_fresh_credentials_start_without_wait(self):
        now = datetime.now(timezone.utc)
        source, exports = self.fake_source([now + timedelta(hours=1)])
        with mock.patch.object(runner.time, "time", return_value=now.timestamp()), \
                mock.patch.object(runner.time, "sleep") as sleep:
            host = source.get(1800)
        self.assertEqual(host.aws_env["AWS_ACCESS_KEY_ID"], "ASIAEXAMPLE0")
        self.assertEqual(len(exports), 1)
        sleep.assert_not_called()

    @staticmethod
    def _export_credentials(source: runner.HostSource, index: int, expiry: datetime) -> None:
        source._aws = {"AWS_ACCESS_KEY_ID": f"ASIAEXAMPLE{index}", "AWS_SECRET_ACCESS_KEY": f"secret{index}",
                       "AWS_SESSION_TOKEN": f"token{index}", "AWS_REGION": source.region,
                       "AWS_DEFAULT_REGION": source.region}
        source._expires = expiry


def gone(pid: int, timeout_s: float = 10) -> bool:
    """True once `pid` no longer exists (init reaps an orphan's zombie)."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        time.sleep(0.05)
    return False


def kill_if_running(pid: int) -> None:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def make_kiro_login(home: Path) -> Path:
    """A user Kiro store as `kiro-cli login` leaves it (token row, sign-in state, history); returns the database."""
    store = home.joinpath("Library", "Application Support", "kiro-cli")
    store.mkdir(parents=True)
    db = store / "data.sqlite3"
    con = sqlite3.connect(db)
    con.executescript("""
        CREATE TABLE migrations (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, migration_time INTEGER NOT NULL);
        CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE state (key TEXT PRIMARY KEY, value BLOB);
        CREATE TABLE conversations_v2 (key TEXT NOT NULL, conversation_id TEXT NOT NULL, value TEXT NOT NULL,
                                       PRIMARY KEY (key, conversation_id));
        CREATE INDEX idx_conversations_v2_key ON conversations_v2(key);
        INSERT INTO migrations VALUES (1, 1, 0);
        INSERT INTO auth_kv VALUES ('kirocli:odic:token', '{"access_token": "a"}');
        INSERT INTO state VALUES ('auth.idc.region', '"us-east-1"'), ('api.codewhisperer.profile', '{}'), ('telemetryClientId', '"x"');
        INSERT INTO conversations_v2 VALUES ('/user/project', 'c1', '{}');
    """)
    con.close()
    return db


@geometry
class OracleAndNull(unittest.TestCase):
    """The reference answer scores ~100%, an empty answer ~0%, and grading is stable."""

    @classmethod
    def setUpClass(cls):
        cls.cases = runner.load_cases()

    def test_three_seed_cases_cover_both_kernels(self):
        self.assertEqual(len(self.cases), 3)
        self.assertEqual({c["kernel"] for c in self.cases}, {"cadquery", "build123d"})

    def test_oracle_grades_full(self):
        for case in self.cases:
            with self.subTest(case=case["id"]):
                graded = grade(case, oracle_answer(case["id"]))
                self.assertEqual(graded.grade["score"], 1.0, graded.explanation)
                self.assertEqual(graded.grade["pass"], 1.0)

    def test_oracle_through_the_cad_model_build_index(self):
        """A cad-model build writes hw/versions/<v>/parts/<PN>.step and latest.json;
        the grader must follow latest.json, not the legacy path."""
        case = runner.load_cases(["t1-lower-link-cq"])[0]
        work = copy_of(oracle_answer(case["id"]), "latest-index")
        hw = work / "hw"
        legacy = hw / "parts" / "LAL-0001" / "LAL-0001.step"
        (hw / "versions" / "v1" / "parts").mkdir(parents=True)
        shutil.move(legacy, hw / "versions" / "v1" / "parts" / "LAL-0001.step")
        (hw / "versions" / "latest.json").write_text(json.dumps({"label": "v1", "parts": {"LAL-0001": "versions/v1/parts/LAL-0001.step"}}))
        graded = grade(case, work)
        self.assertEqual(graded.grade["pass"], 1.0, graded.explanation)
        # latest.json is authoritative: a stale legacy file does not rescue a missing entry.
        (hw / "versions" / "latest.json").write_text(json.dumps({"label": "v2", "parts": {}}))
        shutil.copy(hw / "versions" / "v1" / "parts" / "LAL-0001.step", legacy)
        graded = grade(case, work)
        self.assertEqual(graded.grade["step"], 0.0)
        self.assertIn("names no STEP for LAL-0001", graded.explanation)

    def test_empty_answer_grades_zero(self):
        for case in self.cases:
            with self.subTest(case=case["id"]):
                work = _SCRATCH / f"empty-{case['id']}"
                shutil.copytree(case["_seed"], work, dirs_exist_ok=True)
                graded = grade(case, work)
                self.assertEqual(graded.grade["score"], 0.0, graded.explanation)
                self.assertEqual(graded.grade["pass"], 0.0)

    def test_grading_twice_is_stable(self):
        case = runner.load_cases(["t1-base-plate-cq"])[0]
        work = oracle_answer(case["id"])
        self.assertEqual(grade(case, work), grade(case, work))

    def test_wrong_hole_diameter_fails_only_geometry(self):
        case = runner.load_cases(["t1-lower-link-cq"])[0]
        work = copy_of(oracle_answer(case["id"]), "wrong-hole")
        model = work / "hw/parts/LAL-0001/model.py"
        model.write_text(model.read_text().replace('"pin_hole": 5.5', '"pin_hole": 5.0'))
        build_model(model)
        graded = grade(case, work)
        self.assertEqual(graded.grade["holes"], 0.0)
        self.assertEqual(graded.grade["volume"], 0.0)
        self.assertEqual(graded.grade["bbox"], 1.0)
        self.assertEqual(graded.grade["record"], 1.0)
        self.assertEqual(graded.grade["pass"], 0.0)
        self.assertIn("holes", graded.explanation)

    def test_an_unparsable_step_grades_unreadable_not_as_a_grader_error(self):
        """OCCT prints the parse error on its console, which must stay off step_readback's JSON stdout."""
        case = runner.load_cases(["t1-lower-link-cq"])[0]
        work = copy_of(case["_seed"], "unparsable-step")
        step = work / case["deliverables"]["step"]
        step.parent.mkdir(parents=True, exist_ok=True)
        step.write_text("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF'));\nENDSEC;\n"
                        "DATA;\n#1=FOO(1,;\nENDSEC;\nEND-ISO-10303-21;\n", encoding="utf-8")
        graded = grade(case, work)
        self.assertEqual(graded.grade["step"], 0.0)
        self.assertIn("STEP unreadable", graded.explanation)


class StepResolution(unittest.TestCase):
    def test_latest_json_cannot_point_outside_hw(self):
        work = _SCRATCH / "escape"
        (work / "hw" / "versions").mkdir(parents=True, exist_ok=True)
        (work / "hw" / "versions" / "latest.json").write_text(json.dumps({"parts": {"LAL-0001": "../../etc/passwd"}}))
        path, why = resolve_step(work, {"pn": "LAL-0001", "step": "hw/parts/LAL-0001/LAL-0001.step"})
        self.assertIsNone(path)
        self.assertIn("outside hw/", why)

    def test_legacy_path_only_without_an_index(self):
        work = _SCRATCH / "legacy"
        (work / "hw").mkdir(parents=True, exist_ok=True)
        path, why = resolve_step(work, {"pn": "LAL-0001", "step": "hw/parts/LAL-0001/LAL-0001.step"})
        self.assertEqual(path, work / "hw/parts/LAL-0001/LAL-0001.step")
        self.assertIn("legacy", why)


class Ap242Header(unittest.TestCase):
    def test_header_variants(self):
        ap242 = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA((\n'AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF {1 0 10303 442 1 1 4 }'\n));\nENDSEC;"
        ap214 = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\nENDSEC;"
        self.assertTrue(ap242_header(ap242)[0])
        self.assertFalse(ap242_header(ap214)[0])
        self.assertFalse(ap242_header("solid ascii stl")[0])


class ServedModel(unittest.TestCase):
    def test_matching_rules(self):
        ok = [
            ("amazon-bedrock/global.anthropic.claude-opus-5-5", "global.anthropic.claude-opus-5-5"),
            ("claude-opus-5.5", "global.anthropic.claude-opus-5-5"),
            ("kimi-k3", "kimi-k3"),
            ("global.anthropic.claude-haiku-4-5", "global.anthropic.claude-haiku-4-5-20251001-v1:0"),
            ("global.anthropic.claude-opus-5-5", "claude-opus-5-5"),  # Claude Code reports the bare id
            ("amazon-bedrock/global.moonshotai.kimi-k3", "moonshotai.kimi-k3"),
        ]
        bad = [
            ("amazon-bedrock/global.anthropic.claude-opus-5", "global.anthropic.claude-opus-5-5"),
            ("global.openai.gpt-6-astra", "global.openai.gpt-6.1-sol"),
            ("kimi-k3", None),
            ("global.openai.gpt-6.1-sol", "global.openai.gpt-6-sol"),
        ]
        for want, got in ok:
            self.assertTrue(adapters.served_matches(want, got), (want, got))
        for want, got in bad:
            self.assertFalse(adapters.served_matches(want, got), (want, got))
        self.assertTrue(adapters.served_matches("opus", "claude-opus-5-5-x", expect=r"opus-5-5"))


class FakeHarness(unittest.TestCase):
    """Runner end to end against a stand-in OMP binary: errors, retries, gates, resume, isolation."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cad-eval-fake-"))
        plugin = self.tmp / "plugin"
        (plugin / ".omp-plugin").mkdir(parents=True)
        (plugin / ".omp-plugin" / "plugin.json").write_text('{"name": "cad"}')
        (plugin / "skills" / "cad-flow").mkdir(parents=True)
        (plugin / "skills" / "cad-flow" / "SKILL.md").write_text("---\nname: cad-flow\n---\n")
        (plugin / "agents").mkdir()
        (plugin / "agents" / "cad-mech-reviewer.md").write_text("---\nname: cad-mech-reviewer\n---\n")
        patcher = mock.patch.object(runner, "PLUGIN_ROOT", plugin)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.case = runner.load_cases(["t1-lower-link-cq"])[0]
        self.cell = runner.Cell("omp", "amazon-bedrock/global.anthropic.claude-haiku-5-5")
        self.cfg = {"case_timeout_s": 20, "max_turns": 4, "retry": {"attempts": 3, "base_s": 0, "max_s": 0}}
        self.host = StaticHost(self.tmp)

    def adapter(self, mode: str, probe: str = "clean", **env: str):
        return adapters.build("omp", {"bin": str(FAKE_AGENT), "env": {"FAKE_AGENT_MODE": mode, "FAKE_AGENT_PROBE": probe, **env}})

    def slot(self, mode: str, *, trace=False, cfg=None, probe="clean", out="out", **env: str):
        sink = runner.Sink(self.tmp / out / self.cell.slug, self.host.redact)
        outcome = runner.run_slot(self.case, 1, self.cell, self.adapter(mode, probe, **env), cfg or self.cfg, sink,
                                  trace=trace, keep=False, rng=random.Random(0), host_source=self.host)
        return outcome, sink

    def rows(self, sink, name):
        path = sink.out / name
        return [json.loads(line) for line in path.read_text().splitlines()] if path.is_file() else []

    def test_induced_adapter_error_lands_in_errors(self):
        outcome, sink = self.slot("fail")
        self.assertEqual(outcome, "adapter_error")
        self.assertEqual(self.rows(sink, "results.jsonl"), [])
        [error] = self.rows(sink, "errors.jsonl")
        self.assertEqual(error["failure_class"], "adapter_error")
        self.assertEqual(error["retries"], 0)
        self.assertIn("invalid configuration", error["detail"])

    def test_transient_error_retried_with_backoff_then_recorded(self):
        outcome, sink = self.slot("throttle")
        [error] = self.rows(sink, "errors.jsonl")
        self.assertEqual(outcome, "adapter_error")
        self.assertTrue(error["transient"])
        self.assertEqual(error["retries"], 2)

    def test_timeout_is_an_error_not_a_zero(self):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always", ResourceWarning)
            outcome, sink = self.slot("sleep", cfg={**self.cfg, "case_timeout_s": 2})
            gc.collect()
        self.assertEqual(outcome, "timeout")
        self.assertEqual(self.rows(sink, "results.jsonl"), [])
        # The killed harness's pipes are closed, not left to the garbage collector.
        self.assertEqual([str(w.message) for w in caught if issubclass(w.category, ResourceWarning)], [])

    def test_served_model_mismatch_is_an_error(self):
        outcome, sink = self.slot("mismatch")
        self.assertEqual(outcome, "model_mismatch")
        self.assertIn("claude-sonnet-4-6", self.rows(sink, "errors.jsonl")[0]["detail"])

    @geometry
    def test_scored_row_follows_the_runner_contract(self):
        outcome, sink = self.slot(f"ask-then:{oracle_answer(self.case['id'])}", trace=True)
        self.assertEqual(outcome, "ok")
        [row] = self.rows(sink, "results.jsonl")
        for key in ("prompt_id", "rep", "prompt", "tags", "grade", "explanation", "status", "model", "usage", "latency_s",
                    "isolation", "leaks", "inventory", "isolation_mechanism"):
            self.assertIn(key, row)
        self.assertEqual(row["tags"][0], "T1-cadquery")
        self.assertEqual(row["model"], "global.anthropic.claude-haiku-5-5")
        self.assertEqual(row["usage"]["input"], 440)  # two turns x (100 + 120)
        self.assertEqual(row["usage"]["cost_usd"], 0.002)
        self.assertEqual(row["turns"], 2)  # the scripted gate answer was sent
        self.assertEqual(row["grade"]["pass"], 1.0, row["explanation"])
        self.assertEqual(set(METRICS) | {"score", "pass"}, set(row["grade"]))
        self.assertEqual((row["isolation"], row["leaks"]), ("clean", []))
        trace = json.loads((sink.out / "traces" / "t1-lower-link-cq_rep1.json").read_text())
        self.assertTrue({"user", "assistant", "tool_call", "tool_result"} <= {e["role"] for e in trace})
        self.assertTrue((sink.out / "artifacts" / "t1-lower-link-cq_rep1" / "parts" / "LAL-0001" / "model.py").is_file())

    def test_leaky_harness_tags_the_row_contaminated(self):
        outcome, sink = self.slot("quiet", probe="leaky")
        self.assertEqual(outcome, "ok")
        [row] = self.rows(sink, "results.jsonl")
        self.assertEqual(row["isolation"], "contaminated")
        self.assertEqual(row["leaks"], ["context:rule:user-rule", "skills:user-skill"])

    def test_a_harness_version_change_is_a_leak_until_re_observed(self):
        _, declared = self.slot("quiet", out="declared")
        [row] = self.rows(declared, "results.jsonl")
        self.assertEqual((row["isolation"], row["inventory"]["version"]), ("clean", "18.12.3"))
        outcome, sink = self.slot("quiet", out="updated", FAKE_AGENT_VERSION="18.13.0")
        [row] = self.rows(sink, "results.jsonl")
        self.assertEqual(row["leaks"], ["baseline: declared for 18.12.3, the harness reports 18.13.0"])

    def test_a_refused_preflight_starts_no_trial(self):
        with mock.patch.object(adapters.OmpAdapter, "preflight", return_value="login expires too soon"):
            outcome, sink = self.slot("quiet")
            matrix = runner.Matrix({"harness": {"omp": {"bin": str(FAKE_AGENT)}}, **self.cfg}, [self.cell])
            with mock.patch("sys.stderr", new=io.StringIO()) as err:
                counts = runner.run_matrix(matrix, [self.cell], [self.case], 1, self.tmp / "refused", trace_ids=set(),
                                           concurrency=1, keep=False, host_source=self.host)
        self.assertEqual(outcome, "auth_error")  # a single trial refuses too
        self.assertEqual(self.rows(sink, "errors.jsonl")[0]["detail"], "login expires too soon")
        self.assertEqual(counts, {"not_started": 1})  # the cell never starts
        self.assertIn("login expires too soon", err.getvalue())
        self.assertFalse((self.tmp / "refused" / self.cell.slug / "errors.jsonl").exists())

    def test_no_trace_for_non_train_ids(self):
        outcome, sink = self.slot("quiet", trace=False)
        self.assertEqual(outcome, "ok")
        self.assertFalse((sink.out / "traces").exists())
        self.assertFalse((sink.out / "raw").exists())
        [row] = self.rows(sink, "results.jsonl")
        self.assertEqual(row["grade"]["score"], 0.0)
        self.assertEqual(row["isolation"], "clean")

    def test_comparisons_refuse_contaminated_cells(self):
        _, clean = self.slot("quiet", out="cmp")
        clean_dir = clean.out
        dirty_dir = self.tmp / "cmp" / "omp--leaky"
        dirty_dir.mkdir()
        rows = self.rows(clean, "results.jsonl")
        (dirty_dir / "results.jsonl").write_text(json.dumps({**rows[0], "isolation": "contaminated", "leaks": ["skills:user-skill"]}) + "\n")
        summary = runner.summarize(self.tmp / "cmp", allow_contaminated=False)
        self.assertEqual([c["cell"] for c in summary["cells"]], [self.cell.slug])
        self.assertEqual([c["cell"] for c in summary["excluded_contaminated"]], ["omp--leaky"])
        self.assertEqual(len(runner.summarize(self.tmp / "cmp", allow_contaminated=True)["cells"]), 2)
        with self.assertRaises(runner.Contaminated):
            runner.require_comparable([clean_dir, dirty_dir], allow_contaminated=False)
        runner.require_comparable([clean_dir, dirty_dir], allow_contaminated=True)

    def test_resume_is_idempotent_and_retries_only_errors(self):
        matrix = runner.Matrix({"harness": {"omp": {"bin": str(FAKE_AGENT), "env": {"FAKE_AGENT_MODE": "quiet"}}}, **self.cfg}, [self.cell])
        out = self.tmp / "resume"
        run = functools.partial(runner.run_matrix, matrix, [self.cell], [self.case], 2, out, trace_ids=set(),
                                concurrency=2, keep=False, seed=1, host_source=self.host)
        self.assertEqual(run(), {"ok": 2})
        self.assertEqual(run(), {})
        results = out / self.cell.slug / "results.jsonl"
        self.assertEqual(len(results.read_text().splitlines()), 2)
        # A slot that only errored is not "done": it runs again on resume.
        kept = [line for line in results.read_text().splitlines() if json.loads(line)["rep"] == 1]
        results.write_text("\n".join(kept) + "\n")
        (out / self.cell.slug / "errors.jsonl").write_text(json.dumps({"prompt_id": self.case["id"], "rep": 2, "failure_class": "timeout"}) + "\n")
        pending = runner.plan_slots([self.cell], [self.case], 2, out)
        self.assertEqual([(cell, case["id"], rep) for cell, case, rep in pending], [(self.cell, self.case["id"], 2)])

    def test_truth_never_reaches_the_sandbox(self):
        paths = runner.stage_trial(self.case, self.adapter("quiet"), self.host.get(), require_plugin=True)
        self.addCleanup(shutil.rmtree, paths.root, True)
        names = {p.name for p in paths.root.rglob("*")}
        self.assertNotIn("truth.json", names)
        self.assertNotIn("oracle", names)
        self.assertTrue((paths.work / "hw" / "product.yaml").is_file())
        self.assertTrue((paths.work / ".git").is_dir())

    def test_child_environment_is_built_not_inherited(self):
        with mock.patch.dict(os.environ, {"OMP_PROFILE": "user", "PI_SMOL_MODEL": "x", "AWS_PROFILE": "user-profile", "TMPDIR": "/shared/tmp"}):
            base = runner.HostSource({"aws_profile": None})._base_env()
        self.assertNotIn("OMP_PROFILE", base)
        self.assertNotIn("PI_SMOL_MODEL", base)
        self.assertNotIn("AWS_PROFILE", base)
        self.assertNotIn("TMPDIR", base)
        paths = runner.stage_trial(None, self.adapter("quiet"), self.host.get(), require_plugin=True)
        self.addCleanup(shutil.rmtree, paths.root, True)
        env = self.adapter("quiet").env(paths, self.host.get())
        self.assertEqual(env["HOME"], str(paths.home))
        self.assertEqual(env["PI_CODING_AGENT_DIR"], str(paths.home / ".omp" / "agent"))

    def test_every_harness_gets_a_temp_dir_inside_the_trial(self):
        for harness in adapters.HARNESSES:
            with self.subTest(harness=harness):
                adapter = adapters.build(harness, {"bin": "true"})
                paths = runner.stage_trial(None, adapter, self.host.get(), require_plugin=True)
                self.addCleanup(shutil.rmtree, paths.root, True)
                env = adapter.env(paths, self.host.get())
                self.assertTrue(paths.tmp.is_dir() and paths.tmp.parent == paths.root)
                self.assertEqual({env[var] for var in ("TMPDIR", "TMP", "TEMP")}, {str(paths.tmp)})
                if harness == "claude":  # Claude's own temp root defaults to /tmp on macOS, not $TMPDIR
                    self.assertEqual(env["CLAUDE_CODE_TMPDIR"], str(paths.tmp))

    def test_kiro_trial_gets_a_private_login_copy_and_audits_refresh(self):
        user_db = make_kiro_login(self.tmp)
        before = (user_db.read_bytes(), user_db.stat().st_mtime_ns)
        adapter = adapters.build("kiro", {"bin": "true"})
        paths = runner.stage_trial(None, adapter, self.host.get(), require_plugin=True)
        trial_store = paths.home.joinpath("Library", "Application Support", "kiro-cli")
        self.assertFalse(trial_store.is_symlink())
        trial = sqlite3.connect(trial_store / "data.sqlite3")
        self.assertEqual(trial.execute("SELECT key FROM auth_kv").fetchall(), [("kirocli:odic:token",)])
        trial.execute("UPDATE auth_kv SET value = '{\"access_token\": \"rotated\"}' WHERE key = 'kirocli:odic:token'")
        trial.commit()
        trial.close()
        self.assertEqual((user_db.read_bytes(), user_db.stat().st_mtime_ns), before)
        self.assertTrue(runner.end_trial(paths, adapter, self.host.get(), keep=False))
        self.assertFalse(paths.root.exists())

    def test_no_process_outlives_its_trial(self):
        viewer = runner.PLUGIN_ROOT / runner.VIEWER  # a stand-in that logs how the runner stops it
        viewer.parent.mkdir(parents=True)
        viewer.write_text("import os, sys\nwith open(os.environ['FAKE_VIEWER_LOG'], 'a') as fh:\n"
                          "    fh.write(' '.join([*sys.argv[1:], os.environ['CAD_VIEWER_SESSION']]) + '\\n')\n")
        pids, log = self.tmp / "pids", self.tmp / "viewer.log"
        outcome, _ = self.slot("linger", FAKE_AGENT_PIDS=str(pids), FAKE_VIEWER_LOG=str(log))
        self.assertEqual(outcome, "ok")
        in_group, detached = map(int, pids.read_text().split())
        for pid in (in_group, detached):
            self.addCleanup(kill_if_running, pid)
        self.assertTrue(gone(in_group), "a child left in the turn's process group still runs")
        self.assertTrue(gone(detached), "a detached child naming the trial still runs")
        command, session = log.read_text().split()
        self.assertEqual(command, "stop")
        self.assertTrue(session.endswith("/home/.local/state/cad-viewer/harness-keyed/session.json")
                        and runner.TRIAL_PREFIX in session, session)

    def test_every_record_is_scrubbed(self):
        secret, token = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "IQoJb3JpZ2luX2VjEXAMPLETOKEN"
        source = exported_source({"Version": 1, "AccessKeyId": "ASIAEXAMPLEKEYID", "SecretAccessKey": secret,
                                  "SessionToken": token, "Expiration": "2099-01-01T00:00:00+00:00"})
        echo = Path.home() / "Documents" / "notes"
        for mode in ("leak", "leak-fail"):
            sink = runner.Sink(self.tmp / mode / self.cell.slug, source.redact)
            runner.run_slot(self.case, 1, self.cell, self.adapter(mode, FAKE_AGENT_ECHO=str(echo)), self.cfg, sink,
                            trace=True, keep=False, rng=random.Random(0), host_source=source)
        written = {p.relative_to(self.tmp).as_posix(): p.read_text() for mode in ("leak", "leak-fail")
                   for p in (self.tmp / mode).rglob("*.json*") if "artifacts" not in p.parts}
        self.assertEqual(sorted(written), [
            f"leak-fail/{self.cell.slug}/errors.jsonl", f"leak/{self.cell.slug}/raw/t1-lower-link-cq_rep1_t1.jsonl",
            f"leak/{self.cell.slug}/results.jsonl", f"leak/{self.cell.slug}/traces/t1-lower-link-cq_rep1.json",
        ])
        for name, text in written.items():
            for value in (secret, token, str(Path.home()), runner.TRIAL_PREFIX):
                self.assertNotIn(value, text, name)
        expected = "key=<redacted> token=<redacted> cwd=<trial>/work echo=~/Documents/notes"
        self.assertIn(expected, written[f"leak/{self.cell.slug}/traces/t1-lower-link-cq_rep1.json"])
        self.assertIn(expected, written[f"leak/{self.cell.slug}/raw/t1-lower-link-cq_rep1_t1.jsonl"])
        self.assertIn(expected, written[f"leak-fail/{self.cell.slug}/errors.jsonl"])
        self.assertEqual(source.redact([f"{Path.home()}x", "us-east-1"]), [f"{Path.home()}x", "us-east-1"])  # whole paths only

    def test_credentials_without_expiration_are_refused(self):
        with self.assertRaises(runner.TrialError) as caught:
            exported_source({"Version": 1, "AccessKeyId": "AKIAEXAMPLEKEYID", "SecretAccessKey": "long-lived"})
        self.assertEqual(caught.exception.failure_class, "auth_error")
        self.assertIn("no Expiration", caught.exception.detail)

    def test_seed_commit_ignores_the_users_git_setup(self):
        hook = self.tmp / "hooks" / "pre-commit"
        hook.parent.mkdir()
        hook.write_text("#!/bin/sh\nexit 1\n")
        hook.chmod(0o755)
        config = self.tmp / "gitconfig"
        config.write_text(f"[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n[core]\n\thooksPath = {hook.parent}\n")
        with mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": str(config), "GIT_DIR": str(self.tmp / "elsewhere.git")}):
            paths = runner.stage_trial(self.case, self.adapter("quiet"), self.host.get(), require_plugin=True)
        self.addCleanup(shutil.rmtree, paths.root, True)
        log = subprocess.run(["git", "log", "--format=%s"], cwd=paths.work, capture_output=True, text=True, check=True,
                             env={"PATH": os.environ["PATH"], "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"})
        self.assertEqual(log.stdout.strip(), "seed")
        self.assertFalse((self.tmp / "elsewhere.git").exists())

    def test_a_trial_that_fails_to_stage_leaves_no_directory(self):
        made, real_mkdtemp = [], tempfile.mkdtemp

        def mkdtemp(*args, **kwargs):
            made.append(Path(real_mkdtemp(*args, **kwargs)))
            return str(made[-1])

        with mock.patch.object(tempfile, "mkdtemp", side_effect=mkdtemp), \
                mock.patch.object(adapters.OmpAdapter, "prepare", side_effect=RuntimeError("prepare failed")), \
                self.assertRaises(RuntimeError):
            runner.stage_trial(None, self.adapter("quiet"), self.host.get(), require_plugin=True)
        self.assertEqual([p.exists() for p in made], [False])

    def test_unexportable_aws_profile_is_an_auth_error(self):
        with self.assertRaises(runner.TrialError) as caught:
            runner.HostSource({"aws_profile": "cad-eval-no-such-profile"}).get()
        self.assertEqual(caught.exception.failure_class, "auth_error")


class PairwiseJudge(unittest.TestCase):
    def call_returning(self, winner: str):
        seen = []

        def call(prompt: str) -> Turn:
            seen.append(prompt)
            return Turn(text=f'thinking... {{"winner": "{winner}", "reason": "r"}}', model="judge-m", usage={"input": 1})

        return call, seen

    def test_order_is_randomised_and_mapped_back(self):
        orders = set()
        for seed in range(20):
            call, seen = self.call_returning("1")
            verdict = judge.pairwise("task", "AAA", "BBB", call=call, rng=random.Random(seed))
            orders.add(verdict.order)
            shown_first = "AAA" if seen[0].index("AAA") < seen[0].index("BBB") else "BBB"
            self.assertEqual(verdict.winner, "a" if shown_first == "AAA" else "b")
            self.assertEqual(verdict.judge_model, "judge-m")
        self.assertEqual(orders, {"ab", "ba"})

    def test_tie_and_empty_candidates(self):
        call, seen = self.call_returning("tie")
        self.assertEqual(judge.pairwise("t", "x", "y", call=call, rng=random.Random(0)).score_a, 0.5)
        self.assertEqual(judge.pairwise("t", "", "y", call=call, rng=random.Random(0)).winner, "b")
        self.assertEqual(judge.pairwise("t", " ", "", call=call, rng=random.Random(0)).winner, "tie")
        self.assertEqual(len(seen), 1)  # empties never reach the judge

    def test_unparseable_verdict_raises(self):
        with self.assertRaises(judge.JudgeError):
            judge.pairwise("t", "x", "y", call=lambda p: Turn(text="I don't know"), rng=random.Random(0))


class Artifacts(unittest.TestCase):
    """Collected deliverables, and what the judge reads of them, stay inside the trial."""

    def test_symlinks_are_neither_copied_nor_followed(self):
        base = Path(tempfile.mkdtemp(prefix="cad-eval-art-"))
        self.addCleanup(shutil.rmtree, base, True)
        outside = base / "outside"  # stands for ~/.aws
        outside.mkdir()
        (outside / "credentials.txt").write_text("SECRET")
        hw = base / "work" / "hw"
        (hw / "parts").mkdir(parents=True)
        (hw / "part.yaml").write_text("pn: LAL-0001\n")
        (hw / "aws").symlink_to(outside)
        (hw / "parts" / "notes.txt").symlink_to(outside / "credentials.txt")
        artifacts = base / "artifacts"
        runner.collect_artifacts(hw, artifacts)
        self.assertEqual(sorted(p.relative_to(artifacts).as_posix() for p in artifacts.rglob("*")), ["part.yaml", "parts"])
        rendered = judge.render_candidate(hw)  # a directory holding links is read without following them
        self.assertIn("pn: LAL-0001", rendered)
        self.assertNotIn("SECRET", rendered)
        linked = base / "work" / "linked"
        linked.symlink_to(outside)
        runner.collect_artifacts(linked, base / "linked-artifacts")
        self.assertFalse((base / "linked-artifacts").exists())
        self.assertEqual(judge.render_candidate(linked), "")


class CaseSchema(unittest.TestCase):
    def test_cases_validate_and_truth_is_outside_cases(self):
        code = (
            "import json, sys, pathlib, jsonschema\n"
            "root = pathlib.Path(sys.argv[1])\n"
            "schema = json.loads((root / 'cases/case.schema.json').read_text())\n"
            "for p in sorted((root / 'cases').glob('*.case.json')):\n"
            "    jsonschema.validate(json.loads(p.read_text()), schema)\n"
        )
        subprocess.run(["uv", "run", "--quiet", "--no-project", "--with", "jsonschema>=4.18", "python", "-c", code, str(EVALS)],
                       check=True, capture_output=True, timeout=300)
        for case in runner.load_cases():
            self.assertTrue((case["_truth"] / "truth.json").is_file())
            self.assertFalse(case["_truth"].is_relative_to(runner.CASES))

    @unittest.skipUnless(runner.VALIDATOR.is_file(), "cad-record validator not present")
    def test_seed_record_passes_the_real_validator(self):
        done = subprocess.run(["uv", "run", "--quiet", "--script", str(runner.VALIDATOR), str(EVALS / "cases/seeds/desk-lamp/hw")],
                              capture_output=True, text=True, timeout=300)
        self.assertEqual(done.returncode, 0, done.stdout[-1500:])




class HostEffects(unittest.TestCase):
    """The smoke's verdict on what a trial left outside its own directory."""

    def test_writes_outside_the_trial_are_attributed(self):
        base = Path(tempfile.mkdtemp(prefix="cad-eval-host-"))
        self.addCleanup(shutil.rmtree, base, True)
        shared, store = base / "shared", base / "store"
        (shared / "claude-503").mkdir(parents=True)
        store.mkdir()
        root = shared / "cad-eval-a_b"  # the trial root sits in the shared temp dir, as mkdtemp puts it
        (root / "tmp").mkdir(parents=True)
        con = sqlite3.connect(store / "data.sqlite3")
        con.executescript("CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT); INSERT INTO t VALUES ('a', '1');")
        con.close()
        shared_before, stores = run.tree(shared), {store: run.store_state(store)}
        quiet = run.host_effects(root, {"tmpdir": [], "stores": {}}, [shared], shared_before, stores)
        self.assertTrue(quiet["unchanged"])
        # Claude slugs the trial's work dir into a per-directory folder; another process adds its own entry.
        slug = shared / "claude-503" / "-private-var-shared-cad-eval-a-b-work"
        slug.mkdir()
        (shared / "TemporaryDirectory.x").mkdir()
        (root / "tmp" / "scratch").mkdir()  # inside the trial: never counted
        report = run.host_effects(root, {"tmpdir": ["scratch"], "stores": {}}, [shared], shared_before, stores)
        self.assertEqual(report["shared_temp"]["added_by_trial"], [str(slug)])
        self.assertEqual(report["shared_temp"]["added_by_other_processes"], 1)  # counted, never named
        self.assertFalse(report["unchanged"])
        slug.rmdir()
        con = sqlite3.connect(store / "data.sqlite3")
        con.execute("UPDATE t SET v = '2'")
        con.commit()
        con.close()
        changed = run.host_effects(root, {"tmpdir": [], "stores": {}}, [shared], shared_before, stores)
        self.assertEqual(changed["user_stores"][str(store)]["sqlite"]["data.sqlite3"]["tables_changed"], ["t"])
        self.assertFalse(changed["unchanged"])

    def test_a_write_through_a_linked_kiro_executable_is_seen(self):
        base = Path(tempfile.mkdtemp(prefix="cad-eval-kirobin-")).resolve()
        self.addCleanup(shutil.rmtree, base, True)
        home, install = base / "home", base / "install" / "kiro-cli-chat"
        (home / ".local" / "bin").mkdir(parents=True)
        install.parent.mkdir()
        install.write_bytes(b"v1")
        (home / ".local" / "bin" / "kiro-cli-chat").symlink_to(install)
        host = StaticHost(home).get()
        adapter = adapters.build("kiro", {"bin": "true"})
        stores = {store: run.store_state(store) for store in adapter.user_stores(host)}
        root = base / "trial"
        paths = adapters.TrialPaths(root, root / "work", root / "cad", root / "state", root / "home")
        for directory in (paths.plugin / "skills", paths.work, paths.home):
            directory.mkdir(parents=True)
        adapter.prepare(paths, host)
        (paths.home / ".local" / "bin" / "kiro-cli-chat").write_bytes(b"v2")  # an updater writing through the trial's link
        report = run.host_effects(root, {"tmpdir": [], "stores": {}}, [], {}, stores)
        entry = report["user_stores"][str(install)]
        self.assertEqual(entry["changed"], [str(install)])
        self.assertEqual(entry["fingerprint"]["sha256"], hashlib.sha256(b"v2").hexdigest())
        self.assertFalse(report["unchanged"])


class ClaudeLauncher(unittest.TestCase):
    """The toolbox launcher runs as the real binary behind it, or no Claude trial starts."""

    def test_a_launcher_without_its_binary_is_refused(self):
        root = Path(tempfile.mkdtemp(prefix="cad-eval-toolbox-"))
        self.addCleanup(shutil.rmtree, root, True)
        launcher = root / "tools" / "toolbox" / "1.0" / "toolbox-exec"
        launcher.parent.mkdir(parents=True)
        launcher.write_text("#!/bin/sh\n")
        launcher.chmod(0o755)
        (root / "bin").mkdir()
        (root / "bin" / "claude").symlink_to(launcher)
        host = StaticHost(root).get()
        with mock.patch.dict(os.environ, {"PATH": f"{root / 'bin'}{os.pathsep}{os.environ['PATH']}"}):
            refused = adapters.build("claude", {}).preflight(host, 60)
            tool = root / "tools" / "claude-code"
            real = tool / "2.1.310" / "claude"
            real.parent.mkdir(parents=True)
            real.write_text("#!/bin/sh\n")
            real.chmod(0o755)
            (tool / "info.json").write_text(json.dumps({"CurrentVersion": {"Version": "2.1.310"}}))
            resolved = adapters.build("claude", {})
        self.assertIn("toolbox launcher", refused)
        self.assertEqual(Path(resolved.bin).resolve(), real.resolve())
        self.assertIsNone(resolved.preflight(host, 60))


class RecordedStreams(unittest.TestCase):
    """Adapter parsers and isolation verdicts on the (sanitised) streams of the live
    smoke calls. `<trial>` in a fixture stands for the trial root."""

    def trial(self) -> adapters.TrialPaths:
        root = Path(tempfile.mkdtemp(prefix="cad-eval-fx-"))
        self.addCleanup(shutil.rmtree, root, True)
        source = EVALS.parent
        if not (source / "skills").is_dir():
            self.skipTest("cad plugin skills not present in this checkout")
        for dest in (root / "cad", root / "work" / "cad"):
            shutil.copytree(source, dest, ignore=shutil.ignore_patterns("evals", "__pycache__"))
        return adapters.TrialPaths(root, root / "work", root / "cad", root / "state", root / "home")

    @staticmethod
    def lines(name: str, paths: adapters.TrialPaths | None = None) -> list[str]:
        text = (FIXTURES / name).read_text()
        return (text.replace("<trial>", str(paths.root)) if paths else text).splitlines()

    def check(self, harness: str, requested: str, paths=None, lines=None) -> Turn:
        turn = adapters.build(harness, {}).parse(lines or self.lines(f"{harness}.raw.jsonl", paths))
        self.assertTrue(adapters.served_matches(requested, turn.model), turn.model)
        self.assertTrue(turn.text.strip().endswith("DONE"))
        self.assertIsNone(turn.error)
        self.assertTrue(turn.tools)
        self.assertTrue({"tool_call", "tool_result", "assistant"} <= {e["role"] for e in turn.transcript})
        return turn

    def isolation(self, harness: str, paths, probe=(), stream=None) -> dict:
        adapter = adapters.build(harness, {})
        recorded = RECORDED_VERSIONS.get(harness)
        if recorded:
            # A fixture can predate the baseline's latest re-observation: audit it against
            # the current items at the version it was recorded under. Version mismatch has
            # its own tests.
            adapter.baseline = Baseline(recorded, adapter.baseline.items)
        return runner.isolation_of(adapter, paths, list(probe), stream or self.lines(f"{harness}.raw.jsonl", paths), recorded)

    def assert_tokens(self, turn: Turn):
        self.assertGreater(turn.usage["input"] + turn.usage["cacheRead"] + turn.usage["cacheWrite"], 0)
        self.assertGreater(turn.usage["output"], 0)
        self.assertGreater(turn.usage["cost_usd"], 0)

    def test_omp(self):
        paths = self.trial()
        self.assert_tokens(self.check("omp", "amazon-bedrock/global.anthropic.claude-haiku-5-5", paths))
        probe = ["\n".join(self.lines("omp.probe.jsonl", paths))]
        result = self.isolation("omp", paths, probe)
        self.assertEqual((result["isolation"], result["leaks"]), ("clean", []))
        self.assertIn("cad-flow", result["inventory"]["skills"])
        # The same probe with one user skill added is caught.
        leaky = [probe[0].replace("- cad-flow:", "- user-skill: x\\n- cad-flow:", 1)]
        self.assertIn("skills:user-skill", self.isolation("omp", paths, leaky)["leaks"])

    def test_claude(self):
        paths = self.trial()
        self.assert_tokens(self.check("claude", "global.anthropic.claude-haiku-5-5", paths))
        result = self.isolation("claude", paths)
        self.assertEqual((result["isolation"], result["leaks"]), ("clean", []))
        self.assertEqual(result["inventory"]["plugins"], ["cad"])
        self.assertEqual(result["inventory"]["version"], "2.1.310")
        self.assertEqual(result["inventory"]["baseline"]["declared_for"], "2.1.310")
        self.assertIn("compact", result["inventory"]["baseline"]["loaded"]["commands"])
        self.assertEqual(set(result["inventory"]["baseline"]["loaded"]), {"commands"})  # no bundled skill or subagent

    def test_claude_bundled_components_and_other_versions_leak(self):
        paths = self.trial()
        stream = self.lines("claude.raw.jsonl", paths)
        bundled = [stream[0].replace('"skills": [', '"skills": ["simplify", ', 1).replace('"agents": [', '"agents": ["Explore", ', 1), *stream[1:]]
        self.assertTrue({"skills:simplify", "agents:Explore"} <= set(self.isolation("claude", paths, stream=bundled)["leaks"]))
        newer = [line.replace('"claude_code_version": "2.1.310"', '"claude_code_version": "2.1.311"') for line in stream]
        self.assertIn("baseline: declared for 2.1.310, the harness reports 2.1.311", self.isolation("claude", paths, stream=newer)["leaks"])

    def test_claude_bare_mode_is_flagged(self):
        paths = self.trial()
        result = self.isolation("claude", paths, stream=self.lines("claude-bare.init.jsonl", paths))
        self.assertIn("missing:tool:Skill", result["leaks"])

    def test_claude_pins_the_model_through_trial_settings(self):
        self.assertEqual(canonical_model("global.anthropic.claude-opus-5-5"), "claude-opus-5-5")
        demo = adapters.TrialPaths(Path("/t"), Path("/t/work"), Path("/t/cad"), Path("/t/state"), Path("/t/home"))
        argv = adapters.build("claude", {}).command(model="global.anthropic.claude-opus-5-5", prompt="p", paths=demo, resume=False)
        self.assertEqual(argv[argv.index("--model") + 1], "claude-opus-5-5")
        settings = json.loads(argv[argv.index("--settings") + 1])
        self.assertEqual(settings["modelOverrides"], {"claude-opus-5-5": "global.anthropic.claude-opus-5-5"})
        self.assertNotIn("--bare", argv)

    def test_kiro(self):
        paths = self.trial()
        turn = self.check("kiro", "claude-haiku-5.5", paths)
        self.assertGreater(turn.usage["credits"], 0)  # Kiro reports credits, not tokens
        # With --trust-all-tools, List Directory on the workspace root runs headless.
        listing = next(e for e in turn.transcript if e["role"] == "tool_result" and e["name"] == "List Directory")
        self.assertIn("[DIR] cad", listing["content"])
        result = self.isolation("kiro", paths)
        self.assertEqual((result["isolation"], result["leaks"]), ("clean", []))
        self.assertIn("cad-eval", result["inventory"]["agents"])

    def test_kiro_default_agent_is_flagged(self):
        paths = self.trial()
        stream = [line.replace('"currentValue": "cad-eval"', '"currentValue": "kiro_default"') for line in self.lines("kiro.raw.jsonl", paths)]
        self.assertTrue(any(leak.startswith("missing:agent:cad-eval") for leak in self.isolation("kiro", paths, stream=stream)["leaks"]))

    def test_opencode(self):
        paths = self.trial()
        lines = self.lines("opencode.raw.jsonl", paths)
        adapter = adapters.build("opencode", {"bin": "opencode"})
        messages = (FIXTURES / "opencode.messages.json").read_text()
        done = subprocess.CompletedProcess([], 0, stdout=messages, stderr="")
        with mock.patch("adapters.opencode.subprocess.run", return_value=done):
            turn = adapter.complete(adapter.parse(lines), lines, paths, {})
        self.assertTrue(adapters.served_matches("amazon-bedrock/global.anthropic.claude-haiku-5-5", turn.model), turn.model)
        self.assert_tokens(turn)
        for skill in (paths.plugin / "skills").glob("*/SKILL.md"):
            dest = paths.work / ".opencode" / "skills" / skill.parent.name
            dest.mkdir(parents=True, exist_ok=True)
            shutil.copy(skill, dest / "SKILL.md")
        probe = json.loads((FIXTURES / "opencode.probe.json").read_text().replace("<trial>", str(paths.root)))
        result = self.isolation("opencode", paths, probe, lines)
        self.assertEqual((result["isolation"], result["leaks"]), ("clean", []))
        (paths.home / ".claude" / "skills" / "user-skill").mkdir(parents=True)
        (paths.home / ".claude" / "skills" / "user-skill" / "SKILL.md").write_text("x")
        self.assertIn("skills:user-skill", self.isolation("opencode", paths, probe, lines)["leaks"])


if __name__ == "__main__":
    unittest.main()
