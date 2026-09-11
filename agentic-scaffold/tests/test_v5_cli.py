from __future__ import annotations

import json
import os
import pytest
import subprocess
import sys
from pathlib import Path

from conftest import git_root

ROOT = Path(__file__).parents[1]
CLI = ROOT / "skills/agentic-scaffold/scripts/scaffold.py"


def run(*args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    argv = list(args)
    if "--root" in argv:
        i = argv.index("--root")
        argv[i + 1] = str(git_root(Path(argv[i + 1])))
    return subprocess.run([sys.executable, str(CLI), *argv], text=True, capture_output=True, env=env, check=False)


def payload(result: subprocess.CompletedProcess[str]) -> dict:
    return json.loads(result.stdout)


def answer(root: Path) -> None:
    result = run("answers", "write", "--root", str(root), "--profile", "python-app", "--set", "name=demo", "--set", "purpose=test", "--set", "language=python", "--defaults-for", "kind,license,beads")
    assert result.returncode == 0, result.stderr


def test_root_boundary_and_root_echo(tmp_path: Path) -> None:
    result = run("profiles", "--root", str(tmp_path), "list")
    assert result.returncode == 0
    assert payload(result)["root"] == str(tmp_path.resolve())
    result = subprocess.run([sys.executable, str(CLI), "render", "--root", str(Path.home())], text=True, capture_output=True, check=False)
    assert result.returncode == 6


def test_interview_and_answers_refusal_and_defaults_audit(tmp_path: Path) -> None:
    root = git_root(tmp_path)
    questions = payload(run("interview", "questions", "--root", str(root), "--profile", "python-app"))
    assert {row["id"] for row in questions["questions"]} >= {"name", "purpose", "kind", "language", "license", "beads"}
    refused = run("answers", "write", "--root", str(root), "--profile", "python-app", "--set", "name=demo")
    assert refused.returncode == 3
    answer(root)
    text = (root / ".omp/scaffold-answers.toml").read_text()
    assert "defaults_for" in text and "interviewed_at" in text
    assert (root / ".omp/scaffold-run.json").is_file()


def test_apply_dry_run_does_not_write_and_reports_order(tmp_path: Path) -> None:
    root = git_root(tmp_path)
    answer(root)
    before = sorted(str(path.relative_to(root)) for path in root.rglob("*") if path.is_file())
    result = run("apply", "--root", str(root), "--dry-run")
    after = sorted(str(path.relative_to(root)) for path in root.rglob("*") if path.is_file())
    assert before == after
    names = [row["name"] for row in payload(result)["stages"]]
    assert names == ["preflight", "plan"]


def test_mise_pins_are_stable_across_update(tmp_path: Path) -> None:
    root = git_root(tmp_path)
    first = run("render", "--root", str(root), "--profile", "python-app", "--name", "demo")
    assert first.returncode == 0, first.stderr
    initial = (root / "mise.toml").read_text()
    second = run("update", "--root", str(root))
    assert second.returncode == 0, second.stderr
    assert (root / "mise.toml").read_text() == initial


def test_hook_filtering_and_recursion_validator(tmp_path: Path) -> None:
    root = git_root(tmp_path)
    rendered = run("render", "--root", str(root), "--profile", "agentic-repo", "--name", "demo")
    assert rendered.returncode == 0, rendered.stderr
    config = root / ".pre-commit-config.yaml"
    config.write_text(config.read_text() + "\nstages: [manual]\n")
    result = run("hooks", "install", "--root", str(root))
    if result.returncode == 0:
        assert "manual" in payload(result).get("ignored", [])
    assert "just check" in (root / "justfile").read_text()


def test_doctor_and_finish_blockers(tmp_path: Path) -> None:
    root = git_root(tmp_path)
    rendered = run("render", "--root", str(root), "--profile", "agentic-repo", "--name", "demo")
    assert rendered.returncode == 0
    doctor = run("doctor", "--root", str(root))
    assert doctor.returncode == 2
    assert any("hooks" in item for item in payload(doctor)["drift"])
    finish = run("finish", "--root", str(root))
    assert finish.returncode == 2
    assert payload(finish)["blockers"]
    assert payload(finish)["state"] == "blocked"  # doctor drift is more than uncommitted output


def test_finish_reports_ready_for_commit_when_only_output_is_uncommitted(tmp_path: Path, monkeypatch) -> None:
    import importlib

    sys.path.insert(0, str(CLI.parent))
    scaffold = importlib.import_module("scaffold")
    root = git_root(tmp_path)
    (root / "x.txt").write_text("x\n")
    monkeypatch.setattr(scaffold, "doctor", lambda r: ({"drift": []}, 0))
    (root / ".omp").mkdir(exist_ok=True)
    (root / ".omp/scaffold.json").write_text('{"owned_hashes": {"x.txt": "0"}, "layers": []}')
    (root / ".omp/scaffold-run.json").write_text("{}")
    result, code = scaffold.finish(root)
    assert code == 2 and result["state"] == "ready-for-commit" and result["commitCommand"].startswith("git add")
    assert (root / ".omp/scaffold-run.json").exists()


def test_mise_block_rerender_keeps_provider_keys(tmp_path: Path) -> None:
    import importlib

    sys.path.insert(0, str(CLI.parent))
    scaffold = importlib.import_module("scaffold")
    target = Path("mise.toml")
    first = scaffold.merge_tools_block("", '[tools]\nprek = "1"\n', "tooling", target)
    second = scaffold.merge_tools_block(first, '[tools]\n"pipx:graphifyy[mcp]" = "0.9"\n"npm:repomix" = "1.1"\n', "agentic", target)
    assert '"pipx:graphifyy[mcp]" = "0.9"' in second and '"npm:repomix" = "1.1"' in second
    third = scaffold.merge_tools_block(second, '[tools]\n"pipx:graphifyy[mcp]" = "0.9"\n"npm:repomix" = "1.1"\nnode = "26"\n', "agentic", target)
    assert '"pipx:graphifyy[mcp]" = "0.9"' in third and '"npm:repomix" = "1.1"' in third and 'node = "26"' in third
    import tomllib

    assert set(tomllib.loads(third)["tools"]) == {"prek", "pipx:graphifyy[mcp]", "npm:repomix", "node"}


def test_python_tag_normalizes_versions(tmp_path: Path) -> None:
    import importlib

    sys.path.insert(0, str(CLI.parent))
    scaffold = importlib.import_module("scaffold")
    root = git_root(tmp_path) if "git_root" in globals() else tmp_path
    for given, expected in (("3.13", "py313"), ("3.13.2", "py313"), ("py312", "py312"), ("3.9", "py39")):
        _, _, _, values = scaffold.resolve_selection(root, "python-app", "demo", {"python": given}, [])
        assert values["python_tag"] == expected, (given, values["python_tag"])


def test_tool_command_maps_provider_keys() -> None:
    import importlib

    sys.path.insert(0, str(CLI.parent))
    scaffold = importlib.import_module("scaffold")
    assert scaffold._tool_command("aqua:gastownhall/beads") == "bd"
    assert scaffold._tool_command("ubi:steveyegge/beads") == "bd"
    assert scaffold._tool_command("pipx:graphifyy[mcp]") == "graphify"
    assert scaffold._tool_command("npm:repomix") == "repomix"
    assert scaffold._tool_command("python") == "python3"


def test_update_refreshes_untouched_owned_files_and_keeps_edited_ones(tmp_path: Path) -> None:
    root = git_root(tmp_path)
    assert run("answers", "write", "--root", str(root), "--profile", "python-lib", "--set", "name=demo", "--set", "purpose=p", "--set", "kind=lib", "--set", "language=python", "--set", "license=apache-2.0", "--set", "beads=false").returncode == 0
    assert run("render", "--root", str(root), "--profile", "python-lib").returncode == 0
    readme = root / "README.md"
    original = readme.read_text()
    (root / ".editorconfig").write_text("# user edit\n")
    # simulate a template change: mutate the recorded render so the current file no longer equals template output
    readme.write_text(original + "\n")
    import json as _json
    meta_path = root / ".omp/scaffold.json"
    meta = _json.loads(meta_path.read_text())
    import hashlib
    meta["owned_hashes"]["README.md"] = hashlib.sha256(readme.read_bytes()).hexdigest()
    meta_path.write_text(_json.dumps(meta))
    result = run("update", "--root", str(root))
    assert result.returncode == 0, result.stderr
    payload = _json.loads(result.stdout)
    assert readme.read_text() == original, "untouched owned file is re-rendered from the template"
    assert (root / ".editorconfig").read_text() == "# user edit\n"
    assert ".editorconfig" in payload["drifted"]


def test_render_preserves_hook_metadata(tmp_path: Path) -> None:
    root = git_root(tmp_path)
    assert run("answers", "write", "--root", str(root), "--profile", "agentic-repo", "--set", "name=demo").returncode in (0, 3)
    assert run("answers", "write", "--root", str(root), "--profile", "agentic-repo", "--set", "name=demo", "--defaults-for", "purpose,kind,language,license,beads").returncode == 0
    assert run("render", "--root", str(root), "--profile", "agentic-repo").returncode == 0
    import json as _json
    meta_path = root / ".omp/scaffold.json"
    meta = _json.loads(meta_path.read_text())
    meta.update({"hooks_installed": True, "hook_strategy": "git-defender", "hook_stages": ["pre-commit", "pre-push"]})
    meta_path.write_text(_json.dumps(meta))
    assert run("render", "--root", str(root), "--profile", "agentic-repo").returncode == 0
    after = _json.loads(meta_path.read_text())
    assert after["hook_strategy"] == "git-defender" and after["hooks_installed"] is True and after["hook_stages"] == ["pre-commit", "pre-push"]


def test_beads_pin_follows_the_beads_answer(tmp_path: Path) -> None:
    import importlib

    sys.path.insert(0, str(CLI.parent))
    scaffold = importlib.import_module("scaffold")
    layers = ["base", "tooling", "hooks", "agentic"]
    without = scaffold.layer_tools(layers, {"beads": "false"})
    with_beads = scaffold.layer_tools(layers, {"beads": "true"})
    assert "aqua:gastownhall/beads" not in without
    assert with_beads["aqua:gastownhall/beads"] == "latest"
    root = git_root(tmp_path)
    assert run("answers", "write", "--root", str(root), "--profile", "agentic-repo", "--set", "name=demo", "--defaults-for", "purpose,kind,language,license,beads").returncode == 0
    assert run("render", "--root", str(root), "--profile", "agentic-repo").returncode == 0
    assert "beads" not in (root / "mise.toml").read_text()


def test_finding_answers_serialize_as_valid_toml(tmp_path: Path) -> None:
    root = git_root(tmp_path)
    result = run("answers", "write", "--root", str(root), "--profile", "agentic-repo", "--set", "name=demo", "--set", "finding:hook-manager=git-defender", "--defaults-for", "purpose,kind,language,license,beads")
    assert result.returncode == 0, result.stderr
    import tomllib

    data = tomllib.loads((root / ".omp/scaffold-answers.toml").read_text())
    assert data["vars"]["finding:hook-manager"] == "git-defender"
    assert run("plan", "--root", str(root), "--profile", "agentic-repo").returncode == 0


def test_hook_manager_question_is_skipped_when_git_defender_decides(tmp_path: Path, monkeypatch) -> None:
    import importlib

    sys.path.insert(0, str(CLI.parent))
    scaffold = importlib.import_module("scaffold")
    root = git_root(tmp_path)
    (root / "README.md").write_text("existing project\n")  # brownfield: the interview emits findings only for existing repos
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    (fake_bin / "git-defender").write_text("#!/bin/sh\nexit 0\n")
    (fake_bin / "git-defender").chmod(0o755)
    gitconfig = tmp_path / "gitconfig"
    gitconfig.write_text("[core]\n\thooksPath = /opt/defender/hooks\n")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(gitconfig))
    monkeypatch.setenv("PATH", f"{fake_bin}:/usr/bin:/bin")  # hermetic: the host's real git-defender must not leak in
    with_defender = scaffold.interview_questions(root, "agentic-repo")
    assert not any(q["id"] == "finding:hook-manager" for q in with_defender["questions"])
    (fake_bin / "git-defender").unlink()
    without = scaffold.interview_questions(root, "agentic-repo")
    assert any(q["id"] == "finding:hook-manager" and q.get("allowed") and "skip hooks" in q["allowed"] for q in without["questions"])


