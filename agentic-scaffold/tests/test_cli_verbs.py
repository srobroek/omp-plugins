from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from conftest import REPO_ROOT, git_root

CLI = REPO_ROOT / "skills" / "agentic-scaffold" / "scripts" / "scaffold.py"


def run(*args: str) -> subprocess.CompletedProcess[str]:
    argv = list(args)
    if "--root" in argv:
        index = argv.index("--root")
        argv[index + 1] = str(git_root(Path(argv[index + 1])))
    return subprocess.run([sys.executable, str(CLI), *argv], text=True, capture_output=True, check=False)


def payload(result: subprocess.CompletedProcess[str]) -> dict:
    assert result.stdout, result.stderr
    return json.loads(result.stdout)


def test_start_verb_clean_and_dirty_ask_payloads(tmp_path: Path) -> None:
    clean = run("start", "--root", str(tmp_path / "clean"))
    assert clean.returncode == 0, clean.stderr
    clean_payload = payload(clean)
    assert clean_payload["blockers"] == []
    assert [option["label"] for option in clean_payload["ask"]["questions"][0]["options"]] == ["Continue to the interview", "Stop"]
    assert isinstance(clean_payload["findings"]["markdown"], str)
    assert clean_payload["findings"]["rows"]

    dirty_root = tmp_path / "dirty"
    git_root(dirty_root)
    (dirty_root / "notes.txt").write_text("uncommitted\n")
    dirty = run("start", "--root", str(dirty_root))
    assert dirty.returncode != 0
    dirty_payload = payload(dirty)
    assert dirty_payload["blockers"]
    assert [option["label"] for option in dirty_payload["ask"]["questions"][0]["options"]] == ["Stop"]


def _answer_defaults(rows: list[dict]) -> dict[str, object]:
    answers: dict[str, object] = {}
    for row in rows:
        question_id = str(row["id"])
        if row.get("default") not in (None, ""):
            answers[question_id] = row["default"]
        elif row.get("allowed"):
            answers[question_id] = row["allowed"][0]
        elif row.get("required"):
            answers[question_id] = "demo" if question_id == "name" else "test"
    return answers


def test_interview_pages_are_bounded_and_complete_for_profiles(tmp_path: Path) -> None:
    profiles = sorted(path.stem for path in (REPO_ROOT / "profiles").glob("*.toml"))
    for profile in profiles:
        root = tmp_path / profile
        answers: dict[str, object] = {}
        for _ in range(20):
            args = ["interview", "--root", str(root), "--profile", profile]
            if answers:
                args.extend(["--answers-so-far", json.dumps(answers)])
            result = run(*args)
            assert result.returncode == 0, (profile, result.stderr)
            body = payload(result)
            questions = body["ask"]["questions"]
            assert len(questions) <= 5
            assert all(len(question["options"]) <= 5 for question in questions)
            assert all(all("description" in option for option in question["options"]) for question in questions)
            if body["complete"]:
                break
            answers.update(_answer_defaults(body["questions"]))
        else:
            raise AssertionError(f"interview did not complete for {profile}")
        assert body["complete"] is True, profile


def test_plan_verb_writes_plan_and_returns_ask(tmp_path: Path) -> None:
    root = tmp_path / "plan"
    result = run(
        "plan",
        "--root",
        str(root),
        "--answers",
        json.dumps({"profile": "python-lib", "name": "demo", "purpose": "test", "defaults_for": ["kind", "language", "license", "beads"]}),
    )
    assert result.returncode == 0, result.stderr
    body = payload(result)
    plan = root / ".omp" / "scaffold-plan.md"
    assert body["path"] == str(plan)
    assert plan.is_file()
    assert {option["label"] for option in body["ask"]["questions"][0]["options"]} == {"Apply", "Stop"}
    assert "## Files" in plan.read_text()

def test_run_verb_returns_ready_for_commit_with_stage_seconds(tmp_path: Path, monkeypatch) -> None:
    from conftest import load_scaffold

    scaffold = load_scaffold()
    root = git_root(tmp_path)
    state = root / ".omp"
    state.mkdir()
    (state / "scaffold-answers.toml").write_text('profile = "agentic-repo"\nlayers = []\n[vars]\n')
    monkeypatch.setattr(scaffold, "apply_pipeline", lambda *_args, **_kwargs: ({"ok": True, "stages": [{"name": "render", "status": "ok", "seconds": 0.004}]}, 0))
    monkeypatch.setattr(scaffold, "doctor", lambda _root: ({"ok": True, "drift": [], "errors": []}, 0))
    result, code = scaffold.run_verb(root)
    assert code == 0
    assert result["status"] == "READY_FOR_COMMIT"
    assert result["commitCommand"].startswith("git add")
    assert result["stages"][0]["seconds"] == 0.004


def test_apply_pipeline_stage_rows_include_seconds(tmp_path: Path, monkeypatch) -> None:
    from conftest import load_scaffold

    scaffold = load_scaffold()
    root = git_root(tmp_path)
    state = root / ".omp"
    state.mkdir()
    (state / "scaffold-answers.toml").write_text('profile = "agentic-repo"\nlayers = []\n[vars]\n')
    monkeypatch.setattr(scaffold, "_run_stage", lambda *_args, **_kwargs: ({"ok": True}, 0))
    result, code = scaffold.apply_pipeline(root, "agentic-repo", stage="preflight")
    assert code == 0
    assert result["stages"][0]["name"] == "preflight"
    assert isinstance(result["stages"][0]["seconds"], float)
