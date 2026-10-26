"""Pre-flight checks for the cad eval harness (ratchet Phase 2 step 5).

Run: python3 -m unittest discover -s cad/evals/tests -v
Needs `uv` on PATH; the first run resolves the CadQuery 2.8, build123d 0.13 and
OCCT read-back environments into the uv cache. No model is called.
"""

from __future__ import annotations

import json
import random
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

EVALS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EVALS))

import adapters  # noqa: E402
import runner  # noqa: E402
from adapters.base import Turn  # noqa: E402
from graders import judge  # noqa: E402
from graders.score import METRICS, ap242_header, grade_trial  # noqa: E402

FAKE_AGENT = Path(__file__).with_name("fake_agent.py")
FIXTURES = Path(__file__).with_name("fixtures")


def build_oracle(case: dict, dest: Path) -> Path:
    """Seed record + the hidden reference answer, with its model run to produce the STEP."""
    shutil.copytree(case["_seed"], dest, dirs_exist_ok=True)
    shutil.copytree(case["_truth"] / "oracle", dest, dirs_exist_ok=True)
    model = dest / "hw" / "parts" / case["deliverables"]["pn"] / "model.py"
    subprocess.run(["uv", "run", "--quiet", "--script", str(model)], check=True, capture_output=True, timeout=900)
    return dest


def grade(case: dict, work: Path):
    return grade_trial(case, work, runner.load_truth(case), runner.VALIDATOR if runner.VALIDATOR.is_file() else None)