def test_abort_lifts_the_boundary_and_reports_owned_dirt(tmp_path: Path) -> None:
    root = git_root(tmp_path)
    (root / ".omp").mkdir(exist_ok=True)
    (root / ".omp/scaffold.json").write_text('{"owned_hashes": {"mise.toml": "0"}, "layers": []}')
    (root / ".omp/scaffold-run.json").write_text('{"stages": [{"name": "preflight", "status": "ok"}, {"name": "render", "status": "failed"}]}')
    (root / "mise.toml").write_text("[tools]\n")
    (root / "notes.txt").write_text("mine\n")
    result = run("abort", "--root", str(root))
    assert result.returncode == 0
    body = payload(result)
    assert body["hadRun"] and body["stagesCompleted"] == ["preflight", "render"]
    assert body["dirtyOwned"] == ["mise.toml"] and "notes.txt" in body["dirtyOther"]
    assert body["revertCommands"] == ["rm -rf mise.toml"]  # untracked owned file; user files never appear
    assert not (root / ".omp/scaffold-run.json").exists()
    again = payload(run("abort", "--root", str(root)))
    assert again["hadRun"] is False


def test_abort_treats_a_malformed_marker_as_a_run(tmp_path: Path) -> None:
    root = git_root(tmp_path)
    (root / ".omp").mkdir(exist_ok=True)
    (root / ".omp/scaffold-run.json").write_text("not json")
    body = payload(run("abort", "--root", str(root)))
    assert body["hadRun"] is True and body["stagesCompleted"] == []
    assert not (root / ".omp/scaffold-run.json").exists()


