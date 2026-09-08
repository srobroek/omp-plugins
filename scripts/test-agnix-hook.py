#!/usr/bin/env python3
"""Exercise the staged agnix checker through its real Git index inputs."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import shlex
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def clean_env(root: Path, overrides: dict[str, str] | None = None) -> dict[str, str]:
    merged_env = os.environ.copy()
    for key in list(merged_env):
        if key.startswith(("GIT_", "AGNIX_", "MISE_")):
            del merged_env[key]
    merged_env["GIT_CONFIG_NOSYSTEM"] = "1"
    merged_env["GIT_CONFIG_GLOBAL"] = str(root / "global.gitconfig")
    if overrides:
        merged_env.update(overrides)
    return merged_env


def git(root: Path, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=root,
        env=clean_env(root, env),
        capture_output=True,
        text=True,
        check=True,
    )


def checker(root: Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(root / "scripts" / "check-agnix-staged.sh")],
        cwd=root,
        env=clean_env(root, env),
        capture_output=True,
        text=True,
    )


def installer(root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(root / "scripts" / "install-agnix-hooks.sh")],
        cwd=root,
        env=clean_env(root),
        capture_output=True,
        text=True,
    )


def assert_accepted(label: str, result: subprocess.CompletedProcess[str]) -> None:
    if result.returncode != 0:
        raise AssertionError(f"{label} unexpectedly failed\n{result.stdout}\n{result.stderr}")


def assert_rejected(label: str, result: subprocess.CompletedProcess[str]) -> None:
    if result.returncode == 0:
        raise AssertionError(f"{label} unexpectedly passed\n{result.stdout}\n{result.stderr}")


def hook_dispatch_smoke() -> None:
    with tempfile.TemporaryDirectory(prefix="agnix-dispatch-test-") as temporary:
        root = Path(temporary)
        (root / "global.gitconfig").touch()
        git(root, "init", "--quiet")
        git(root, "config", "user.name", "agnix hook test")
        git(root, "config", "user.email", "agnix-hook-test@example.invalid")
        (root / "scripts").mkdir()
        (root / ".githooks").mkdir()
        shutil.copy2(REPO / ".agnix.toml", root / ".agnix.toml")
        for name in ("check-agnix-staged.sh", "install-agnix-hooks.sh"):
            shutil.copy2(REPO / "scripts" / name, root / "scripts" / name)
            (root / "scripts" / name).chmod(0o755)
        shutil.copy2(REPO / ".githooks" / "pre-commit", root / ".githooks" / "pre-commit")
        (root / ".githooks" / "pre-commit").chmod(0o755)
        git(root, "add", "--all", "--")
        git(root, "commit", "--quiet", "-m", "base")

        previous = root / "previous-hooks"
        previous.mkdir()
        commit_msg_marker = root / "commit-msg-marker"
        pre_push_marker = root / "pre-push-marker"
        commit_msg = previous / "commit-msg"
        commit_msg.write_text(
            f"#!/usr/bin/env bash\nprintf commit-msg > {shlex.quote(str(commit_msg_marker))}\n",
            encoding="utf-8",
        )
        commit_msg.chmod(0o755)
        pre_push = previous / "pre-push"
        pre_push.write_text(
            f"#!/usr/bin/env bash\nprintf pre-push > {shlex.quote(str(pre_push_marker))}\n",
            encoding="utf-8",
        )
        pre_push.chmod(0o755)
        git(root, "config", "extensions.worktreeConfig", "true")
        git(root, "config", "--worktree", "core.hooksPath", "previous-hooks")
        assert_accepted("first hook install", installer(root))
        assert_accepted("repeat hook install", installer(root))

        (root / "notes").write_text("hook dispatch\n", encoding="utf-8")
        git(root, "add", "notes")
        git(root, "commit", "--quiet", "-m", "dispatch")
        if commit_msg_marker.read_text(encoding="utf-8") != "commit-msg":
            raise AssertionError("existing commit-msg hook did not run")

        remote = root / "remote.git"
        remote.mkdir()
        git(remote, "init", "--bare", "--quiet")
        git(root, "remote", "add", "origin", str(remote))
        git(root, "push", "--quiet", "--set-upstream", "origin", "HEAD")
        if pre_push_marker.read_text(encoding="utf-8") != "pre-push":
            raise AssertionError("existing pre-push hook did not run")


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="agnix-hook-test-") as temporary:
        root = Path(temporary)
        git(root, "init", "--quiet")
        git(root, "config", "user.name", "agnix hook test")
        git(root, "config", "user.email", "agnix-hook-test@example.invalid")
        (root / "scripts").mkdir()
        shutil.copy2(REPO / ".agnix.toml", root / ".agnix.toml")
        shutil.copy2(REPO / "scripts" / "check-agnix-staged.sh", root / "scripts" / "check-agnix-staged.sh")
        (root / "scripts" / "check-agnix-staged.sh").chmod(0o755)
        git(root, "add", ".agnix.toml")
        git(root, "commit", "--quiet", "-m", "base")
        (root / "skills" / "valid").mkdir(parents=True)
        (root / "skills" / "valid" / "SKILL.md").write_text(
            "---\nname: valid\ndescription: Check a valid skill\n---\nBody\n", encoding="utf-8"
        )
        git(root, "add", "--all", "--")
        assert_accepted("valid staged instruction", checker(root))
        git(root, "commit", "--quiet", "-m", "valid fixture")
        base = git(root, "rev-parse", "HEAD").stdout.strip()

        malformed = root / "skills" / "bad\nname" / "SKILL.md"
        malformed.parent.mkdir(parents=True)
        malformed.write_text(
            "---\nname: [broken\ndescription: This frontmatter is invalid\n---\nBody\n",
            encoding="utf-8",
        )
        git(root, "add", "--all", "--")
        assert_rejected("malformed staged instruction", checker(root))
        git(root, "commit", "--quiet", "-m", "malformed fixture")

        index = root / "temporary-index"
        environment = {"GIT_INDEX_FILE": str(index), "AGNIX_DIFF_BASE": base}
        git(root, "read-tree", "HEAD", env=environment)
        assert_rejected("malformed CI instruction", checker(root, env=environment))
    hook_dispatch_smoke()

    print("agnix hook regression cases passed")


if __name__ == "__main__":
    main()