class OracleAndNull(unittest.TestCase):
    """The reference answer scores ~100%, an empty answer ~0%, and grading is stable."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="cad-eval-test-"))
        cls.cases = runner.load_cases()
        cls.oracles = {c["id"]: build_oracle(c, cls.tmp / c["id"]) for c in cls.cases}

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_three_seed_cases_cover_both_kernels(self):
        self.assertEqual(len(self.cases), 3)
        self.assertEqual({c["kernel"] for c in self.cases}, {"cadquery", "build123d"})

    def test_oracle_grades_full(self):
        for case in self.cases:
            with self.subTest(case=case["id"]):
                graded = grade(case, self.oracles[case["id"]])
                self.assertEqual(graded.grade["score"], 1.0, graded.explanation)
                self.assertEqual(graded.grade["pass"], 1.0)

    def test_empty_answer_grades_zero(self):
        for case in self.cases:
            with self.subTest(case=case["id"]):
                work = self.tmp / f"empty-{case['id']}"
                shutil.copytree(case["_seed"], work)
                graded = grade(case, work)
                self.assertEqual(graded.grade["score"], 0.0, graded.explanation)
                self.assertEqual(graded.grade["pass"], 0.0)

    def test_grading_twice_is_stable(self):
        for case in self.cases:
            with self.subTest(case=case["id"]):
                first, second = grade(case, self.oracles[case["id"]]), grade(case, self.oracles[case["id"]])
                self.assertEqual(first, second)

    def test_wrong_hole_diameter_fails_only_geometry(self):
        case = next(c for c in self.cases if c["id"] == "t1-lower-link-cq")
        work = self.tmp / "wrong-hole"
        shutil.copytree(case["_seed"], work)
        shutil.copytree(case["_truth"] / "oracle", work, dirs_exist_ok=True)
        model = work / "hw/parts/LAL-0001/model.py"
        model.write_text(model.read_text().replace("PIN_HOLE = 5.5", "PIN_HOLE = 5.0"))
        subprocess.run(["uv", "run", "--quiet", "--script", str(model)], check=True, capture_output=True, timeout=900)
        graded = grade(case, work)
        self.assertEqual(graded.grade["holes"], 0.0)
        self.assertEqual(graded.grade["volume"], 0.0)
        self.assertEqual(graded.grade["bbox"], 1.0)
        self.assertEqual(graded.grade["pass"], 0.0)
        self.assertIn("holes", graded.explanation)


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
    """Runner end to end against a stand-in OMP binary: errors, retries, gates, resume."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cad-eval-fake-"))
        plugin = self.tmp / "plugin"
        (plugin / ".omp-plugin").mkdir(parents=True)
        (plugin / ".omp-plugin" / "plugin.json").write_text('{"name": "cad"}')
        patcher = mock.patch.object(runner, "PLUGIN_ROOT", plugin)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.case = runner.load_cases(["t1-lower-link-cq"])[0]
        self.cell = runner.Cell("omp", "amazon-bedrock/global.anthropic.claude-haiku-5-5")
        self.cfg = {"case_timeout_s": 20, "max_turns": 4, "retry": {"attempts": 3, "base_s": 0, "max_s": 0}}

    def adapter(self, mode: str):
        return adapters.build("omp", {"bin": str(FAKE_AGENT), "env": {"FAKE_AGENT_MODE": mode}})

    def slot(self, mode: str, *, trace=False, cfg=None):
        sink = runner.Sink(self.tmp / "out" / self.cell.slug)
        outcome = runner.run_slot(self.case, 1, self.cell, self.adapter(mode), cfg or self.cfg, sink,
                                  trace=trace, keep=False, rng=random.Random(0))
        return outcome, sink

    def rows(self, sink, name):
        path = sink.out / name
        return [json.loads(line) for line in path.read_text().splitlines()] if path.is_file() else []

    def oracle_answer(self) -> Path:
        answer = self.tmp / "answer"
        build_oracle(self.case, answer)
        return answer

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
        cfg = {**self.cfg, "case_timeout_s": 2}
        outcome, sink = self.slot("sleep", cfg=cfg)
        self.assertEqual(outcome, "timeout")
        self.assertEqual(self.rows(sink, "results.jsonl"), [])

    def test_served_model_mismatch_is_an_error(self):
        outcome, sink = self.slot("mismatch")
        self.assertEqual(outcome, "model_mismatch")
        self.assertIn("claude-sonnet-4-6", self.rows(sink, "errors.jsonl")[0]["detail"])

    def test_scored_row_follows_the_runner_contract(self):
        outcome, sink = self.slot(f"ask-then:{self.oracle_answer()}", trace=True)
        self.assertEqual(outcome, "ok")
        [row] = self.rows(sink, "results.jsonl")
        for key in ("prompt_id", "rep", "prompt", "tags", "grade", "explanation", "status", "model", "usage", "latency_s"):
            self.assertIn(key, row)
        self.assertEqual(row["tags"][0], "T1-cadquery")
        self.assertEqual(row["model"], "global.anthropic.claude-haiku-5-5")
        self.assertEqual(row["usage"]["input"], 440)  # two turns x (100 + 120)
        self.assertEqual(row["usage"]["cost_usd"], 0.002)
        self.assertEqual(row["turns"], 2)  # the scripted gate answer was sent
        self.assertEqual(row["grade"]["pass"], 1.0, row["explanation"])
        self.assertEqual(set(METRICS) | {"score", "pass"}, set(row["grade"]))
        trace = json.loads((sink.out / "traces" / "t1-lower-link-cq_rep1.json").read_text())
        self.assertTrue({"user", "assistant", "tool_call", "tool_result"} <= {e["role"] for e in trace})
        self.assertTrue((sink.out / "artifacts" / "t1-lower-link-cq_rep1" / "parts" / "LAL-0001" / "model.py").is_file())

    def test_no_trace_for_non_train_ids(self):
        outcome, sink = self.slot("quiet", trace=False)
        self.assertEqual(outcome, "ok")
        self.assertFalse((sink.out / "traces").exists())
        self.assertFalse((sink.out / "raw").exists())
        [row] = self.rows(sink, "results.jsonl")
        self.assertEqual(row["grade"]["score"], 0.0)

    def test_resume_is_idempotent_and_retries_only_errors(self):
        matrix = runner.Matrix({"harness": {"omp": {"bin": str(FAKE_AGENT), "env": {"FAKE_AGENT_MODE": "quiet"}}}, **self.cfg}, [self.cell])
        out = self.tmp / "resume"
        counts = runner.run_matrix(matrix, [self.cell], [self.case], 2, out, trace_ids=set(), concurrency=2, keep=False, seed=1)
        self.assertEqual(counts, {"ok": 2})
        again = runner.run_matrix(matrix, [self.cell], [self.case], 2, out, trace_ids=set(), concurrency=2, keep=False, seed=1)
        self.assertEqual(again, {})
        self.assertEqual(len((out / self.cell.slug / "results.jsonl").read_text().splitlines()), 2)
        # A slot that only errored is not "done": it runs again on resume.
        results = out / self.cell.slug / "results.jsonl"
        kept = [line for line in results.read_text().splitlines() if json.loads(line)["rep"] == 1]
        results.write_text("\n".join(kept) + "\n")
        (out / self.cell.slug / "errors.jsonl").write_text(json.dumps({"prompt_id": self.case["id"], "rep": 2, "failure_class": "timeout"}) + "\n")
        pending = runner.plan_slots([self.cell], [self.case], 2, out)
        self.assertEqual([(cell, case["id"], rep) for cell, case, rep in pending], [(self.cell, self.case["id"], 2)])

    def test_truth_never_reaches_the_sandbox(self):
        adapter = self.adapter("quiet")
        paths = runner.stage_trial(self.case, adapter, require_plugin=True)
        self.addCleanup(shutil.rmtree, paths.root, True)
        names = {p.name for p in paths.root.rglob("*")}
        self.assertNotIn("truth.json", names)
        self.assertNotIn("oracle", names)
        self.assertTrue((paths.work / "hw" / "product.yaml").is_file())
        self.assertTrue((paths.work / ".git").is_dir())


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