def test_guarded_write_leaves_no_temp_file_and_replaces_atomically(tmp_path: Path) -> None:
    import importlib

    sys.path.insert(0, str(CLI.parent))
    scaffold = importlib.import_module("scaffold")
    root = git_root(tmp_path)
    target = root / ".omp/scaffold-run.json"
    scaffold._write_under_root(root, target, "{}\n")
    scaffold._write_under_root(root, target, '{"stages": []}\n')
    assert target.read_text() == '{"stages": []}\n'
    assert [p.name for p in target.parent.iterdir()] == ["scaffold-run.json"]


def test_brownfield_layers_question_is_a_catalogue_multiselect_and_its_answer_selects_layers(tmp_path: Path) -> None:
    import importlib

    sys.path.insert(0, str(CLI.parent))
    scaffold = importlib.import_module("scaffold")
    root = git_root(tmp_path)
    (root / "README.md").write_text("# existing\n")
    q = next(row for row in scaffold.interview_questions(root, "agentic-repo")["questions"] if row["id"] == "layers")
    assert q["multi"] is True and "base" in q["default"].split(",") and "lang/python" in q["allowed"]
    assert any(c["value"] == "hooks" and c["summary"] for c in q["choices"])
    result = run("answers", "write", "--root", str(root), "--profile", "agentic-repo", "--set", "layers=base,agentic,tooling", "--set", "name=demo")
    assert result.returncode == 0, result.stdout + result.stderr
    assert payload(result)["layers"] == ["base", "agentic", "tooling"]
    assert "layers" not in payload(result)["vars"]
    bad = run("answers", "write", "--root", str(root), "--profile", "agentic-repo", "--set", "layers=base,nope", "--set", "name=demo")
    assert bad.returncode == 5


