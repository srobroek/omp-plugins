from __future__ import annotations

import importlib.util
import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).parents[1]
CLI = ROOT / "skills/agentic-scaffold/scripts/scaffold.py"


def module():
    spec = importlib.util.spec_from_file_location("scaffold_bts", CLI)
    assert spec and spec.loader
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


def test_bts_validate_compatibility_rules():
    scaffold = module()
    cases = [
        ({"bts": "true", "bts_frontend": "next,react-router"}, "at most one web frontend"),
        ({"bts": "true", "bts_frontend": "tanstack-router", "bts_backend": "self"}, "full-stack web frontend"),
        ({"bts": "true", "bts_runtime": "workers", "bts_backend": "express"}, "Workers runtime requires"),
        ({"bts": "true", "bts_frontend": "astro", "bts_api": "trpc"}, "tRPC is incompatible"),
        ({"bts": "true", "bts_backend": "convex", "bts_frontend": "solid"}, "Convex is incompatible"),
        ({"bts": "true", "bts_examples": "todo", "bts_database": "none"}, "todo example requires"),
        ({"bts": "true", "bts_web_deploy": "prisma", "bts_frontend": "none"}, "web-deploy prisma"),
        ({"bts": "true", "bts_addons": "tauri", "bts_frontend": "none"}, "Tauri addon requires"),
    ]
    for values, expected in cases:
        assert any(expected in message for message in scaffold.bts_validate(values))
    assert scaffold.bts_validate({"bts": "false", "bts_frontend": "next,astro"}) == []


def test_bts_dry_run_argv_recipes():
    scaffold = module()
    common = {"bts_version": "3.42.2", "bts_package_manager": "bun"}
    app = scaffold._bts_argv({**common, "kind": "app", "bts_frontend": "tanstack-router", "bts_backend": "hono", "bts_runtime": "bun", "bts_api": "trpc", "bts_database": "sqlite", "bts_orm": "drizzle", "bts_auth": "better-auth", "bts_addons": "turborepo"}, "web-app")
    assert app == ["bunx", "create-better-t-stack@3.42.2", "web-app", "--frontend", "tanstack-router", "--backend", "hono", "--runtime", "bun", "--api", "trpc", "--database", "sqlite", "--orm", "drizzle", "--auth", "better-auth", "--payments", "none", "--addons", "turborepo", "--examples", "none", "--db-setup", "none", "--web-deploy", "none", "--server-deploy", "none", "--package-manager", "bun", "--no-git", "--no-install", "--manual-db", "--no-render-title", "--disable-analytics", "--directory-conflict", "error"]
    tauri = scaffold._bts_argv({**common, "profile": "tauri-desktop", "kind": "app", "bts_frontend": "tanstack-router", "bts_backend": "hono", "bts_runtime": "bun", "bts_api": "trpc", "bts_database": "sqlite", "bts_orm": "drizzle", "bts_auth": "better-auth", "bts_addons": "turborepo"}, "desktop-app")
    assert "tauri" in tauri and tauri[tauri.index("--addons") + 1:tauri.index("--examples")] == ["turborepo", "tauri"]
    mono = scaffold._bts_argv({"bts_version": "3.42.2", "layout": "monorepo", "bts_layout": "turborepo"}, "mono")
    assert mono[2:] == ["mono", "--frontend", "none", "--backend", "none", "--database", "none", "--orm", "none", "--runtime", "none", "--api", "none", "--addons", "turborepo", "--package-manager", "pnpm", "--no-git", "--no-install", "--manual-db", "--no-render-title", "--disable-analytics", "--directory-conflict", "error"]
    docs = scaffold._bts_argv({"bts_version": "3.42.2", "bts_docs": "starlight", "bts_package_manager": "pnpm", "kind": "library"}, "starlight")
    assert "--addons" in docs and docs[docs.index("--addons") + 1] == "starlight"


def test_bts_provision_empty_target_record_and_refusal(tmp_path: Path, monkeypatch):
    scaffold = module()
    values = {"bts": "true", "bts_version": "3.42.2", "kind": "app"}
    target = tmp_path / "demo"
    target.mkdir()
    result, code = scaffold._provision_target(target, values, True)
    assert code == 0 and result["argv"][0:3] == ["bunx", "create-better-t-stack@3.42.2", "demo"]
    (target / "existing.txt").write_text("owned")
    result, code = scaffold._provision_target(target, values, True)
    assert code == scaffold.EXIT_CONFLICT and "--set bts=false" in result["error"]

    fake = tmp_path / "bin"
    fake.mkdir()
    bunx = fake / "bunx"
    bunx.write_text("#!/bin/sh\nmkdir -p \"$2\"\nprintf generated > \"$2/generated.txt\"\n")
    bunx.chmod(0o755)
    target2 = tmp_path / "execute"
    (target2 / ".git").mkdir(parents=True)
    (target2 / ".omp").mkdir()
    (target2 / ".omp" / "scaffold-answers.toml").write_text("profile = 'ts-app'\n")
    monkeypatch.setenv("PATH", f"{fake}{os.pathsep}{os.environ.get('PATH', '')}")
    result, code = scaffold._provision_target(target2, values, False)
    assert code == 0 and (target2 / "generated.txt").read_text() == "generated"
    assert (target2 / ".omp" / "scaffold-answers.toml").is_file() and (target2 / ".git").is_dir()
    assert result["generated"] == ["generated.txt"]
    result, code = scaffold._provision_target(target2, values, False)
    assert code == 0 and result["skipped"] is True