class RecordedStreams(unittest.TestCase):
    """Adapter parsers against the (sanitised) streams of the live smoke calls."""

    def parse(self, harness: str) -> Turn:
        return adapters.build(harness, {}).parse((FIXTURES / f"{harness}.raw.jsonl").read_text().splitlines())

    def check(self, harness: str, requested: str) -> Turn:
        turn = self.parse(harness)
        self.assertTrue(adapters.served_matches(requested, turn.model), turn.model)
        self.assertEqual(turn.text.strip(), "DONE")
        self.assertIsNone(turn.error)
        self.assertTrue(turn.tools)
        self.assertTrue({"tool_call", "tool_result", "assistant"} <= {e["role"] for e in turn.transcript})
        return turn

    def assert_tokens(self, turn: Turn):
        self.assertGreater(turn.usage["input"] + turn.usage["cacheRead"] + turn.usage["cacheWrite"], 0)
        self.assertGreater(turn.usage["output"], 0)
        self.assertGreater(turn.usage["cost_usd"], 0)

    def test_omp(self):
        self.assert_tokens(self.check("omp", "amazon-bedrock/global.anthropic.claude-haiku-5-5"))

    def test_claude(self):
        self.assert_tokens(self.check("claude", "global.anthropic.claude-haiku-5-5"))

    def test_kiro(self):
        turn = self.check("kiro", "claude-haiku-5.5")
        self.assertGreater(turn.usage["credits"], 0)  # Kiro reports credits, not tokens

    def test_opencode_shape_untested(self):
        """No recorded stream (OpenCode not installed): exercise the documented event shapes."""
        lines = [
            json.dumps({"type": "step_start", "sessionID": "s", "part": {"type": "step-start"}}),
            json.dumps({"type": "tool_use", "sessionID": "s", "part": {"type": "tool", "tool": "write",
                        "state": {"status": "completed", "input": {"filePath": "hello.txt"}, "output": "ok"}}}),
            json.dumps({"type": "text", "sessionID": "s", "part": {"type": "text", "text": "DONE"}}),
            json.dumps({"type": "step_finish", "sessionID": "s", "part": {"type": "step-finish", "reason": "stop", "cost": 0.01,
                        "tokens": {"input": 10, "output": 5, "reasoning": 2, "cache": {"read": 3, "write": 0}}}}),
        ]
        turn = adapters.build("opencode", {}).parse(lines)
        self.assertEqual((turn.text, turn.usage["output"], turn.usage["cacheRead"]), ("DONE", 7, 3))
        self.assertIsNone(turn.model)  # the documented stream carries no model id: runner files model_unverified


if __name__ == "__main__":
    unittest.main()