def test_dry_run_returns_a_compact_plan_summary(tmp_path: Path) -> None:
    root = git_root(tmp_path)
    (root / ".gitignore").write_text("node_modules\n")
    subprocess.run(["git", "add", "-A"], cwd=root, check=True, capture_output=True)
    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], cwd=root, check=True, capture_output=True)
    assert run("answers", "write", "--root", str(root), "--profile", "agentic-repo", "--set", "layers=base,agentic", "--set", "name=demo").returncode == 0
    result = run("apply", "--root", str(root), "--dry-run")
    body = payload(result)
    summary = body["planSummary"]
    assert summary["layers"] == ["base", "agentic"] and summary["counts"] and summary["lines"]
    assert all(line.split()[0] in {"create", "update-block", "skip", "conflict"} for line in summary["lines"])
    assert summary["preflight"]["ok"] in (True, False)


def test_bd_environment_does_not_choose_a_database(tmp_path: Path, monkeypatch) -> None:
    import importlib

    sys.path.insert(0, str(CLI.parent))
    scaffold = importlib.import_module("scaffold")
    root = git_root(tmp_path)
    (root / ".beads").mkdir()
    monkeypatch.setenv("BEADS_DIR", "/pinned/by/the/session/.beads")
    env = scaffold._bd_environment(root)
    assert env["BEADS_DIR"] == "/pinned/by/the/session/.beads"  # inherited untouched
    assert env["BEADS_ACTOR"].startswith("agentic-scaffold/")
    monkeypatch.delenv("BEADS_DIR")
    assert "BEADS_DIR" not in scaffold._bd_environment(root)  # bd resolves from cwd=root