def test_bts_conditional_files_and_ci_lane():
    scaffold = module()
    direct, _ = scaffold.collect(["lang/ts"], {"name": "demo", "kind": "app", "bts": "true", "bts_biome": "true", "language": "ts", "node": "22", "bun_version": "latest"})
    assert not {"package.json", "tsconfig.json", "biome.json"} & set(direct)
    assert not any(path.startswith("src/") for path in direct)
    _, lane = scaffold._language_lane("ts", {"bts": "true", "bts_package_manager": "pnpm", "bts_addons": "turborepo"})
    assert "pnpm install --frozen-lockfile" in lane
    assert "turbo run check-types build" in lane


def test_bts_refuses_ts_app_members_in_a_monorepo():
    scaffold = module()
    members = [{"name": "web", "layer": "lang/ts", "kind": "app", "dir": "packages/web"}, {"name": "core", "layer": "lang/ts", "kind": "lib", "dir": "packages/core"}]
    violations = scaffold.bts_member_violations({"layout": "monorepo", "bts": "true"}, members)
    assert len(violations) == 1 and "web" in violations[0] and "ts-app" in violations[0]
    assert scaffold.bts_member_violations({"layout": "monorepo", "bts": "false"}, members) == []
    assert scaffold.bts_member_violations({"layout": "single", "bts": "true"}, members) == []


def test_bts_questions_wait_for_the_typescript_answer(tmp_path: Path):
    scaffold = module()
    root = tmp_path / "repo"
    root.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    fixed = {"name": "demo", "purpose": "app", "kind": "app", "license": "apache-2.0", "beads": "false", "remote": "no", "visibility": "private", "web_ui": "false", "speckit": "false", "github_owner": "s", "publish": "none", "docs_flavour": "none"}
    def ids(profile: str, answers: dict[str, str]) -> list[str]:
        payload, code = scaffold.interview_verb(root, profile, json.dumps(answers))
        assert code == 0
        return [row["id"] for row in payload["ask"]["questions"]]
    assert not any(item.startswith("bts") for item in ids("monorepo", {**fixed, "language": "none"}))
    assert not any(item.startswith("bts") for item in ids("ts-app", {**fixed}))  # language not answered yet
    assert ids("ts-app", {**fixed, "language": "ts"}) == ["bts"]
    assert not any(item.startswith("bts") for item in ids("ts-app", {**fixed, "language": "ts", "bts": "false"}))
    assert ids("ts-app", {**fixed, "language": "ts", "bts": "true"})[:3] == ["bts_frontend", "bts_backend", "bts_runtime"]
    assert ids("monorepo", {**fixed, "language": "ts"}) == ["bts_layout", "bts_package_manager"]


def test_bts_questions_follow_the_layers_answer_in_a_brownfield_repository(tmp_path: Path):
    scaffold = module()
    root = tmp_path / "dotfiles"
    root.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    (root / "README.md").write_text("# dotfiles\n")
    def ids(answers: dict[str, str]) -> list[str]:
        payload, code = scaffold.interview_verb(root, "agentic-repo", json.dumps(answers))
        assert code == 0
        return [row["id"] for row in payload["ask"]["questions"]]
    assert ids({}) == ["profile", "layers"]
    assert not any(item.startswith("bts") for item in ids({"profile": "agentic-repo", "layers": "base,agentic,hooks,tooling", "github_owner": "s"}))
    with_ts = {"profile": "agentic-repo", "layers": "base,agentic,lang/ts", "github_owner": "s"}
    assert ids(with_ts) == ["bts"]
    assert ids({**with_ts, "bts": "false"}) == []
    assert ids({**with_ts, "bts": "true"})[:2] == ["bts_frontend", "bts_backend"]


def test_bts_layout_never_sorts_before_the_fixed_questions():
    scaffold = module()
    rows = [{"id": "bts_layout", "source": "better-t-stack"}, {"id": "bts", "source": "better-t-stack"}, {"id": "license", "source": "fixed"}, {"id": "language", "source": "fixed"}]
    assert [row["id"] for row in scaffold._ordered_questions(rows)] == ["language", "license", "bts_layout", "bts"]