@pytest.mark.parametrize("profile", sorted(p.stem for p in (ROOT / "profiles").glob("*.toml")))
def test_answers_write_twice_stays_valid_toml_for_every_profile(tmp_path: Path, profile: str) -> None:
    import tomllib

    root = git_root(tmp_path)
    probe = run("answers", "write", "--root", str(root), "--profile", profile, "--set", "name=demo")
    defaults = ",".join(payload(probe).get("missing", [])) if probe.returncode == 3 else ""
    for _ in range(2):  # the second write reads the first file back; meta keys must not be re-emitted
        args = ["answers", "write", "--root", str(root), "--profile", profile, "--set", "name=demo"]
        if defaults:
            args += ["--defaults-for", defaults]
        result = run(*args)
        assert result.returncode == 0, result.stdout + result.stderr
    text = (root / ".omp/scaffold-answers.toml").read_text()
    data = tomllib.loads(text)  # raises on a duplicate key
    assert data["profile"] == profile and "interviewed_at" in data
    assert "defaults_for" not in data["vars"] and "interviewed_at" not in data["vars"]
    assert text.index("interviewed_at") < text.index("[vars]")


def test_preflight_hard_fails_on_a_dirty_tree_with_no_bypass(tmp_path: Path) -> None:
    root = git_root(tmp_path)
    (root / "README.md").write_text("# demo\n")
    subprocess.run(["git", "add", "-A"], cwd=root, check=True, capture_output=True)
    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], cwd=root, check=True, capture_output=True)
    clean = run("preflight", "--root", str(root), "--profile", "agentic-repo")
    assert clean.returncode == 0, clean.stdout
    (root / "notes.txt").write_text("uncommitted\n")
    dirty = run("preflight", "--root", str(root), "--profile", "agentic-repo")
    assert dirty.returncode != 0
    assert any("work tree is dirty" in line for line in payload(dirty)["hard"])
    assert run("preflight", "--root", str(root), "--profile", "agentic-repo", "--allow-dirty").returncode == 2  # unknown flag: argparse
    (root / ".omp").mkdir(exist_ok=True)
    (root / ".omp/scaffold-answers.toml").write_text('profile = "agentic-repo"\nlayers = []\n[vars]\n')
    (root / "notes.txt").unlink()
    assert run("preflight", "--root", str(root), "--profile", "agentic-repo").returncode == 0  # scaffold state is not dirt


@pytest.mark.parametrize(("profile", "extra", "lane", "release"), [
    ("python-lib", {}, "python", {"release-please.yml", "release.yml"}),
    ("rust-lib", {"kind": "crate"}, "rust", {"release-plz.yml"}),
    ("rust-app", {"kind": "tool"}, "rust", {"release-please.yml", "release.yml"}),
    ("ts-lib", {}, "typescript", {"release-please.yml", "release.yml"}),
    ("go-lib", {}, "go", {"release-please.yml", "release.yml"}),
    ("python-app", {}, "python", {"release-please.yml", "release.yml"}),
])
def test_rendered_workflows_follow_the_ci_and_release_standard(tmp_path: Path, profile: str, extra: dict[str, str], lane: str, release: set[str]) -> None:
    import yaml

    root = git_root(tmp_path)
    sets = ["--set", "name=demo"] + [arg for k, v in extra.items() for arg in ("--set", f"{k}={v}")]
    defaults = "purpose,kind,language,license,beads,publish,docs_flavour,github_owner,conduct_contact"
    assert run("answers", "write", "--root", str(root), "--profile", profile, *sets, "--defaults-for", defaults).returncode == 0
    assert run("apply", "--root", str(root), "--stage", "render").returncode == 0
    workflows = {p.name for p in (root / ".github/workflows").glob("*.yml")}
    assert workflows == {"ci.yml", *release}, workflows
    ci = yaml.safe_load((root / ".github/workflows/ci.yml").read_text())
    jobs = ci["jobs"]
    assert ci["permissions"] == {} and "merge_group" in ci[True]
    gated = {lane, "hooks", "agentic"}
    assert gated | {"changes", "security", "gate"} == set(jobs)
    for name in gated:
        assert jobs[name]["needs"] == "changes"
        assert jobs[name]["if"] == f"needs.changes.outputs.{name} == 'true'"
        assert name in jobs["changes"]["outputs"]
        assert jobs[name]["steps"][1]["uses"].startswith("jdx/mise-action@"), "mise is the version authority"
    assert "if" not in jobs["security"], "security always runs"
    gate = jobs["gate"]
    assert gate["if"] == "always()" and set(gate["needs"]) == {"changes", *gated, "security"}
    filters = jobs["changes"]["steps"][1]["with"]["filters"]
    assert ".github/**" in filters and "mise.toml" in filters, "global paths force every lane"
    for name, job in jobs.items():
        assert "timeout-minutes" in job, name
        for step in job.get("steps", []):
            uses = step.get("uses")
            if uses:
                assert "dtolnay/rust-toolchain" not in uses
                assert len(uses.split("@", 1)[1].split(" ")[0]) == 40, f"{name}: {uses} is not SHA-pinned"
    if "release.yml" in release:
        rel = yaml.safe_load((root / ".github/workflows/release.yml").read_text())
        assert "release-gate" in rel["jobs"] and "check-runs?check_name=gate" in yaml.dump(rel["jobs"]["release-gate"])
        rp = (root / ".github/workflows/release-please.yml").read_text()
        assert "RELEASE_APP_CLIENT_ID" in rp and "RELEASE_APP_PRIVATE_KEY" in rp
    else:
        assert (root / "release-plz.toml").exists() and not (root / "release-please-config.json").exists()


def _gate_script(root: Path) -> str:
    import yaml

    ci = yaml.safe_load((root / ".github/workflows/ci.yml").read_text())
    run_block = ci["jobs"]["gate"]["steps"][0]["run"]
    body = run_block.split("<<'PY'", 1)[1].rsplit("PY", 1)[0]
    return "\n".join(line[10:] if line.startswith(" " * 10) else line for line in body.splitlines())


@pytest.mark.parametrize(("needs", "ok"), [
    ({"changes": {"result": "success", "outputs": {"python": "true"}}, "python": {"result": "success"}, "security": {"result": "success"}}, True),
    ({"changes": {"result": "success", "outputs": {"python": "false"}}, "python": {"result": "skipped"}, "security": {"result": "success"}}, True),
    ({"changes": {"result": "success", "outputs": {"python": "true"}}, "python": {"result": "skipped"}, "security": {"result": "success"}}, False),
    ({"changes": {"result": "success", "outputs": {"python": "true"}}, "python": {"result": "failure"}, "security": {"result": "success"}}, False),
    ({"changes": {"result": "failure", "outputs": {}}, "python": {"result": "skipped"}, "security": {"result": "success"}}, False),
    ({"changes": {"result": "success", "outputs": {"python": "false"}}, "python": {"result": "skipped"}, "security": {"result": "skipped"}}, False),
    ({"changes": {"result": "success", "outputs": {"python": "true"}}, "python": {"result": "cancelled"}, "security": {"result": "success"}}, False),
])
def test_gate_script_is_fail_closed(tmp_path: Path, needs: dict, ok: bool) -> None:
    """The rendered gate accepts a skipped lane only when the detector said its inputs did not change."""
    import json
    import os

    root = git_root(tmp_path)
    assert run("answers", "write", "--root", str(root), "--profile", "python-lib", "--set", "name=demo", "--defaults-for", "purpose,kind,language,license,beads,publish,docs_flavour,github_owner,conduct_contact").returncode == 0
    assert run("apply", "--root", str(root), "--stage", "render").returncode == 0
    result = subprocess.run([sys.executable, "-"], input=_gate_script(root), text=True, capture_output=True, env={**os.environ, "NEEDS": json.dumps(needs)})
    assert (result.returncode == 0) == ok, result.stdout + result.stderr


def test_monorepo_ci_derives_lanes_and_path_filters_from_members(tmp_path: Path) -> None:
    import yaml

    root = git_root(tmp_path)
    defaults = "purpose,kind,language,license,beads,publish,docs_flavour,github_owner,conduct_contact"
    assert run("answers", "write", "--root", str(root), "--profile", "monorepo", "--set", "name=demo", "--defaults-for", defaults).returncode == 0
    for name, layer, kind in (("api", "lang/python", "tool"), ("core", "lang/rust", "crate"), ("web", "lang/ts", "app")):
        assert run("member", "add", "--root", str(root), "--name", name, "--layer", layer, "--kind", kind).returncode == 0
    assert run("apply", "--root", str(root), "--stage", "render").returncode == 0
    ci = yaml.safe_load((root / ".github/workflows/ci.yml").read_text())
    jobs = ci["jobs"]
    assert {"python", "rust", "typescript"} <= set(jobs), "one lane per member language"
    filters = yaml.safe_load(jobs["changes"]["steps"][1]["with"]["filters"])
    assert "packages/api/**" in filters["python"] and "crates/core/**" in filters["rust"] and "packages/web/**" in filters["typescript"]
    assert ".github/**" in filters["python"], "global paths still force the lane"
    assert set(jobs["gate"]["needs"]) == {"changes", "python", "rust", "typescript", "hooks", "agentic", "security"}
